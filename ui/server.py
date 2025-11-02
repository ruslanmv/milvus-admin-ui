# ui/server.py
#!/usr/bin/env python3
"""
Milvus Admin UI backend (FastAPI)

Features
--------
- Serves a static SPA from ui/static (Refine/Vite build)
- REST API to inspect Milvus status, manage collections, and run a RAG demo
- /api/sync endpoint to ingest local documents and (re)build the vector DB
- /api/ingest/upload to upload files from the browser and ingest them
- /api/jobs/* to track ingest progress & logs
- /api/rag/models to list supported embedding models (dims, labels)
- /api/rag/models_status to inspect preload/download state for all models
- **Blocking model preload at startup** so all embeddings are ready before traffic

Operational logging
-------------------
- Structured logs for request lifecycle, Milvus ops, and model preload
- Per-request middleware: method, path, status, duration, client IP, UA
- Clear, actionable errors with context and fallbacks

Preload controls (env)
----------------------
RAG_PRELOAD              : "all" (default), "default", "off".
  - all      -> preload all models in EMBED_MODEL_CATALOG
  - default  -> preload only the default model (RAG_MODEL or first in catalog)
  - off      -> no preload

RAG_PRELOAD_STRATEGY     : "load" (default) or "download".
  - load      -> ensure cache + load model into memory (fastest first request)
  - download  -> only ensure model weights are cached on disk; load lazily later

RAG_DEVICE               : "cpu", "cuda", or "auto" (default: auto).
RAG_SECONDARY_DEVICE     : device for non-default models when strategy=load (default: "cpu")
RAG_FORCE_CPU_ALL        : "1" -> force all models on CPU regardless of CUDA availability
RAG_MAX_PARALLEL         : max concurrent downloads/loads (default: 2)
RAG_MODEL                : default model id (overrides catalog default)
RAG_EXTRA_MODELS         : comma-separated list of extra model ids to preload
RAG_BATCH_SIZE           : batch size for encoding (default: 32)
RAG_TORCH_NUM_THREADS    : set torch.set_num_threads if > 0 (default: 0 = leave default)
HF_HOME / HUGGINGFACE_HUB_CACHE : cache dir for model downloads (must be writable)
TORCH_HOME               : cache dir for torch

Security defaults
-----------------
- /api/sync is LOCAL-ONLY by default; open with ALLOW_REMOTE_SYNC=true
- /api/ingest/upload is REMOTE-ALLOWED by default; restrict with ALLOW_REMOTE_UPLOAD=false
- Optional ADMIN_TOKEN header (X-Admin-Token) for /api/sync and /api/ingest/*

Best practices baked in
-----------------------
- Build on CPU first, then attempt CUDA move (avoids “meta tensor” crashes).
- If CUDA move fails, automatically keep the model on CPU and continue.
- If a model is already cached, we **do not** re-download (local cache is tried first).
"""

import os
import uuid
import logging
import threading
import urllib.request
import time
import socket
from datetime import datetime
from typing import Optional, Dict, Any, List, Tuple
from subprocess import run, CalledProcessError, Popen, PIPE
from shutil import which
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager

from dotenv import load_dotenv, find_dotenv
from fastapi import (
    FastAPI,
    HTTPException,
    APIRouter,
    Request,
    UploadFile,
    File,
    Form,
    Query,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, ValidationError
from pymilvus import connections, utility, Collection, FieldSchema, CollectionSchema, DataType

# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("milvus-admin-ui")

# -----------------------------------------------------------------------------
# .env (load once; do not override OS env)
# -----------------------------------------------------------------------------
load_dotenv(find_dotenv(filename=".env", usecwd=True), override=False)

# Quieter & safer defaults for HF/Transformers
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# Avoid any accelerate-induced device moves by default during CPU build
os.environ.setdefault("ACCELERATE_DISABLE_MPS_FALLBACK", "1")

# Ensure HF/Torch cache dirs exist (prevents first-run surprises)
for cache_var in ("HF_HOME", "HUGGINGFACE_HUB_CACHE", "TORCH_HOME"):
    cache_dir = os.getenv(cache_var)
    if cache_dir:
        try:
            os.makedirs(cache_dir, exist_ok=True)
        except Exception as e:
            log.warning("%s set but not creatable (%s): %s", cache_var, cache_dir, e)

# Optional torch threading perf knob
try:
    import torch  # type: ignore
    _threads = int(os.getenv("RAG_TORCH_NUM_THREADS", "0"))
    if _threads > 0:
        torch.set_num_threads(_threads)
        log.info("Torch threads set: %d", _threads)
except Exception:
    pass

# -----------------------------------------------------------------------------
# Embedding model state
# -----------------------------------------------------------------------------
_sentence_model = None
_sentence_model_id: Optional[str] = None
_model_lock = threading.Lock()

# Model cache/status registry
_MODEL_CACHE: Dict[str, Any] = {}  # id -> SentenceTransformer (when loaded)
_MODEL_STATUS: Dict[str, Dict[str, Any]] = {}  # id -> status dict
_MODEL_STATUS_LOCK = threading.Lock()

def _set_model_status(mid: str, **fields):
    with _MODEL_STATUS_LOCK:
        st = _MODEL_STATUS.get(mid, {})
        st.update(fields)
        _MODEL_STATUS[mid] = st

def _get_model_status_snapshot() -> Dict[str, Dict[str, Any]]:
    with _MODEL_STATUS_LOCK:
        return {k: dict(v) for k, v in _MODEL_STATUS.items()}

# -----------------------------------------------------------------------------
# Embedding model catalog (for UI + dim inference)
# -----------------------------------------------------------------------------
EMBED_MODEL_CATALOG: List[Dict[str, Any]] = [
    {"id": "sentence-transformers/paraphrase-MiniLM-L6-v2", "label": "MiniLM (384d)", "dim": 384},
    {"id": "sentence-transformers/all-MiniLM-L6-v2", "label": "all-MiniLM-L6-v2 (384d)", "dim": 384},
    {"id": "BAAI/bge-small-en-v1.5", "label": "bge-small-en-v1.5 (384d)", "dim": 384},
    {"id": "intfloat/e5-small-v2", "label": "e5-small-v2 (384d)", "dim": 384},
    # For higher dims, be mindful of VRAM/CPU mem:
    # {"id": "BAAI/bge-base-en-v1.5", "label": "bge-base-en-v1.5 (768d)", "dim": 768},
    # {"id": "intfloat/e5-base-v2", "label": "e5-base-v2 (768d)", "dim": 768},
]

def _infer_dim_from_model(model_id: Optional[str]) -> int:
    if not model_id:
        return 384
    for m in EMBED_MODEL_CATALOG:
        if m["id"] == model_id:
            return int(m["dim"])
    return 384

# -----------------------------------------------------------------------------
# In-memory job registry for ingest progress
# -----------------------------------------------------------------------------
JOBS: Dict[str, Dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()

def _new_job(stage: str, total_steps: int = 3) -> Dict[str, Any]:
    job_id = uuid.uuid4().hex[:8]
    job = {
        "id": job_id,
        "status": "queued",          # queued | running | done | error
        "stage": stage,              # upload_saved | ingesting | building_index | done
        "progress": 0,               # 0..100
        "logs": [],
        "created_at": datetime.utcnow().isoformat() + "Z",
        "started_at": None,
        "ended_at": None,
        "total_steps": total_steps,
        "current_step": 0,
        "meta": {},
    }
    with JOBS_LOCK:
        JOBS[job_id] = job
    log.info("Job %s created (stage=%s)", job_id, stage)
    return job

def _append_log(job_id: str, msg: str) -> None:
    line = f"[{datetime.utcnow().isoformat()}Z] {msg}"
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is not None:
            job["logs"].append(line)
            if len(job["logs"]) > 200:
                job["logs"] = job["logs"][-200:]
    log.debug("JOB %s: %s", job_id, msg)

def _set_job(job_id: str, **kwargs) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is not None:
            job.update(kwargs)
    log.info("Job %s updated: %s", job_id, kwargs)

def _run_cmd_stream(job_id: str, args: List[str], cwd: Optional[str] = None, env: Optional[Dict[str, str]] = None) -> int:
    """Run a command and stream stdout/stderr to job logs."""
    _append_log(job_id, f"$ {' '.join(args)}")
    proc = Popen(args, cwd=cwd, env=env, stdout=PIPE, stderr=PIPE, text=True, bufsize=1)
    assert proc.stdout is not None and proc.stderr is not None

    def _pump(stream, prefix):
        for line in stream:
            _append_log(job_id, f"{prefix} {line.rstrip()}")

    t_out = threading.Thread(target=_pump, args=(proc.stdout, "OUT:"), daemon=True)
    t_err = threading.Thread(target=_pump, args=(proc.stderr, "ERR:"), daemon=True)
    t_out.start()
    t_err.start()
    code = proc.wait()
    t_out.join(timeout=1)
    t_err.join(timeout=1)
    _append_log(job_id, f"process exited with code {code}")
    return code

# -----------------------------------------------------------------------------
# Helpers: env parsing
# -----------------------------------------------------------------------------
def _bool_env(name: str, default: bool = False) -> bool:
    v = os.getenv(name)
    return default if v is None else str(v).lower() in {"1", "true", "yes", "y"}

def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except Exception:
        return default

def _str_env(name: str, default: str) -> str:
    v = os.getenv(name)
    return default if v is None or v == "" else v

# -----------------------------------------------------------------------------
# Milvus connectivity
# -----------------------------------------------------------------------------
def _build_connect_kwargs() -> Dict[str, Any]:
    uri = os.getenv("MILVUS_URI")
    host = os.getenv("MILVUS_HOST", "127.0.0.1")
    port = os.getenv("MILVUS_PORT", "19530")
    secure = _bool_env("MILVUS_SECURE", False)
    token = os.getenv("MILVUS_TOKEN")
    user = os.getenv("MILVUS_USER")
    password = os.getenv("MILVUS_PASSWORD")
    db_name = os.getenv("MILVUS_DB")
    timeout = _int_env("MILVUS_TIMEOUT", 60)

    kwargs: Dict[str, Any] = {"timeout": timeout}
    if uri:
        kwargs["uri"] = uri
    else:
        kwargs.update({"host": host, "port": port})
        if secure:
            kwargs["secure"] = True

    if token:
        kwargs["token"] = token
    elif user and password:
        kwargs["user"] = user
        kwargs["password"] = password

    if db_name:
        kwargs["db_name"] = db_name
    return kwargs

def _connect_milvus() -> None:
    """Idempotent connect with the 'default' alias."""
    try:
        connections.release("default")
    except Exception:
        pass
    kwargs = _build_connect_kwargs()
    log.info("Connecting to Milvus: %s", kwargs.get("uri") or f"{kwargs.get('host')}:{kwargs.get('port')}")
    connections.connect(alias="default", **kwargs)

def _healthz_http() -> Optional[bool]:
    host = os.getenv("MILVUS_HOST", "127.0.0.1")
    port = os.getenv("MILVUS_HEALTH_PORT", "9091")
    url = f"http://{host}:{port}/healthz"
    try:
        with urllib.request.urlopen(url, timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return None

# -----------------------------------------------------------------------------
# Milvus collection helpers
# -----------------------------------------------------------------------------
def _ensure_collection(
    name: str,
    dim: int,
    metric: str = "IP",
    index_type: str = "IVF_FLAT",
    nlist: int = 1024,
) -> Collection:
    log.info("Ensuring collection '%s' (dim=%s, metric=%s, index_type=%s, nlist=%s)", name, dim, metric, index_type, nlist)
    if utility.has_collection(name):
        c = Collection(name)
    else:
        fields = [
            FieldSchema(name="doc_id", dtype=DataType.VARCHAR, is_primary=True, auto_id=False, max_length=128),
            FieldSchema(name="text", dtype=DataType.VARCHAR, max_length=2048),
            FieldSchema(name="vec", dtype=DataType.FLOAT_VECTOR, dim=dim),
        ]
        schema = CollectionSchema(fields=fields, description=f"Milvus Admin UI collection {name}")
        c = Collection(name=name, schema=schema)
        c.create_index(
            "vec",
            {"index_type": index_type.upper(), "metric_type": metric.upper(), "params": {"nlist": nlist}},
        )
    try:
        c.load()
    except Exception as e:
        log.warning("load() warning for '%s': %s", name, e)
    return c

def _list_collections_detailed() -> List[Dict[str, Any]]:
    names = utility.list_collections() or []
    out: List[Dict[str, Any]] = []
    for n in names:
        try:
            c = Collection(n)
            num = c.num_entities
            fields = []
            for f in c.schema.fields:
                item = {"name": f.name, "dtype": str(f.dtype)}
                if f.dtype == DataType.FLOAT_VECTOR:
                    item["dim"] = getattr(f.params, "dim", None) or getattr(f, "dim", None)
                if getattr(f, "max_length", None):
                    item["max_length"] = f.max_length
                if getattr(f, "is_primary", False):
                    item["primary_key"] = True
                fields.append(item)
            idx_summary = []
            try:
                for idx in c.indexes:
                    idx_summary.append(
                        {
                            "field": idx.field_name,
                            "index_type": idx.index_type,
                            "metric_type": idx.metric_type,
                            "params": idx.params,
                        }
                    )
            except Exception:
                pass
            out.append({"name": n, "num_entities": num, "fields": fields, "indexes": idx_summary})
        except Exception as e:
            out.append({"name": n, "error": str(e)})
    return out

def _introspect_collection(c: Collection) -> Dict[str, Any]:
    fields = c.schema.fields
    names = [f.name for f in fields]

    vec_name = None
    for cand in ["vec", "embedding", "embeddings", "vector"]:
        if any(f.name == cand and f.dtype == DataType.FLOAT_VECTOR for f in fields):
            vec_name = cand
            break
    if vec_name is None:
        for f in fields:
            if f.dtype == DataType.FLOAT_VECTOR:
                vec_name = f.name
                break

    id_name = next((f.name for f in fields if getattr(f, "is_primary", False)), None)
    text_name = next((n for n in ["text", "content", "title", "chunk", "body", "page_content"] if n in names), None)
    defaults = [n for n in ["doc_id", "title", "url", "meta", "text"] if n in names]

    return {
        "vector_field": vec_name,
        "id_field": id_name,
        "text_field": text_name,
        "all_fields": names,
        "default_output_fields": defaults,
    }

def _search_params_for(c: Collection) -> Dict[str, Any]:
    try:
        idx = c.indexes[0]
        t = (idx.index_type or "").upper()
        if t == "HNSW":
            return {"ef": _int_env("MILVUS_EF", 64)}
        if t.startswith("IVF"):
            return {"nprobe": _int_env("MILVUS_NPROBE", 10)}
        return {"nprobe": 10}
    except Exception:
        return {"nprobe": 10}

def _repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

def _venv_bin() -> str:
    root = _repo_root()
    posix_bin = os.path.join(root, ".venv", "bin")
    win_bin = os.path.join(root, ".venv", "Scripts")
    return posix_bin if os.path.isdir(posix_bin) else win_bin

def _which_or(path: str, fallback: str) -> str:
    if os.path.isabs(path) and os.path.exists(path):
        return path
    abs_p = os.path.join(_repo_root(), path)
    if os.path.exists(abs_p):
        return abs_p
    w = which(fallback)
    return w or fallback

# -----------------------------------------------------------------------------
# FS helpers for uploads
# -----------------------------------------------------------------------------
def _is_local_request(request: Request) -> bool:
    client_ip = (request.client.host if request.client else "") or ""
    return client_ip in {"127.0.0.1", "::1", "0.0.0.0"}

def _safe_relpath(name: str) -> str:
    name = name.replace("\\", "/").lstrip("/")
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return os.path.basename(name)
    return "/".join(parts) if parts else os.path.basename(name)

def _ensure_dir(p: str) -> None:
    os.makedirs(p, exist_ok=True)

def _save_uploads(dest_root: str, files: List[UploadFile]) -> Tuple[int, int, List[str]]:
    _ensure_dir(dest_root)
    saved: List[str] = []
    total = 0
    count = 0
    for uf in files:
        rel = _safe_relpath(getattr(uf, "filename", "") or "file")
        dest_path = os.path.join(dest_root, rel)
        _ensure_dir(os.path.dirname(dest_path))
        with open(dest_path, "wb") as out:
            while True:
                chunk = uf.file.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                total += len(chunk)
        saved.append(rel)
        count += 1
    return count, total, saved

# -----------------------------------------------------------------------------
# Sentence embeddings (RAG demo)
# -----------------------------------------------------------------------------
def _has_cuda() -> bool:
    try:
        import torch  # type: ignore
        return torch.cuda.is_available()
    except Exception:
        return False

def _select_device(preload: bool, is_default: bool) -> str:
    """Choose device respecting env hints and availability."""
    if _bool_env("RAG_FORCE_CPU_ALL", False):
        return "cpu"
    device_env = _str_env("RAG_DEVICE", "auto").lower()
    secondary = _str_env("RAG_SECONDARY_DEVICE", "cpu").lower()
    if device_env in {"cpu", "cuda"}:
        return device_env if (is_default or preload) else secondary
    return "cuda" if _has_cuda() else "cpu"

def _ensure_snapshot_local(mid: str) -> Optional[str]:
    """
    Ensure a model snapshot exists locally.
    - First try local cache only (no network).
    - If not present, download snapshot (will be skipped if already cached).
    Returns the local folder path or None on failure.
    """
    try:
        from huggingface_hub import snapshot_download  # type: ignore
    except Exception as e:
        log.warning("huggingface_hub not installed; cannot snapshot_download: %s", e)
        return None

    try:
        # Try local cache only — avoids re-download & network if already present
        path = snapshot_download(repo_id=mid, local_files_only=True)
        return path
    except Exception:
        pass
    try:
        path = snapshot_download(repo_id=mid, local_files_only=False)
        return path
    except Exception as e:
        log.warning("snapshot_download failed for %s: %s", mid, e)
        return None

# --- Safe builders & progressive fallbacks -----------------------------------
def _safe_build_st_pipeline(mid: str, cache_dir: Optional[str], variant: int = 1) -> "SentenceTransformer":
    """
    Build a SentenceTransformer pipeline explicitly to avoid meta-tensor issues.
    variant:
      1 -> models.Transformer(..., low_cpu_mem_usage=False, device_map=None)
      2 -> models.Transformer(..., low_cpu_mem_usage=False, device_map='cpu')  # extra guard
      3 -> SentenceTransformer(mid, device='cpu')                              # plain build
      4 -> SentenceTransformer(mid, device='cpu', trust_remote_code=True)     # last resort
    """
    # Import locally to keep startup fast if not used
    import torch
    from sentence_transformers import SentenceTransformer, models

    if variant in (1, 2):
        # Explicit model_args forwarded into AutoModel/AutoTokenizer.from_pretrained
        model_args = {
            "low_cpu_mem_usage": False,          # ensure real tensors, not meta
            "torch_dtype": torch.float32,        # stable dtype on CPU
            "device_map": None if variant == 1 else "cpu",
            "local_files_only": bool(cache_dir), # don't network if cache present
            "trust_remote_code": True,           # safe for repos with custom heads
        }
        word = models.Transformer(mid, cache_dir=cache_dir, model_args=model_args)
        # Mean pooling (SBERT default)
        pooling = models.Pooling(word.get_word_embedding_dimension())
        return SentenceTransformer(modules=[word, pooling], device="cpu")

    # Plain constructor fallbacks
    if variant == 3:
        return SentenceTransformer(mid, device="cpu", cache_folder=cache_dir)

    # variant 4
    return SentenceTransformer(mid, device="cpu", cache_folder=cache_dir, trust_remote_code=True)

def _safe_load_sentence_transformer(mid: str, target_device: str):
    """
    Robust loader that prevents the 'meta tensor' error:
    - Build pipeline explicitly on CPU using 'low_cpu_mem_usage=False'.
    - If that fails, progressively fallback to safer constructors.
    - Optionally move to CUDA afterwards; if move fails, stay on CPU.
    """
    cache_path = _ensure_snapshot_local(mid)  # no-op if already cached
    t0 = time.time()

    last_err: Optional[Exception] = None
    for variant in (1, 2, 3, 4):
        try:
            model = _safe_build_st_pipeline(mid, cache_dir=cache_path, variant=variant)
            dur_cpu = time.time() - t0
            log.info("Built pipeline variant=%s for %s (cpu-load=%.2fs)", variant, mid, dur_cpu)
            break
        except Exception as e:
            last_err = e
            log.warning("Build variant %s failed for %s: %s", variant, mid, e)
            model = None
    if model is None:
        log.error("Failed to build model pipeline for %s after all fallbacks: %s", mid, last_err)
        raise last_err if last_err else RuntimeError(f"Unknown error creating model {mid}")

    # Move to CUDA if requested & available
    final_device = "cpu"
    if target_device == "cuda" and _has_cuda():
        try:
            t2 = time.time()
            model.to("cuda")
            final_device = "cuda"
            log.info("Model move to CUDA ok: %s in %.2fs", mid, time.time() - t2)
        except Exception as e:
            if "Cannot copy out of meta tensor" in str(e) or isinstance(e, NotImplementedError):
                log.warning("CUDA move failed for %s (meta tensor), staying on CPU: %s", mid, e)
            else:
                log.warning("CUDA move unexpected failure for %s, staying on CPU: %s", mid, e)

    return model, final_device

def _load_sentence_model(model_id: Optional[str] = None):
    """
    Lazily load a sentence-transformer model once.
    - device can be forced via RAG_DEVICE=cpu|cuda|auto (default: auto)
    - guarded by a lock to avoid concurrent double-inits
    - uses cache if model was preloaded
    """
    global _sentence_model, _sentence_model_id
    mid = model_id or os.getenv("RAG_MODEL", EMBED_MODEL_CATALOG[0]["id"])
    with _model_lock:
        if _sentence_model is not None and _sentence_model_id == mid:
            return _sentence_model
        cached = _MODEL_CACHE.get(mid)
        if cached is not None:
            _sentence_model = cached
            _sentence_model_id = mid
            return _sentence_model

        device_pref = _select_device(preload=False, is_default=True)
        log.info("Loading sentence-transformer model safely: %s (pref=%s)", mid, device_pref)
        model, final_dev = _safe_load_sentence_transformer(mid, device_pref)
        _sentence_model = model
        _sentence_model_id = mid
        _MODEL_CACHE[mid] = model
        _set_model_status(
            mid,
            loaded=True,
            device=final_dev,
            last_error=None,
            last_loaded_at=datetime.utcnow().isoformat() + "Z",
            stage="loaded",
        )
    return _sentence_model

def _preload_one_model(mid: str, strategy: str, is_default: bool) -> None:
    """
    Preload or download a model; record status and cache the instance when loaded.
    """
    t0 = time.time()
    _set_model_status(mid, stage="starting", loaded=False, device=None, last_error=None)
    try:
        # Always ensure cache exists locally (no network if already present)
        _ensure_snapshot_local(mid)

        if strategy == "download":
            dur = time.time() - t0
            _set_model_status(mid, stage="downloaded", loaded=False, device=None, last_error=None, seconds=round(dur, 2))
            log.info("✔ Preload(download) ensured cache: %s in %.2fs", mid, dur)
        else:
            device_target = _select_device(preload=True, is_default=is_default)
            log.info("▶ Preload(load) start: %s (target=%s)", mid, device_target)
            model, final_device = _safe_load_sentence_transformer(mid, device_target)
            dur = time.time() - t0
            with _MODEL_STATUS_LOCK:
                _MODEL_CACHE[mid] = model
            _set_model_status(
                mid,
                stage="loaded",
                loaded=True,
                device=final_device,
                last_error=None,
                seconds=round(dur, 2),
                last_loaded_at=datetime.utcnow().isoformat() + "Z",
            )
            log.info("✔ Preload(load) ready: %s on %s in %.2fs", mid, final_device, dur)
    except Exception as e:
        dur = time.time() - t0
        _set_model_status(mid, stage="error", loaded=False, device=None, last_error=str(e), seconds=round(dur, 2))
        log.error("✖ Preload error for %s after %.2fs: %s", mid, dur, e)

def _preload_models_blocking() -> None:
    """
    Block server startup until requested models are preloaded/downloaded.
    """
    mode = _str_env("RAG_PRELOAD", "all").lower()  # all | default | off
    strat = _str_env("RAG_PRELOAD_STRATEGY", "load").lower()  # load | download
    max_workers = max(1, _int_env("RAG_MAX_PARALLEL", 2))

    if mode == "off":
        log.info("Model preload disabled (RAG_PRELOAD=off).")
        return

    cat_ids = [m["id"] for m in EMBED_MODEL_CATALOG]
    default_id = os.getenv("RAG_MODEL", cat_ids[0] if cat_ids else None)
    if not default_id:
        log.warning("No models in catalog; skipping preload.")
        return

    if mode == "default":
        todo = [default_id]
    else:
        extras = [s.strip() for s in _str_env("RAG_EXTRA_MODELS", "").split(",") if s.strip()]
        todo = list(dict.fromkeys([*cat_ids, *extras]))  # de-dupe, keep order

    for mid in todo:
        _set_model_status(mid, listed=True, stage="queued", loaded=False, device=None, last_error=None)

    log.info("Preload plan: strategy=%s, mode=%s, workers=%d, models=%d", strat, mode, max_workers, len(todo))
    t_all = time.time()

    futures = []
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="preload") as ex:
        for mid in todo:
            is_default = (mid == default_id)
            futures.append(ex.submit(_preload_one_model, mid, strat, is_default))

        for i, fut in enumerate(as_completed(futures), 1):
            try:
                fut.result()
            except Exception as e:
                log.error("Preload worker raised: %s", e)
            snap = _get_model_status_snapshot()
            done = sum(1 for s in snap.values() if s.get("stage") in {"loaded", "downloaded", "error"})
            log.info("Preload progress: %d/%d completed", done, len(todo))

    dur_all = time.time() - t_all
    snap = _get_model_status_snapshot()
    loaded = [k for k, v in snap.items() if v.get("loaded")]
    errors = {k: v.get("last_error") for k, v in snap.items() if v.get("stage") == "error"}
    log.info("Preload finished in %.2fs — loaded=%d, errors=%d", dur_all, len(loaded), len(errors))
    if errors:
        for k, err in errors.items():
            log.error("Preload error summary: %s -> %s", k, err)

# -----------------------------------------------------------------------------
# Schemas for API (used for validation/coercion)
# -----------------------------------------------------------------------------
class CreateCollectionReq(BaseModel):
    name: str = Field(..., min_length=1)
    dim: int = Field(..., gt=0)
    metric: str = Field("IP")
    index_type: str = Field("IVF_FLAT")
    nlist: int = Field(1024, gt=1)

class RagDoc(BaseModel):
    doc_id: str
    text: str

class RagInsertReq(BaseModel):
    collection: str
    docs: List[RagDoc]
    model: Optional[str] = None

class RagSearchReq(BaseModel):
    collection: str
    query: str
    topk: int = 5
    model: Optional[str] = None
    output_fields: Optional[List[str]] = None

# -----------------------------------------------------------------------------
# FastAPI app (with lifespan for startup preload)
# -----------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        _preload_models_blocking()
    except Exception as e:
        # Let the app start; models can be loaded lazily per-request.
        log.error("Startup preload encountered an error: %s", e)
    yield
    # No teardown needed

app = FastAPI(title="Milvus Admin UI", version="1.6.1", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Structured request logging middleware ---
@app.middleware("http")
async def _log_requests(request: Request, call_next):
    path = request.url.path
    log_static = _bool_env("LOG_STATIC", False)
    if path.startswith("/static") and not log_static:
        return await call_next(request)

    t0 = time.time()
    client = request.client.host if request.client else "-"
    ua = request.headers.get("user-agent", "-")[:120]
    method = request.method
    try:
        response = await call_next(request)
        status = response.status_code
    except Exception as e:
        status = 500
        log.exception("HTTP %s %s failed: %s", method, path, e)
        response = JSONResponse(content={"detail": "Internal Server Error"}, status_code=500)

    dur = time.time() - t0
    log.info("http method=%s path=%s status=%s dur=%.3fs ip=%s ua=%s", method, path, status, dur, client, ua)
    return response

api = APIRouter(prefix="/api", tags=["api"])

@api.get("/ping")
def api_ping():
    return {"ok": True}

@api.get("/rag/models")
def api_models():
    return {"models": EMBED_MODEL_CATALOG}

@api.get("/rag/models_status")
def api_models_status():
    """Report preload/download status for each known/extra model."""
    return {"status": _get_model_status_snapshot()}

@api.get("/status")
def api_status():
    _connect_milvus()
    host = os.getenv("MILVUS_HOST", "127.0.0.1")
    grpc_port = int(os.getenv("MILVUS_PORT", "19530"))
    health = _healthz_http()
    try:
        version = utility.get_server_version()
    except Exception:
        version = None
    cfg = _build_connect_kwargs()
    target = cfg.get("uri") or f"{cfg.get('host')}:{cfg.get('port')}"
    return {
        "connected": True,
        "target": target,
        "milvus_host": host,
        "milvus_port_grpc": grpc_port,
        "milvus_healthz_http": health,
        "server_version": version,
        "collections": _list_collections_detailed(),
        "models_status": _get_model_status_snapshot(),
    }

@api.get("/collections")
def api_collections():
    _connect_milvus()
    return {"collections": _list_collections_detailed()}

@api.get("/collections/{name}")
def api_get_collection(name: str):
    _connect_milvus()
    if not utility.has_collection(name):
        raise HTTPException(status_code=404, detail="Collection not found")
    c = Collection(name)
    fields = []
    for f in c.schema.fields:
        item = {"name": f.name, "dtype": str(f.dtype)}
        if getattr(f, "max_length", None):
            item["max_length"] = f.max_length
        if getattr(f, "is_primary", False):
            item["primary_key"] = True
        if f.dtype == DataType.FLOAT_VECTOR:
            item["dim"] = getattr(f.params, "dim", None) or getattr(f, "dim", None)
        fields.append(item)
    idxs = []
    try:
        for idx in c.indexes:
            idxs.append(
                {
                    "field": idx.field_name,
                    "index_type": idx.index_type,
                    "metric_type": idx.metric_type,
                    "params": idx.params,
                }
            )
    except Exception:
        pass
    info = _introspect_collection(c)
    return {
        "name": name,
        "num_entities": c.num_entities,
        "fields": fields,
        "indexes": idxs,
        "schema_info": info,
    }

# -------- Accept JSON or Form for /collections (prevents 422) ----------
@api.post("/collections")
async def api_create_collection(request: Request):
    """
    Create a collection. Accepts either JSON body or form-encoded fields.
    Fields:
      - name (str)  REQUIRED (default: 'documents' if omitted)
      - dim (int)   REQUIRED (if missing, inferred from 'model' or default 384)
      - metric (str)        default 'IP'
      - index_type (str)    default 'IVF_FLAT'
      - nlist (int)         default 1024 (used for IVF*)
      - model (str)         optional, used only for inferring dim if not provided
    """
    body: Dict[str, Any] = {}
    try:
        body = await request.json()
        log.info("collections.create body(json)=%s", body)
    except Exception:
        try:
            form = await request.form()
            body = {k: v for k, v in form.items()}
            log.info("collections.create body(form)=%s", body)
        except Exception:
            log.warning("collections.create: no body parsed")

    name = (body.get("name") or "documents").strip()
    model_hint = body.get("model")
    dim = body.get("dim")
    try:
        dim = int(dim) if dim not in (None, "",) else _infer_dim_from_model(model_hint)
    except Exception:
        dim = _infer_dim_from_model(model_hint)

    metric = (body.get("metric") or "IP").upper()
    index_type = (body.get("index_type") or "IVF_FLAT").upper()
    nlist = body.get("nlist")
    try:
        nlist = int(nlist) if nlist not in (None, "",) else 1024
    except Exception:
        nlist = 1024

    try:
        req = CreateCollectionReq(name=name, dim=dim, metric=metric, index_type=index_type, nlist=nlist)
    except ValidationError as ve:
        log.error("collections.create validation error: %s", ve)
        raise HTTPException(status_code=422, detail=ve.errors())

    _connect_milvus()
    t0 = time.time()
    coll = _ensure_collection(req.name, req.dim, req.metric, req.index_type, req.nlist)
    log.info("collections.create ok name=%s entities=%s took=%.3fs", req.name, coll.num_entities, time.time()-t0)
    return {"ok": True, "collection": req.name, "num_entities": coll.num_entities}

@api.delete("/collections/{name}")
def api_drop_collection(name: str):
    _connect_milvus()
    if not utility.has_collection(name):
        raise HTTPException(status_code=404, detail="Collection not found")
    utility.drop_collection(name)
    log.info("collections.drop ok name=%s", name)
    return {"ok": True, "dropped": name}

@api.post("/rag/insert")
def api_rag_insert(req: RagInsertReq):
    _connect_milvus()
    if not utility.has_collection(req.collection):
        raise HTTPException(status_code=404, detail="Collection not found")
    coll = Collection(req.collection)

    schema_names = {f.name for f in coll.schema.fields}
    if not {"doc_id", "text", "vec"}.issubset(schema_names):
        raise HTTPException(
            status_code=400,
            detail=(
                f"Collection '{req.collection}' does not match demo schema [doc_id, text, vec]. "
                "Use /api/sync to ingest data into your production schema."
            ),
        )

    model = _MODEL_CACHE.get(req.model or os.getenv("RAG_MODEL", EMBED_MODEL_CATALOG[0]["id"])) or _load_sentence_model(req.model)
    texts = [d.text for d in req.docs]
    bs = _int_env("RAG_BATCH_SIZE", 32)
    t0 = time.time()
    log.info("rag.insert encoding count=%d batch=%d model=%s", len(texts), bs, req.model or "default")
    vecs = model.encode(texts, batch_size=bs, normalize_embeddings=True, show_progress_bar=False).tolist()
    ids = [d.doc_id for d in req.docs]
    log.info("rag.insert encode took=%.3fs", time.time() - t0)

    coll.insert([ids, texts, vecs])
    # Force a flush so docs appear immediately for tests / interactive use
    try:
        coll.flush()
        log.info("rag.insert flushed collection '%s'", req.collection)
    except Exception as e:
        log.warning("rag.insert flush warning: %s", e)

    try:
        coll.load()
    except Exception as e:
        log.warning("rag.insert load warning: %s", e)

    return {"ok": True, "inserted": len(ids), "collection": req.collection}

@api.post("/rag/search")
def api_rag_search(req: RagSearchReq):
    _connect_milvus()
    if not utility.has_collection(req.collection):
        raise HTTPException(status_code=404, detail="Collection not found")

    coll = Collection(req.collection)
    model = _MODEL_CACHE.get(req.model or os.getenv("RAG_MODEL", EMBED_MODEL_CATALOG[0]["id"])) or _load_sentence_model(req.model)
    t0 = time.time()
    qv = model.encode([req.query], batch_size=1, normalize_embeddings=True, show_progress_bar=False).tolist()
    log.info("rag.search encode took=%.3fs", time.time() - t0)

    info = _introspect_collection(coll)
    vec_field = info["vector_field"]
    if not vec_field:
        raise HTTPException(status_code=400, detail="No FLOAT_VECTOR field found in collection")

    fields = req.output_fields or info["default_output_fields"]
    fields = [f for f in (fields or []) if f in info["all_fields"]]
    if not fields and info["id_field"]:
        fields = [info["id_field"]]

    try:
        coll.load()
    except Exception:
        pass
    params = _search_params_for(coll)

    t1 = time.time()
    log.info("rag.search collection=%s field=%s params=%s", req.collection, vec_field, params)
    res = coll.search(qv, vec_field, param=params, limit=req.topk, output_fields=fields)
    log.info("rag.search milvus took=%.3fs", time.time() - t1)

    hits_out: List[Dict[str, Any]] = []
    for hits in res:
        for h in hits:
            row = {"score": float(getattr(h, "score", 0.0))}
            for f in fields:
                try:
                    row[f] = h.entity.get(f)
                except Exception:
                    pass
            hits_out.append(row)

    return {
        "ok": True,
        "count": len(hits_out),
        "vector_field": vec_field,
        "search_params": params,
        "output_fields": fields,
        "hits": hits_out,
    }

# -----------------------------------------------------------------------------
# Sync endpoint (LOCAL ONLY by default + optional ADMIN_TOKEN)
# -----------------------------------------------------------------------------
@api.post("/sync")
def api_sync(request: Request):
    client_ip = (request.client.host if request.client else "") or ""
    if not _bool_env("ALLOW_REMOTE_SYNC", False) and client_ip not in {"127.0.0.1", "::1"}:
        raise HTTPException(
            status_code=403,
            detail="/api/sync is local-only. Set ALLOW_REMOTE_SYNC=true to allow remote access.",
        )
    admin_token = os.getenv("ADMIN_TOKEN")
    if admin_token:
        hdr = request.headers.get("x-admin-token")
        if hdr != admin_token:
            raise HTTPException(status_code=401, detail="Missing/invalid X-Admin-Token")

    root = _repo_root()
    vbin = _venv_bin()
    ingest_exe = _which_or(os.path.join(vbin, "mui-ingest"), "mui-ingest")
    create_exe = _which_or(os.path.join(vbin, "mui-create-vectordb"), "mui-create-vectordb")
    source_root = os.getenv("DATA_SOURCE_ROOT", os.path.join(root, "data"))

    log.info("sync start source_root=%s", source_root)
    try:
        r1 = run([ingest_exe, "--source-root", source_root], check=True, capture_output=True, text=True, cwd=root)
        r2 = run([create_exe], check=True, capture_output=True, text=True, cwd=root)
        log.info("sync complete")
        return {"ok": True, "logs": {"ingest": r1.stdout[-4000:], "create": r2.stdout[-4000:]}}
    except CalledProcessError as e:
        err = (e.stderr or str(e))
        log.error("sync failed: %s", err)
        raise HTTPException(status_code=500, detail=f"sync failed: {err}")

# -----------------------------------------------------------------------------
# Upload ingest endpoint (REMOTE-ALLOWED by default + optional ADMIN_TOKEN)
# -----------------------------------------------------------------------------
@api.post("/ingest/upload")
async def api_ingest_upload(
    request: Request,
    collection: str = Form(...),
    model: Optional[str] = Form(None),
    chunk_size: int = Form(512),
    #chunk_size: Optional[str] = Form(None),
    overlap: int = Form(64),
    #overlap: Optional[str] = Form(None),
    normalize: bool = Form(False),
    ocr: bool = Form(False),
    language_detect: bool = Form(True),
    dedupe: bool = Form(True),
    files: Optional[List[UploadFile]] = File(None),
    file: Optional[UploadFile] = File(None),
):
    admin_token = os.getenv("ADMIN_TOKEN")
    if admin_token:
        hdr = request.headers.get("x-admin-token")
        if hdr != admin_token:
            raise HTTPException(status_code=401, detail="Missing/invalid X-Admin-Token")

    if not _bool_env("ALLOW_REMOTE_UPLOAD", True) and not _is_local_request(request):
        raise HTTPException(
            status_code=403,
            detail="/api/ingest/upload is disabled for remote clients. Set ALLOW_REMOTE_UPLOAD=true to enable.",
        )

    # Coalesce inputs
    file_list: List[UploadFile] = []
    if isinstance(files, list) and len(files) > 0:
        file_list.extend(files)
    if file is not None:
        file_list.append(file)

    if not file_list:
        raise HTTPException(status_code=400, detail="No files provided")

    _connect_milvus()
    if not utility.has_collection(collection):
        raise HTTPException(status_code=404, detail=f"Collection '{collection}' not found")

    root = _repo_root()
    vbin = _venv_bin()
    base_upload = os.getenv("UPLOAD_WORKDIR", os.path.join(root, "uploads"))
    job = _new_job(stage="upload_saved", total_steps=3)
    job_id = job["id"]

    _set_job(job_id, status="running", started_at=datetime.utcnow().isoformat() + "Z")
    _append_log(job_id, f"Job created for collection={collection}")

    timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    dest_root = os.path.join(base_upload, collection, f"{timestamp}_{job_id}")
    _ensure_dir(dest_root)

    _append_log(job_id, f"Saving {len(file_list)} file(s) to {dest_root}")
    saved_count, total_bytes, saved_relpaths = _save_uploads(dest_root, file_list)
    _append_log(job_id, f"Saved {saved_count} file(s), {total_bytes} bytes")

    _set_job(job_id, current_step=1, progress=20, stage="upload_saved",
             meta={"collection": collection, "dest_root": dest_root, "files": saved_relpaths})

    def _worker():
        try:
            ingest_exe = _which_or(os.path.join(vbin, "mui-ingest"), "mui-ingest")
            create_exe = _which_or(os.path.join(vbin, "mui-create-vectordb"), "mui-create-vectordb")

            env = os.environ.copy()
            if model:
                env["RAG_MODEL"] = model
            env["RAG_NORMALIZE"] = "1" if normalize else "0"
            env["RAG_CHUNK_SIZE"] = str(chunk_size)
            env["RAG_OVERLAP"] = str(overlap)
            env["RAG_OCR"] = "1" if ocr else "0"
            env["RAG_LANG_DETECT"] = "1" if language_detect else "0"
            env["RAG_DEDUPE"] = "1" if dedupe else "0"

            _set_job(job_id, stage="ingesting", current_step=2, progress=40)
            _append_log(job_id, f"Ingesting from {dest_root} (model={model or os.getenv('RAG_MODEL', 'default')})")
            code1 = _run_cmd_stream(job_id, [ingest_exe, "--source-root", dest_root], cwd=root, env=env)
            if code1 != 0:
                raise RuntimeError(f"mui-ingest exited with code {code1}")

            _set_job(job_id, stage="building_index", current_step=3, progress=70)
            _append_log(job_id, "Building / refreshing vector DB & indexes")
            code2 = _run_cmd_stream(job_id, [create_exe], cwd=root, env=env)
            if code2 != 0:
                raise RuntimeError(f"mui-create-vectordb exited with code {code2}")

            try:
                c = Collection(collection)
                c.load()
                _append_log(job_id, f"Collection '{collection}' loaded")
            except Exception as e:
                _append_log(job_id, f"Load warning: {e}")

            _set_job(job_id, status="done", stage="done", progress=100, ended_at=datetime.utcnow().isoformat() + "Z")
            _append_log(job_id, "Job complete")
        except Exception as e:
            _set_job(job_id, status="error", stage="error", progress=100, ended_at=datetime.utcnow().isoformat() + "Z")
            _append_log(job_id, f"ERROR: {e}")

    threading.Thread(target=_worker, daemon=True).start()

    log.info("upload saved collection=%s job=%s dest=%s files=%d bytes=%d",
             collection, job_id, dest_root, saved_count, total_bytes)

    return {
        "ok": True,
        "job": {
            "id": job_id,
            "collection": collection,
            "saved": saved_count,
            "bytes": total_bytes,
            "dest": dest_root,
        },
        "note": "Upload saved. Ingest running in background. Poll /api/jobs/{id} for progress.",
    }

# -----------------------------------------------------------------------------
# Job status & logs
# -----------------------------------------------------------------------------
@api.get("/jobs")
def api_jobs():
    with JOBS_LOCK:
        items = []
        for j in JOBS.values():
            ji = {k: v for k, v in j.items() if k != "logs"}
            ji["logs_len"] = len(j["logs"])
            items.append(ji)
        return {"jobs": items}

@api.get("/jobs/{job_id}")
def api_job(job_id: str, tail: int = Query(4000, ge=0, le=100000)):
    with JOBS_LOCK:
        j = JOBS.get(job_id)
        if not j:
            raise HTTPException(status_code=404, detail="job not found")
        data = dict(j)
        logs_joined = "\n".join(j["logs"])
        if tail > 0 and len(logs_joined) > tail:
            logs_joined = logs_joined[-tail:]
        data["logs_tail"] = logs_joined
        data.pop("logs", None)
        return {"job": data}

# Register API router FIRST
app.include_router(api)

# --- Static files & SPA ---
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/", include_in_schema=False)
def root():
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return JSONResponse({"message": "Milvus Admin UI API. Build the frontend into ui/static/ (e.g., scripts/build-ui.sh)."})

# SPA fallback – must be LAST so it doesn't shadow /api/*
@app.get("/{path:path}", include_in_schema=False)
def spa_fallback(path: str):
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    raise HTTPException(status_code=404, detail="UI not built")

# -----------------------------------------------------------------------------
# Entrypoint (CLI)
# -----------------------------------------------------------------------------
def _port_available(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.2)
        probe_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
        return s.connect_ex((probe_host, port)) != 0

if __name__ == "__main__":
    import uvicorn
    host = os.getenv("UI_HOST", "0.0.0.0")
    port = int(os.getenv("UI_PORT", "7860"))
    if not _port_available(host, port):
        log.error("Port %s on %s appears to be in use. Exiting to avoid duplicate server.", port, host)
        raise SystemExit(1)
    log.info("* Milvus Admin UI: http://127.0.0.1:%s", port)
    uvicorn.run("server:app", host=host, port=port, reload=False, workers=1, log_level=LOG_LEVEL.lower())
