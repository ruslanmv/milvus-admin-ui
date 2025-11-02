# src/wxo_incident_data/create_vector_db.py
import os
import json
import time
import logging
from pathlib import Path
from typing import Dict, List, Optional

from dotenv import load_dotenv
from pymilvus import (
    connections,
    FieldSchema,
    CollectionSchema,
    DataType,
    Collection,
    utility,
)
from pymilvus.exceptions import MilvusException

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s | %(levelname)s | %(message)s",
)
log = logging.getLogger("mui.vdb")

# ---------------------------
# Helpers
# ---------------------------

def _bool_env(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    if v is None:
        return default
    return str(v).lower() in {"1", "true", "yes", "y"}


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default


def _json_env(name: str) -> Optional[dict]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return None
    try:
        val = json.loads(raw)
        if isinstance(val, dict):
            return val
        log.warning("%s is not a JSON object; ignoring.", name)
    except Exception as e:
        log.warning("Failed to parse %s: %s", name, e)
    return None


def _in_docker() -> bool:
    # Best-effort detection; also allow explicit override via IN_DOCKER=1
    return os.path.exists("/.dockerenv") or os.getenv("IN_DOCKER") == "1"


def _collection_name_from_folder(folder: str) -> str:
    pref = os.getenv("COLLECTION_PREFIX", "").strip()
    return f"{pref}{folder}" if pref else folder

# ---------------------------
# Milvus connection
# ---------------------------

def _build_connect_kwargs() -> Dict:
    """
    Build kwargs for connections.connect based on env.
    Supports:
      - MILVUS_URI (e.g., "http://host:19530" or "https://.../api/v1")
      - or MILVUS_HOST / MILVUS_PORT (+ TLS, user/password/token)
    """
    kwargs: Dict = {}
    uri = os.getenv("MILVUS_URI")
    user = os.getenv("MILVUS_USER")
    password = os.getenv("MILVUS_PASSWORD")
    token = os.getenv("MILVUS_TOKEN")
    db_name = os.getenv("MILVUS_DB")
    timeout = _int_env("MILVUS_TIMEOUT", 60)

    if uri:
        kwargs["uri"] = uri
    else:
        # Pick a sensible default host for containers
        default_host = "host.docker.internal" if _in_docker() else "127.0.0.1"
        host = os.getenv("MILVUS_HOST", default_host)
        port = os.getenv("MILVUS_PORT", "19530")
        kwargs["host"] = host
        kwargs["port"] = port
        if _bool_env("MILVUS_SECURE", False):
            kwargs["secure"] = True
            # Optional TLS server cert pinning
            server_cert = os.getenv("MILVUS_SERVER_CERT_PATH")
            if server_cert and os.path.exists(server_cert):
                kwargs["server_pem_path"] = server_cert

    if token:
        kwargs["token"] = token
    else:
        # user/password style (e.g., Milvus with auth feature enabled)
        if user and password:
            kwargs["user"] = user
            kwargs["password"] = password

    if db_name:
        # We'll connect first (optionally create DB), then reconnect with db_name in connect_milvus().
        pass

    if timeout:
        kwargs["timeout"] = timeout

    return kwargs


def _ensure_database_if_needed():
    """
    If MILVUS_DB is set and MILVUS_CREATE_DB=true, create the database if missing.
    We connect temporarily (without db_name) to perform this operation, then disconnect.
    """
    db_name = os.getenv("MILVUS_DB")
    if not db_name:
        return

    create_db = _bool_env("MILVUS_CREATE_DB", True)

    # Connect without database for admin ops
    base_kwargs = _build_connect_kwargs()
    base_kwargs.pop("db_name", None)

    try:
        log.info("Connecting to Milvus (admin ops) ...")
        connections.connect(alias="__wxo_admin__", **base_kwargs)
    except MilvusException as e:
        log.error("Admin connection failed: %s", e)
        raise

    try:
        try:
            current_dbs = utility.list_databases()
        except Exception:
            # Older client versions may not support the API; ignore
            current_dbs = []

        if create_db and (db_name not in current_dbs):
            log.info("Creating Milvus database: %s", db_name)
            try:
                utility.create_database(db_name)
            except Exception as e:
                log.warning("create_database(%s) failed or unsupported: %s", db_name, e)
    finally:
        try:
            connections.release("__wxo_admin__")
        except Exception:
            pass


def connect_milvus():
    """
    Connect to Milvus with robust defaults (Docker-friendly) and retries.
    Creates database if requested before binding final connection.
    """
    load_dotenv(override=False)

    # Optionally create DB
    _ensure_database_if_needed()

    kwargs = _build_connect_kwargs()
    db_name = os.getenv("MILVUS_DB")
    if db_name:
        kwargs["db_name"] = db_name

    # Log target for clarity
    if "uri" in kwargs:
        log_target = kwargs["uri"]
    else:
        log_target = f"{kwargs.get('host')}:{kwargs.get('port')}"

    log.info(
        "Connecting to Milvus %s (TLS=%s, DB=%s)",
        log_target,
        "True" if kwargs.get("secure") else "False",
        db_name or "<default>",
    )

    # Retry loop to wait for Milvus startup
    wait_total = _int_env("MILVUS_WAIT_SECONDS", 90)
    interval = _int_env("MILVUS_WAIT_INTERVAL", 3)
    deadline = time.time() + wait_total

    # Ensure a clean alias (avoid stale connections in repeated runs)
    try:
        connections.release("default")
    except Exception:
        pass

    last_err: Optional[Exception] = None
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        try:
            connections.connect(alias="default", **kwargs)
            return  # success
        except Exception as e:
            last_err = e
            log.warning("Milvus not ready yet (attempt %d): %s", attempt, e)
            time.sleep(interval)

    # Final try (raise MilvusException on failure)
    try:
        connections.connect(alias="default", **kwargs)
    except MilvusException as e:
        log.error("Milvus connection failed: %s", e)
        if _in_docker() and kwargs.get("host") in ("127.0.0.1", "localhost"):
            log.error("Hint: from inside Docker, use MILVUS_HOST=host.docker.internal or set MILVUS_URI.")
        log.error("If Milvus is running via docker compose, run 'make status' or 'make logs' to verify readiness.")
        raise

# ---------------------------
# Collection creation
# ---------------------------

def _index_params() -> Dict:
    # Full override via JSON takes priority
    custom = _json_env("INDEX_PARAMS_JSON")
    if custom:
        return custom

    itype = os.getenv("MILVUS_INDEX_TYPE", "IVF_FLAT").upper()
    metric = os.getenv("MILVUS_METRIC_TYPE", "IP").upper()

    # HNSW tuning (used only if HNSW)
    m = _int_env("MILVUS_M", 16)
    efc = _int_env("MILVUS_EF_CONSTRUCTION", 200)

    if itype == "HNSW":
        return {"index_type": "HNSW", "metric_type": metric, "params": {"M": m, "efConstruction": efc}}
    elif itype in ("IVF_FLAT", "IVF_SQ8"):
        return {"index_type": itype, "metric_type": metric, "params": {"nlist": 1024}}
    elif itype == "AUTOINDEX":
        # Vector index built by server; no params typically
        return {"index_type": "AUTOINDEX", "metric_type": metric, "params": {}}
    else:
        log.warning("Unknown MILVUS_INDEX_TYPE=%s, defaulting to IVF_FLAT.", itype)
        return {"index_type": "IVF_FLAT", "metric_type": metric, "params": {"nlist": 1024}}


def _ensure_collection(name: str, dim: int) -> Collection:
    """Ensure a collection with the canonical schema exists, create index, and load it."""
    if utility.has_collection(name):
        log.info("Collection exists: %s", name)
        coll = Collection(name)
    else:
        log.info("Creating collection: %s (dim=%d)", name, dim)
        fields = [
            FieldSchema(name="doc_id", dtype=DataType.VARCHAR, is_primary=True, auto_id=False, max_length=128),
            FieldSchema(name="title", dtype=DataType.VARCHAR, max_length=512),
            FieldSchema(name="url", dtype=DataType.VARCHAR, max_length=1024),
            FieldSchema(name="meta", dtype=DataType.VARCHAR, max_length=4096),
            FieldSchema(name="embedding", dtype=DataType.FLOAT_VECTOR, dim=dim),
        ]
        schema = CollectionSchema(fields=fields, description=f"MUI collection {name}")
        coll = Collection(name=name, schema=schema)
        idx = _index_params()
        log.info("Creating index on 'embedding': %s", idx)
        coll.create_index(field_name="embedding", index_params=idx)

    # Load for immediate availability
    try:
        coll.load()
    except Exception as e:
        log.warning("Collection load failed (may still be usable for writes): %s", e)

    log.info("Ready: %s", name)
    return coll

# ---------------------------
# Discover which collections to create
# ---------------------------

def _collections_from_manifest() -> Dict[str, Dict]:
    """
    Expect manifest at MANIFEST_PATH (default .wxo/manifest.json) with:
    {
      "data_root": "...",
      "collections": {
        "folderA": { "collection": "my_coll_A", "bucket": "..." },
        ...
      }
    }
    Returns { "<key>": {"collection": "<name>", ...}, ... }
    """
    mp = Path(os.getenv("MANIFEST_PATH", ".wxo/manifest.json"))
    if not mp.exists():
        return {}
    try:
        with open(mp, "r", encoding="utf-8") as f:
            doc = json.load(f)
        cols = doc.get("collections", {})
        if isinstance(cols, dict):
            return cols
        return {}
    except Exception as e:
        log.warning("Failed to read manifest %s: %s", mp, e)
        return {}


def _collections_from_env() -> List[str]:
    """
    COLLECTIONS: a CSV of explicit Milvus collection names, e.g.:
      COLLECTIONS="wxo_wiki,wxo_rca,custom_coll"
    """
    raw = os.getenv("COLLECTIONS", "").strip()
    if not raw:
        return []
    items = [x.strip() for x in raw.split(",") if x.strip()]
    return items


def _discover_local_folders() -> List[str]:
    """Inspect DATA_SOURCE_ROOT (default ./data) and discover top-level folders that contain files."""
    root = Path(os.getenv("DATA_SOURCE_ROOT", "./data")).resolve()
    if not root.exists():
        return []
    out: List[str] = []
    for child in sorted(root.iterdir()):
        if child.is_dir() and not child.name.startswith("."):
            if any(p.is_file() for p in child.rglob("*")):
                out.append(child.name)
    return out

# ---------------------------
# Main
# ---------------------------

def main():
    load_dotenv(override=False)
    connect_milvus()

    dim = _int_env("EMBED_DIM", 384)

    # 1) Prefer manifest (authoritative mapping)
    manifest_cols = _collections_from_manifest()

    # 2) Or explicit collection names from env (CSV)
    env_cols = _collections_from_env()

    # 3) Or derive from local data folders using COLLECTION_PREFIX
    derived_cols = []
    if not manifest_cols and not env_cols:
        for folder in _discover_local_folders():
            derived_cols.append(_collection_name_from_folder(folder))

    created_any = False

    if manifest_cols:
        for key, spec in manifest_cols.items():
            cname = spec.get("collection") or _collection_name_from_folder(str(key))
            _ensure_collection(cname, dim)
            created_any = True

    elif env_cols:
        for cname in env_cols:
            _ensure_collection(cname, dim)
            created_any = True

    elif derived_cols:
        for cname in derived_cols:
            _ensure_collection(cname, dim)
            created_any = True

    if not created_any:
        # Final fallback
        fallback = os.getenv("MILVUS_COLLECTION_FALLBACK", "wxo_docs")
        log.info("No collection sources found; creating fallback: %s", fallback)
        _ensure_collection(fallback, dim)

    log.info("All requested collections ensured.")


if __name__ == "__main__":
    main()
