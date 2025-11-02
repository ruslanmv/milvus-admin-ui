<h1 align="center">milvus-admin-ui</h1>

<p align="center">
  <b>Manage, Ingest & RAG with your Vector DB in minutes</b><br/>
  FastAPI + React + Ant Design admin with browser uploads, background jobs, and a clean REST API.
</p>

<p align="center">
  <a href="https://github.com/ruslanmv/milvus-admin-ui/stargazers">
    <img src="https://img.shields.io/github/stars/ruslanmv/milvus-admin-ui?style=flat-square" alt="GitHub Stars"/>
  </a>
  <a href="https://github.com/ruslanmv/milvus-admin-ui/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License"/>
  </a>
  <img src="https://img.shields.io/badge/python-3.11-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python 3.11"/>
  <img src="https://img.shields.io/badge/FastAPI-0.110+-009688?style=flat-square&logo=fastapi&logoColor=white" alt="FastAPI"/>
  <img src="https://img.shields.io/badge/Vector%20DB-Milvus%202.4.x-21D789?style=flat-square" alt="Milvus"/>
  <img src="https://img.shields.io/badge/Frontend-React%20%2B%20Ant%20Design-1677FF?style=flat-square" alt="React + Ant Design"/>
</p>

<p align="center">
  Crafted by <a href="#" target="_blank">Ruslan Magana Vsevolodovna</a> · ⭐ <a href="https://github.com/ruslanmv/milvus-admin-ui" target="_blank">Star the repo</a>
</p>

![](assets/2025-11-02-14-36-46.png)
---

## ✨ What you get

- 🧭 **Status & health** — server version, healthz, collections, indexes, and entity counts.
- 🧰 **Collection management** — create/drop, metric (IP/L2/COSINE), index (IVF/HNSW/AUTOINDEX).
- 🚀 **RAG demo** — quick insert & search with sentence-transformers, model auto-selection.
- 📥 **File Ingestion Wizard** — **browser uploads** with live **upload** and **processing** progress, plus server-side sync.
- 🌐 **Multiple sources** — Browser, Local folder (server), HTTP URLs, S3, IBM COS (config generator).
- 🧵 **Background jobs** — `/api/jobs/{id}` live progress (stages: saved → ingest → index → done) and log tails.
- 🧪 **Model-aware UX** — backend exposes model catalog + dims; UI keeps the embedding dimension in sync.
- 🔐 **Security controls** — `X-Admin-Token`, `ALLOW_REMOTE_UPLOAD`, `ALLOW_REMOTE_SYNC`.
- ⚙️ **Batteries included** — minimal env config, zero-setup defaults, Docker-friendly.

---

## ⚡ Quick Start

> **Goal:** up and running in **two commands**. Milvus via Docker, backend serves the UI.

```bash
# 1) Install & prepare (creates venv, installs backend)
make install
````

```bash
# 2) Run: starts Milvus stack and the milvus-admin-ui API+UI
make run
# ➜ http://127.0.0.1:7860
```

> **No Make?** Use the raw steps:
>
> ```bash
> python3.11 -m venv .venv && source .venv/bin/activate
> pip install -U pip && pip install -e .
> docker compose -f milvus.docker-compose.yml up -d
> python ui/server.py
> ```

> **(Optional) Build frontend:** `npm i && npm run build` (outputs to `ui/static`).

---

## ⚙️ Configuration

Create a minimal `.env` (defaults shown):

```ini
# --- Vector DB (Milvus) ---
MILVUS_HOST=127.0.0.1
MILVUS_PORT=19530
MILVUS_HEALTH_PORT=9091
# MILVUS_URI=                  # alternative to host/port (e.g., http://host:19530)
# MILVUS_USER=
# MILVUS_PASSWORD=
# MILVUS_DB=

# --- Server / UI ---
UI_PORT=7860

# --- Ingest defaults ---
RAG_MODEL=sentence-transformers/all-MiniLM-L6-v2
DATA_SOURCE_ROOT=./data           # server-side source root
UPLOAD_WORKDIR=./uploads          # where browser uploads are stored

# --- Search tuning (optional) ---
MILVUS_NPROBE=10
MILVUS_EF=64

