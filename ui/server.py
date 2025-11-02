# ui/server.py
#!/usr/bin/env python3
"""
Milvus Admin UI backend (FastAPI)
- Serves a static SPA from ui/static (Refine/Vite build)
- REST API to inspect Milvus status, manage collections, and run a RAG demo
- /api/sync endpoint to ingest local documents and (re)build the vector DB
- /api/ingest/upload to upload files from the browser and ingest them
- /api/jobs/* to track ingest progress & logs
- /api/rag/models to list supported embedding models (dims, labels)

Hardenings & QoL:
- /api/collections now accepts JSON OR form bodies (fixes 422 if client sends form)
- Infers dim from selected embedding model when not provided
- Rich logs for each step

Security defaults:
- /api/sync is LOCAL-ONLY by default; open with ALLOW_REMOTE_SYNC=true
- /api/ingest/upload is REMOTE-ALLOWED by default; restrict with ALLOW_REMOTE_UPLOAD=false
- Optional ADMIN_TOKEN header (X-Admin-Token) for /api/sync and /api/ingest/*
"""
import os
import uuid
import logging
import threading
import urllib.request
from datetime import datetime
from typing import Optional, Dict, Any, List, Tuple
from subprocess import run, CalledProcessError, Popen, PIPE
from shutil import which

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

_sentence_model = None

# -----------------------------------------------------------------------------
# Embedding model catalog (for UI + dim inference)
# -----------------------------------------------------------------------------
EMBED_MODEL_CATALOG: List[Dict[str, Any]] = [
    {"id": "sentence-transformers/paraphrase-MiniLM-L6-v2", "label": "MiniLM (384d)", "dim": 384},
    {"id": "sentence-transformers/all-MiniLM-L6-v2", "label": "all-MiniLM-L6-v2 (384d)", "dim": 384},
    {"id": "BAAI/bge-small-en-v1.5", "label": "bge-small-en-v1.5 (384d)", "dim": 384},
    {"id": "intfloat/e5-small-v2", "label": "e5-small-v2 (384d)", "dim": 384},
    # Add more if needed (watch memory):
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
def _load_sentence_model(model_id: Optional[str] = None):
    global _sentence_model
    if _sentence_model is None or model_id:
        from sentence_transformers import SentenceTransformer  # lazy import
        if not model_id:
            model_id = os.getenv("RAG_MODEL", EMBED_MODEL_CATALOG[0]["id"])
        log.info("Loading sentence-transformer model: %s", model_id)
        _sentence_model = SentenceTransformer(model_id)
    return _sentence_model

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
# FastAPI app
# -----------------------------------------------------------------------------
app = FastAPI(title="Milvus Admin UI", version="1.3")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api", tags=["api"])

@api.get("/ping")
def api_ping():
    return {"ok": True}

@api.get("/rag/models")
def api_models():
    return {"models": EMBED_MODEL_CATALOG}

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

# -------- FIX: accept JSON or Form for /collections (prevents 422) ----------
@api.post("/collections")
async def api_create_collection(request: Request):
    """
    Create a collection. Accepts either JSON body or form-encoded fields.

    Supported fields:
      - name (str)  REQUIRED (default: 'documents' if omitted)
      - dim (int)   REQUIRED (if missing, inferred from 'model' or default 384)
      - metric (str)        default 'IP'
      - index_type (str)    default 'IVF_FLAT'
      - nlist (int)         default 1024 (used for IVF*)
      - model (str)         optional, used only for inferring dim if not provided
    """
    # Try JSON first, then form
    body: Dict[str, Any] = {}
    try:
        body = await request.json()
        log.info("POST /collections received JSON: %s", body)
    except Exception:
        try:
            form = await request.form()
            body = {k: v for k, v in form.items()}
            log.info("POST /collections received FORM: %s", body)
        except Exception:
            log.warning("POST /collections: no body parsed")

    # Coerce types + defaults
    name = (body.get("name") or "documents").strip()
    model_hint = body.get("model")
    # If dim is missing/empty, infer from model or fallback 384
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

    # Validate via Pydantic
    try:
        req = CreateCollectionReq(name=name, dim=dim, metric=metric, index_type=index_type, nlist=nlist)
    except ValidationError as ve:
        log.error("Validation error for /collections: %s", ve)
        raise HTTPException(status_code=422, detail=ve.errors())

    _connect_milvus()
    coll = _ensure_collection(req.name, req.dim, req.metric, req.index_type, req.nlist)
    log.info("Collection '%s' ready (entities=%s)", req.name, coll.num_entities)
    return {"ok": True, "collection": req.name, "num_entities": coll.num_entities}

@api.delete("/collections/{name}")
def api_drop_collection(name: str):
    _connect_milvus()
    if not utility.has_collection(name):
        raise HTTPException(status_code=404, detail="Collection not found")
    utility.drop_collection(name)
    log.info("Collection '%s' dropped", name)
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

    model = _load_sentence_model(req.model)
    texts = [d.text for d in req.docs]
    log.info("Encoding %d docs for insert (model=%s)", len(texts), req.model or "default")
    vecs = model.encode(texts, normalize_embeddings=True).tolist()
    ids = [d.doc_id for d in req.docs]

    coll.insert([ids, texts, vecs])
    try:
        coll.load()
    except Exception as e:
        log.warning("load() after insert warning: %s", e)

    return {"ok": True, "inserted": len(ids), "collection": req.collection}

@api.post("/rag/search")
def api_rag_search(req: RagSearchReq):
    _connect_milvus()
    if not utility.has_collection(req.collection):
        raise HTTPException(status_code=404, detail="Collection not found")

    coll = Collection(req.collection)
    model = _load_sentence_model(req.model)
    qv = model.encode([req.query], normalize_embeddings=True).tolist()

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

    log.info("Search collection=%s field=%s params=%s", req.collection, vec_field, params)
    res = coll.search(qv, vec_field, param=params, limit=req.topk, output_fields=fields)

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

    log.info("SYNC: source_root=%s", source_root)
    try:
        r1 = run([ingest_exe, "--source-root", source_root], check=True, capture_output=True, text=True, cwd=root)
        r2 = run([create_exe], check=True, capture_output=True, text=True, cwd=root)
        log.info("SYNC complete")
        return {"ok": True, "logs": {"ingest": r1.stdout[-4000:], "create": r2.stdout[-4000:]}}
    except CalledProcessError as e:
        err = (e.stderr or str(e))
        log.error("SYNC failed: %s", err)
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
    overlap: int = Form(64),
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

    log.info("Upload saved for collection=%s; job=%s; dest=%s; files=%d; bytes=%d",
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

# Entrypoint
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("UI_PORT", "7860"))
    log.info("* Milvus Admin UI: http://127.0.0.1:%s", port)
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
