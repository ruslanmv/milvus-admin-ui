# src/wxo_incident_data/cli_ingest.py
import os
import sys
import json
import argparse
import mimetypes
import pathlib
import logging
from typing import Dict, Iterable, Tuple, Optional, List, Set

from dotenv import load_dotenv

# Providers
import ibm_boto3
from ibm_botocore.client import Config as CosConfig
from ibm_botocore.exceptions import ClientError as IBMCOSClientError

import boto3
from botocore.client import Config as Boto3Config
from botocore.exceptions import (
    ClientError as AWSS3ClientError,
    NoCredentialsError,
    PartialCredentialsError,
    EndpointConnectionError,
    SSLError as BotoSSLError,
)

from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s | %(levelname)s | %(message)s",
)
log = logging.getLogger("mui.ingest")


# ---------------------------
# Env helpers
# ---------------------------

def _bool_env(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return str(v).lower() in {"1", "true", "yes", "y"}


def load_env() -> bool:
    """Load .env if present. Returns True if .env was found & loaded."""
    return load_dotenv(override=False)


def get_data_root() -> pathlib.Path:
    return pathlib.Path(os.getenv("DATA_SOURCE_ROOT", "./data")).resolve()


def get_provider() -> str:
    return (os.getenv("STORAGE_PROVIDER") or "none").strip().lower()


def manifest_path() -> pathlib.Path:
    return pathlib.Path(os.getenv("MANIFEST_PATH", ".wxo/manifest.json"))


def ensure_dir(p: pathlib.Path):
    p.parent.mkdir(parents=True, exist_ok=True)


def parse_bucket_map() -> Dict[str, str]:
    """
    BUCKET_MAP='{"folderA":"bucket-x","folderB":"bucket-y"}'
    Fallbacks: BUCKET_DEFAULT, COS_BUCKET (legacy).
    """
    raw = os.getenv("BUCKET_MAP", "").strip()
    if not raw:
        return {}
    try:
        m = json.loads(raw)
        if not isinstance(m, dict):
            log.warning("BUCKET_MAP is not a JSON object; ignoring.")
            return {}
        # Normalize all keys/values to strings
        out = {}
        for k, v in m.items():
            if not isinstance(k, str) or not isinstance(v, str):
                log.warning("BUCKET_MAP contains non-string key/value; skipping %r:%r", k, v)
                continue
            out[k.strip()] = v.strip()
        return out
    except Exception as e:
        log.warning("Failed to parse BUCKET_MAP JSON: %s", e)
        return {}


def default_bucket() -> Optional[str]:
    # Prefer BUCKET_DEFAULT; fall back to COS_BUCKET (legacy) if present
    return os.getenv("BUCKET_DEFAULT") or os.getenv("COS_BUCKET")


def collection_name_for(folder: str) -> str:
    # Optional prefix for collections, else use folder name directly
    pref = os.getenv("COLLECTION_PREFIX", "").strip()
    return f"{pref}{folder}" if pref else folder


# ---------------------------
# Storage clients
# ---------------------------

def ibm_cos_resource():
    endpoint = os.getenv("COS_ENDPOINT")
    apikey = os.getenv("COS_API_KEY")
    instance_crn = os.getenv("COS_INSTANCE_CRN")
    if not endpoint or not apikey or not instance_crn:
        raise ValueError("IBM COS selected but COS_ENDPOINT/COS_API_KEY/COS_INSTANCE_CRN not set.")
    return ibm_boto3.resource(
        "s3",
        ibm_api_key_id=apikey,
        ibm_service_instance_id=instance_crn,
        config=CosConfig(signature_version="oauth"),
        endpoint_url=endpoint,
    )


def aws_boto3_resource():
    # Can rely on ambient AWS creds chain; endpoint is optional
    region = os.getenv("AWS_REGION", "us-east-1")
    endpoint = os.getenv("S3_ENDPOINT")  # optional
    return boto3.resource(
        "s3",
        region_name=region,
        endpoint_url=endpoint,
        config=Boto3Config(s3={"addressing_style": "virtual"}),
    )


def generic_s3_resource():
    endpoint = os.getenv("S3_ENDPOINT")
    access_key = os.getenv("S3_ACCESS_KEY")
    secret_key = os.getenv("S3_SECRET_KEY")
    region = os.getenv("S3_REGION", "us-east-1")
    force_path = _bool_env("S3_FORCE_PATH_STYLE", False)
    if not endpoint or not access_key or not secret_key:
        raise ValueError("generic S3 selected but S3_ENDPOINT/S3_ACCESS_KEY/S3_SECRET_KEY not set.")
    return boto3.resource(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name=region,
        config=Boto3Config(signature_version="s3v4", s3={"addressing_style": "path" if force_path else "virtual"}),
    )


def get_s3_raw():
    """
    Return (s3_resource, ClientErrorType, provider) OR raise ValueError
    if provider is unknown / misconfigured.
    """
    provider = get_provider()
    if provider == "ibm":
        return ibm_cos_resource(), IBMCOSClientError, provider
    elif provider == "aws":
        return aws_boto3_resource(), AWSS3ClientError, provider
    elif provider == "generic":
        return generic_s3_resource(), AWSS3ClientError, provider
    elif provider == "none":
        return None, Exception, provider  # no-op mode
    else:
        raise ValueError(f"Unknown STORAGE_PROVIDER='{provider}'. Use ibm | aws | generic | none.")


def get_s3_safe(first_bucket_hint: Optional[str]) -> Tuple[Optional[object], Optional[type], str]:
    """
    Build the S3 client and do a *light* connectivity/credential sanity check.
    If something looks wrong, fall back to provider='none' (no cloud sync).

    Returns: (s3_resource or None, ClientErrorType or None, provider or 'none')
    """
    try:
        s3, ClientErrType, provider = get_s3_raw()
    except ValueError as e:
        log.info("Storage not fully configured (%s). Cloud sync will be skipped.", e)
        return None, None, "none"

    if provider == "none" or s3 is None:
        return None, None, "none"

    # Try a cheap call to detect endpoint & creds
    try:
        # May raise AccessDenied; we accept that as connectivity proof.
        s3.meta.client.list_buckets()
        return s3, ClientErrType, provider
    except (EndpointConnectionError, NoCredentialsError, PartialCredentialsError, BotoSSLError) as e:
        log.warning("Cannot reach S3 endpoint or creds invalid: %s. Cloud sync disabled.", e)
        return None, None, "none"
    except Exception as e:
        # AccessDenied/403 or others — if we have a bucket hint, try a targeted check.
        if first_bucket_hint:
            try:
                s3.meta.client.head_bucket(Bucket=first_bucket_hint)
                return s3, ClientErrType, provider
            except (EndpointConnectionError, NoCredentialsError, PartialCredentialsError, BotoSSLError) as e2:
                log.warning("S3 endpoint or creds invalid for '%s': %s. Cloud sync disabled.",
                            first_bucket_hint, e2)
                return None, None, "none"
            except Exception as e2:
                # Connectivity OK but permission may be missing — allow per-bucket ops to decide.
                log.info("Connectivity ok but no access yet to bucket '%s': %s", first_bucket_hint, e2)
                return s3, ClientErrType, provider
        log.info("S3 connectivity check returned %s; proceeding with per-bucket checks.", e)
        return s3, ClientErrType, provider


# ---------------------------
# Bucket ops
# ---------------------------

@retry(reraise=True, stop=stop_after_attempt(5), wait=wait_exponential(multiplier=0.5, min=1, max=8),
       retry=retry_if_exception_type(Exception))
def head_bucket(s3, bucket: str):
    s3.meta.client.head_bucket(Bucket=bucket)


def ensure_bucket(s3, bucket: str, ClientErrType):
    try:
        head_bucket(s3, bucket)
        log.info("Bucket exists: %s", bucket)
    except ClientErrType as e:
        code = (e.response.get("Error", {}) or {}).get("Code")
        log.warning("head_bucket failed (%s): %s", code, e)
        log.info("Attempting to create bucket: %s", bucket)
        try:
            s3.create_bucket(Bucket=bucket)
            log.info("Bucket created: %s", bucket)
        except ClientErrType as ce:
            log.error("Create bucket failed for %s: %s (skipping this folder)", bucket, ce)
            raise


@retry(reraise=True, stop=stop_after_attempt(5), wait=wait_exponential(multiplier=0.5, min=1, max=8),
       retry=retry_if_exception_type(Exception))
def object_exists_same_size(s3, bucket: str, key: str, size: int) -> bool:
    try:
        meta = s3.meta.client.head_object(Bucket=bucket, Key=key)
        return int(meta.get("ContentLength", -1)) == int(size)
    except Exception:
        return False


@retry(reraise=True, stop=stop_after_attempt(5), wait=wait_exponential(multiplier=0.5, min=1, max=8),
       retry=retry_if_exception_type(Exception))
def upload_file(s3, bucket: str, fp: pathlib.Path, key: str, overwrite: bool = False) -> str:
    ctype, _ = mimetypes.guess_type(fp.name)
    extra = {"ContentType": ctype} if ctype else {}
    size = fp.stat().st_size
    if not overwrite and object_exists_same_size(s3, bucket, key, size):
        return "skipped"
    s3.Object(bucket, key).upload_file(str(fp), ExtraArgs=extra)
    return "uploaded"


def download_prefix(s3, bucket: str, prefix: str, local_root: pathlib.Path) -> Tuple[int, int, int]:
    """Download all objects under prefix/ into local_root/prefix/."""
    ok = skipped = failed = 0
    dest_base = local_root / prefix
    dest_base.mkdir(parents=True, exist_ok=True)
    bucket_obj = s3.Bucket(bucket)
    for obj in bucket_obj.objects.filter(Prefix=f"{prefix}/"):
        rel = pathlib.Path(obj.key)  # e.g., "wiki/file.pdf"
        dest = local_root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            if dest.exists() and dest.stat().st_size == obj.size:
                skipped += 1
                continue
            bucket_obj.download_file(obj.key, str(dest))
            ok += 1
        except Exception as e:
            failed += 1
            log.error("[ERR ] %s: %s", obj.key, e)
    return ok, skipped, failed


def list_bucket_top_level_prefixes(s3, bucket: str, max_objects: int = 1000) -> Set[str]:
    """
    Heuristic: find first-level "folders" (prefix before the first '/').
    """
    prefixes: Set[str] = set()
    try:
        resp = s3.meta.client.list_objects_v2(Bucket=bucket, MaxKeys=max_objects)
        contents = resp.get("Contents", []) or []
        for obj in contents:
            key = obj.get("Key", "")
            if "/" in key:
                first = key.split("/", 1)[0]
                if first:
                    prefixes.add(first)
        return prefixes
    except Exception as e:
        log.info("Could not list objects to infer prefixes for bucket %s: %s", bucket, e)
        return set()


# ---------------------------
# Local FS scan + manifest
# ---------------------------

def discover_local_folders(root: pathlib.Path) -> List[str]:
    if not root.exists():
        return []
    out = []
    for child in sorted(root.iterdir()):
        if child.is_dir() and not child.name.startswith("."):
            # Only include if it has at least one file under it
            has_files = any(p.is_file() for p in child.rglob("*"))
            if has_files:
                out.append(child.name)
    return out


def iter_local_files(root: pathlib.Path, folders: Iterable[str]):
    for folder in folders:
        d = root / folder
        if not d.exists():
            continue
        for fp in d.rglob("*"):
            if fp.is_file():
                key = str(fp.relative_to(root)).replace(os.sep, "/")  # folder/.../file
                yield folder, fp, key


def write_manifest(root: pathlib.Path, folders: Iterable[str], buckets_map: Dict[str, Optional[str]], def_bucket: Optional[str]):
    ensure_dir(manifest_path())
    colls = {}
    for folder in folders:
        if (root / folder).exists():
            colls[folder] = {
                "collection": collection_name_for(folder),
                "bucket": buckets_map.get(folder) or def_bucket
            }
    doc = {
        "data_root": str(root),
        "collections": colls
    }
    with open(manifest_path(), "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
    log.info("Manifest written: %s", manifest_path())


# ---------------------------
# CLI
# ---------------------------

def main(argv=None):
    dotenv_loaded = load_env()
    if not dotenv_loaded:
        log.info("No .env file found; cloud sync will be attempted only if env vars are already set.")

    parser = argparse.ArgumentParser(
        description="Sync local data/<folder>... with Object Storage (upload or download), and write a manifest."
    )
    parser.add_argument(
        "--direction", choices=("upload", "download"), default="upload",
        help="upload (local -> bucket) or download (bucket -> local). Default: upload"
    )
    parser.add_argument("--source-root", default=os.getenv("DATA_SOURCE_ROOT", "./data"),
                        help="Local root containing top-level folders (default: ./data)")
    parser.add_argument("--overwrite", action="store_true", help="Force overwrite when uploading")
    parser.add_argument("--folders", default="",
                        help="Comma list of specific folders to process (defaults to auto-discovery).")
    parser.add_argument("--infer-download-prefixes", action="store_true",
                        help="When downloading and no folders specified or discovered locally, "
                             "infer top-level prefixes from the bucket (may list up to 1000 objects).")
    args = parser.parse_args(argv)

    local_root = pathlib.Path(args.source_root).resolve()
    local_root.mkdir(parents=True, exist_ok=True)

    # Dynamic folder set
    if args.folders.strip():
        folders = [x.strip() for x in args.folders.split(",") if x.strip()]
    else:
        folders = discover_local_folders(local_root)

    # Bucket mapping strategy
    bmap = parse_bucket_map()  # folder -> bucket
    def_bucket = default_bucket()

    # pick a hint bucket for connectivity check
    first_hint = next((bmap[f] for f in folders if f in bmap and bmap[f]), None) or def_bucket

    # Safe S3 setup. If anything is off, we disable cloud sync.
    s3, ClientErr, provider = get_s3_safe(first_hint)
    if provider == "none" or s3 is None:
        log.warning("Cloud sync disabled — proceeding in LOCAL-ONLY mode. A manifest will still be written.")

    # If downloading and no folders were specified or discovered:
    # Optionally infer folder names from the bucket's top-level prefixes.
    if args.direction == "download" and not folders:
        bucket_to_use = def_bucket
        if not bucket_to_use and bmap:
            # No default? Try the first bucket present in mapping.
            bucket_to_use = next((b for b in bmap.values() if b), None)
        if s3 is not None and bucket_to_use and args.infer_download_prefixes:
            inferred = list(list_bucket_top_level_prefixes(s3, bucket_to_use))
            if inferred:
                folders = inferred
                log.info("Inferred folders from bucket %s: %s", bucket_to_use, folders)
            else:
                log.info("No prefixes inferred from bucket %s; nothing to download.", bucket_to_use)

    if args.direction == "upload":
        if s3 is None:
            log.info("Upload skipped (no cloud connection).")
        else:
            for folder in folders:
                bucket = bmap.get(folder) or def_bucket
                if not bucket:
                    log.info("[SKIP] No bucket configured for folder '%s'", folder)
                    continue
                try:
                    ensure_bucket(s3, bucket, ClientErr)
                except Exception as e:
                    log.error("[SKIP] Cannot use bucket '%s': %s", bucket, e)
                    continue

                uploaded = skipped = failed = 0
                for _, fp, key in iter_local_files(local_root, [folder]):
                    try:
                        status = upload_file(s3, bucket, key=key, fp=fp, overwrite=args.overwrite)
                        if status == "uploaded":
                            uploaded += 1
                        else:
                            skipped += 1
                    except Exception as e:
                        failed += 1
                        log.error("[ERR ] %s: %s", key, e)
                log.info("[SYNC] %s -> s3://%s/  Uploaded=%s Skipped=%s Failed=%s",
                         folder, bucket, uploaded, skipped, failed)

    else:  # download
        if s3 is None:
            log.info("Download skipped (no cloud connection).")
        else:
            # If no folders, there's nothing to download
            if not folders:
                log.info("No folders specified or inferred; nothing to download.")
            for folder in folders:
                bucket = bmap.get(folder) or def_bucket
                if not bucket:
                    log.info("[SKIP] No bucket configured for folder '%s'", folder)
                    continue
                try:
                    ok, sk, fail = download_prefix(s3, bucket, folder, local_root)
                    log.info("[SYNC] s3://%s/%s/ -> %s  Downloaded=%s Skipped=%s Failed=%s",
                             bucket, folder, local_root, ok, sk, fail)
                except Exception as e:
                    log.error("[SKIP] Download failed for bucket '%s' prefix '%s': %s", bucket, folder, e)
                    continue

    # Always write/update manifest to describe local data + mapping to buckets (if any)
    write_manifest(local_root, folders, bmap, def_bucket)
    log.info("Done.")


if __name__ == "__main__":
    main()