# --- Security ---
ALLOW_REMOTE_UPLOAD=true          # enable browser uploads from other hosts
ALLOW_REMOTE_SYNC=false           # keep /api/sync local-only by default
# ADMIN_TOKEN=change-me           # require X-Admin-Token for /api/ingest/* and /api/sync
```

---

## 🧙 Ingestion Wizard (How it works)

1. **Choose source** — Upload from browser, Local, HTTP, S3, IBM COS.
2. **Set options** — embedding model, chunk size/overlap, OCR, language detect, dedupe.
3. **Review** — confirm files & options; for cloud sources, download a ready-to-run JSON config.
4. **Run** — see **Upload** progress (bytes) and **Processing** progress (background job) with live logs.

**Flow (Mermaid):**

```mermaid
graph TD
    A[Browser files] -->|multipart/form-data| B[/api/ingest/upload/]
    B -->|save to UPLOAD_WORKDIR| C[Background Job]
    C --> D["mui-ingest --source-root <job_dir>"]
    D --> E[mui-create-vectordb]
    E --> F[Milvus Collection + Index]
    C -->|/api/jobs/{id}| G[UI: progress bars + logs]
```

---

## 🔌 API Reference (cURL)

**List status**

```bash
curl -s http://127.0.0.1:7860/api/status | jq .
```

**Create a collection (JSON or form-encoded)**

```bash
curl -X POST http://127.0.0.1:7860/api/collections \
  -H "Content-Type: application/json" \
  -d '{"name":"documents","dim":384,"metric":"IP","index_type":"IVF_FLAT","nlist":1024}'
```

**Upload a file and trigger ingest**

```bash
curl -X POST http://127.0.0.1:7860/api/ingest/upload \
  -F "collection=documents" \
  -F "model=sentence-transformers/all-MiniLM-L6-v2" \
  -F "chunk_size=512" -F "overlap=64" \
  -F "normalize=true" -F "ocr=false" -F "language_detect=true" -F "dedupe=true" \
  -F "files=@/path/to/Guide.pdf"
# -> {"ok":true,"job":{"id":"abcd1234",...}}
```

**Track job**

```bash
curl http://127.0.0.1:7860/api/jobs/abcd1234
```

---

## 🧪 RAG Demo (Insert & Search)

**Python (requests)**

```python
import requests, json
BASE = "http://127.0.0.1:7860"

# Insert two demo docs for the simple [doc_id, text, vec] schema
requests.post(f"{BASE}/api/rag/insert", json={
  "collection":"documents",
  "docs":[
    {"doc_id":"1","text":"How do I reset my LDAP password?"},
    {"doc_id":"2","text":"Postmortem template for production incidents."}
  ]
})

# Semantic search
r = requests.post(f"{BASE}/api/rag/search", json={
  "collection":"documents", "query":"Where is the incident template?", "topk":3
})
print(json.dumps(r.json(), indent=2))
```

**PyMilvus (raw search with your own embeddings)**

```python
from pymilvus import connections, Collection
from sentence_transformers import SentenceTransformer

connections.connect(host="127.0.0.1", port="19530")
c = Collection("documents"); c.load()

model = SentenceTransformer("sentence-transformers/paraphrase-MiniLM-L6-v2")
qv = model.encode(["incident template"], normalize_embeddings=True).tolist()
res = c.search(qv, "vec", param={"nprobe":10}, limit=5, output_fields=["doc_id","text"])
for hits in res:
    for h in hits:
        print(h.score, h.entity.get("doc_id"), h.entity.get("text"))
```

---

## 🔐 Security

* Set **`ADMIN_TOKEN`** in `.env` and send it as **`X-Admin-Token`** for `/api/ingest/*` and `/api/sync`.
* Control exposure:

  * `ALLOW_REMOTE_UPLOAD=true|false` (default **true**)
  * `ALLOW_REMOTE_SYNC=true|false` (default **false**)
* Put the service behind a reverse proxy (TLS), restrict CORS/origins in production.

---

## 🛠️ Troubleshooting

* **422 on `/api/ingest/upload`**
  Do **not** force `Content-Type` manually; let your client set `multipart/form-data` with a boundary.

* **`Form data requires "python-multipart"`**
  Install: `pip install python-multipart`.

* **Milvus not reachable**
  Ensure Docker stack is healthy. `curl http://127.0.0.1:9091/healthz` should return **200**. Check `MILVUS_HOST/PORT`.

* **Embedding dimension mismatch**
  Use the model list in the UI; dims are shown and enforced.

* **Slow browser uploads**
  Prefer S3/IBM COS with the generated config; run ingestion server-side.

---

## 🤝 Contributing

PRs welcome! Please:

* Keep endpoints simple and documented.
* Add models to the server’s catalog when needed.
* Prefer small, focused changes with good DX.

---

## 📄 License & Support

**License:** Apache-2.0 © 2025 Ruslan Magana Vsevolodovna
Issues & feature requests: [https://github.com/ruslanmv/milvus-admin-ui/issues](https://github.com/ruslanmv/milvus-admin-ui/issues)
If this saved you time, **please ⭐ star the repo**: [https://github.com/ruslanmv/milvus-admin-ui](https://github.com/ruslanmv/milvus-admin-ui)

