#!/usr/bin/env python3
"""
End-to-end test for Milvus Admin UI (ui/server.py) with stage tracking & logs.

What it does:
  1) /api/ping health check
  2) /api/status snapshot
  3) fetch /api/rag/models and pick a model
  4) DROP 'documents' collection if it exists (for clean state)
  5) CREATE 'documents' collection (dim inferred from model)
  6) create data/test.md with a unique tag
  7) insert the doc via /api/rag/insert
  8) search via /api/rag/search and verify the unique tag is found

ENV:
  SERVER_URL   (default http://127.0.0.1:7860)
  ADMIN_TOKEN  (optional x-admin-token header)
  TEST_COLLECTION (default documents)
  TEST_QUERY     (default "What is inside test.md?")
  REQ_TIMEOUT  (client timeout seconds; default 300 for first-run model download)
  DEBUG_HTTP   (1 to print request bodies and full responses)
  PRINT_STATUS (1 to pretty-print full /status payload)
"""

import os
import sys
import json
import time
import uuid
from pathlib import Path
from textwrap import shorten

import requests
from requests.exceptions import ReadTimeout

# --- Setup & Config ---

try:
    import colorama
    colorama.init()
    C_HDR = colorama.Fore.MAGENTA + colorama.Style.BRIGHT
    C_OK = colorama.Fore.GREEN + colorama.Style.BRIGHT
    C_FAIL = colorama.Fore.RED + colorama.Style.BRIGHT
    C_WARN = colorama.Fore.YELLOW + colorama.Style.BRIGHT
    C_INFO = colorama.Fore.CYAN
    C_RST = colorama.Style.RESET_ALL
except ImportError:
    C_HDR, C_OK, C_FAIL, C_WARN, C_INFO, C_RST = "", "", "", "", "", ""


SERVER_URL = os.getenv("SERVER_URL", "http://127.0.0.1:7860").rstrip("/")
API = f"{SERVER_URL}/api"
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN")  # only needed for protected endpoints

# Choose a default collection and query
COLLECTION = os.getenv("TEST_COLLECTION", "documents")
QUERY = os.getenv("TEST_QUERY", "What is inside test.md?")

REQ_TIMEOUT = float(os.getenv("REQ_TIMEOUT", "300"))
DEBUG_HTTP = os.getenv("DEBUG_HTTP", "0") in {"1", "true", "yes", "y"}
PRINT_STATUS = os.getenv("PRINT_STATUS", "0") in {"1", "true", "yes", "y"}

def _print_json(title, data):
    print(f"\n{C_INFO}=== {title} ==={C_RST}")
    print(json.dumps(data, indent=2, ensure_ascii=False))

def _headers(base=None):
    headers = dict(base or {})
    if ADMIN_TOKEN:
        headers.setdefault("x-admin-token", ADMIN_TOKEN)
    return headers

def _req(method, path, **kwargs):
    url = f"{API}{path}"
    headers = _headers(kwargs.pop("headers", {}))
    data_for_log = None

    if "json" in kwargs:
        data_for_log = kwargs["json"]
    elif "data" in kwargs:
        data_for_log = kwargs["data"]

    if DEBUG_HTTP and data_for_log is not None:
        short = json.dumps(data_for_log) if not isinstance(data_for_log, (str, bytes)) else str(data_for_log)
        print(f"\n{C_INFO}-- HTTP {method} {path} body: {short[:800]}{'...' if len(short) > 800 else ''}{C_RST}")

    t0 = time.time()
    try:
        resp = requests.request(method, url, headers=headers, timeout=REQ_TIMEOUT, **kwargs)
    except ReadTimeout as e:
        dt = time.time() - t0
        print(f"\n{C_FAIL}!! TIMEOUT after {dt:.1f}s: {method} {url}{C_RST}")
        print("   This often happens on the FIRST /rag/insert because the model is downloading & initializing.")
        print("   Remedies:")
        print("   - export RAG_DEVICE=cpu (or CUDA-visible device if properly configured)")
        print("   - export RAG_PRELOAD=1 and restart the server (if server is patched)")
        print("   - increase client timeout: REQ_TIMEOUT=600")
        print("   - ensure outbound internet to Hugging Face is allowed (first run)")
        raise
    except requests.ConnectionError as e:
        print(f"\n{C_FAIL}!! CONNECTION FAILED: {method} {url}{C_RST}")
        print(f"   {C_FAIL}Error: {e}{C_RST}")
        print(f"   Is the server running at {SERVER_URL}?")
        raise

    dt = time.time() - t0
    ct = resp.headers.get("content-type", "")
    status_color = C_OK if resp.ok else C_FAIL
    status = f"{resp.status_code} {resp.reason or ''}".strip()
    print(f"{C_INFO}-- HTTP {method} {path} -> {status_color}{status}{C_RST} in {dt:.2f}s")

    try:
        resp.raise_for_status()
    except requests.HTTPError:
        print(f"{C_FAIL}Body: {resp.text[:800]}{'...' if len(resp.text) > 800 else ''}{C_RST}", file=sys.stderr)
        raise

    if "application/json" in ct:
        j = resp.json()
        if DEBUG_HTTP:
            _print_json(f"Response {method} {path}", j)
        return j
    else:
        if DEBUG_HTTP:
            print(f"Response text: {resp.text[:800]}{'...' if len(resp.text) > 800 else ''}")
        return resp.text

class Stage:
    def __init__(self):
        self.idx = 0
        self.t0 = None
        self.name = None

    def start(self, name):
        self.idx += 1
        self.t0 = time.time()
        self.name = name
        print(f"\n{C_HDR}▶▶ STAGE {self.idx}: {name}{C_RST}")

    def end(self, extra=None):
        if self.t0 is None:
            return
        dt = time.time() - self.t0
        suffix = f" — {C_INFO}{extra}{C_RST}" if extra else ""
        print(f"{C_OK}◀◀ STAGE {self.idx} DONE{C_RST} in {dt:.2f}s{suffix}")
        self.t0 = None
        self.name = None

def wait_for_server(timeout=30):
    print(f"{C_INFO}* Waiting for server at {API}/ping...{C_RST}", end="", flush=True)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            j = _req("GET", "/ping")
            if isinstance(j, dict) and j.get("ok"):
                print(f" {C_OK}OK!{C_RST}")
                return True
        except Exception:
            pass
        print(".", end="", flush=True)
        time.sleep(0.5)
    
    print(f" {C_FAIL}FAIL!{C_RST}")
    raise RuntimeError(f"Server did not respond to /api/ping in {timeout}s. Is server.py running?")

def main():
    stage = Stage()
    print(f"{C_INFO}* Using server: {SERVER_URL}{C_RST}")
    print(f"{C_INFO}* Using client timeout: {REQ_TIMEOUT}s (override with REQ_TIMEOUT){C_RST}")
    if DEBUG_HTTP:
        print(f"{C_WARN}* DEBUG_HTTP is ON{C_RST}")

    stage.start("Ping /api/ping")
    wait_for_server()
    stage.end()

    stage.start("Status snapshot /api/status")
    status = _req("GET", "/status")
    if PRINT_STATUS:
        _print_json("Status", status)
    else:
        _print_json("Status (summary)", {k: status.get(k) for k in ["connected","target","server_version","milvus_healthz_http"]})
    stage.end()

    stage.start("Fetch models /api/rag/models")
    models = _req("GET", "/rag/models").get("models", [])
    if not models:
        raise RuntimeError("No models returned by /api/rag/models")
    model_id = models[0]["id"]
    dim = int(models[0]["dim"])
    print(f"* Using model: {model_id} (dim={dim})")
    stage.end(f"model={model_id}")

    # --- FIX: Drop collection first to ensure a clean state ---
    stage.start(f"Drop collection '{COLLECTION}' (if exists)")
    try:
        _req("DELETE", f"/collections/{COLLECTION}")
    except requests.HTTPError as e:
        if e.response.status_code == 404:
            print(f"{C_INFO}-- Collection did not exist, skipping drop.{C_RST}")
        else:
            raise  # Re-raise other errors
    stage.end("Cleanup OK")

    stage.start(f"Create collection '{COLLECTION}'")
    j = _req("POST", "/collections", json={"name": COLLECTION, "model": model_id})
    _print_json("Create collection", j)
    stage.end()

    stage.start("Write data/test.md")
    repo_root = Path(__file__).resolve().parents[1]
    data_dir = repo_root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    unique_tag = uuid.uuid4().hex[:8]
    content = f"""# Test Document

This is a test document for Milvus Admin UI E2E run.
Unique tag: {unique_tag}

We expect RAG search to find this text when we query about 'Unique tag'.
"""
    doc_path = data_dir / "test.md"
    doc_path.write_text(content, encoding="utf-8")
    print(f"* Wrote {doc_path} ({len(content)} bytes)")
    print(f"* {C_WARN}Unique Tag for this run: {unique_tag}{C_RST}")
    stage.end()

    stage.start("Insert via /api/rag/insert (first run may download the model)")
    j = _req("POST", "/rag/insert", json={
        "collection": COLLECTION,
        "docs": [{"doc_id": "test.md", "text": content}],
        "model": model_id
    })
    _print_json("Insert", j)
    stage.end()

    # Optional: show collection details after insert
    stage.start(f"Collection details /api/collections/{COLLECTION}")
    coll_info = _req("GET", f"/collections/{COLLECTION}")
    _print_json("Collection", {k: coll_info.get(k) for k in ["name","num_entities","schema_info"]})
    stage.end()

    stage.start("Search via /api/rag/search")
    j = _req("POST", "/rag/search", json={
        "collection": COLLECTION,
        "query": f"Find the document with Unique tag {unique_tag}",
        "topk": 3,
        "model": model_id,
        "output_fields": ["doc_id", "text"]
    })
    hits = j.get("hits", [])
    print(f"\n{C_INFO}=== Search hits ==={C_RST}")
    if not hits:
        print(f"{C_WARN}No results found.{C_RST}")
    else:
        for i, h in enumerate(hits, 1):
            text = h.get("text","")
            print(f"{i}. score={h.get('score'):.4f} doc_id={h.get('doc_id')}")
            print(f"   {C_INFO}text:{C_RST}", shorten(str(text).replace("\n"," "), width=160, placeholder="..."))
    stage.end()

    # Assert pass/fail
    found = False
    if hits:
        found = any(str(unique_tag) in (h.get("text") or "") for h in hits)
    
    if not found:
        print(f"\n{C_FAIL}❌ Test failed: unique tag '{unique_tag}' not found in hits.{C_RST}")
        print("   This may be due to: 1) Insert/upsert failed 2) Search failed 3) Index not updated")
        raise SystemExit(2)

    print(f"\n{C_OK}✅ OK: end-to-end insert + search workflow succeeded.{C_RST}")

if __name__ == "__main__":
    try:
        main()
    except ReadTimeout:
        # Provide targeted debugging help on exit
        print(f"\n{C_FAIL}--- READ TIMEOUT DEBUG HELP ---{C_RST}")
        print("• First call that encodes text will download & initialize the model.")
        print("• Try:")
        print("  - export RAG_DEVICE=cpu")
        print("  - export RAG_PRELOAD=1  (server preloads model on startup if you applied the server patch)")
        print("  - REQ_TIMEOUT=600 scripts/test_workflow.sh")
        print("  - Ensure outbound internet to Hugging Face on first run.")
        raise
    except Exception as e:
        print(f"\n{C_FAIL}--- TEST FAILED ---{C_RST}")
        print(f"{C_FAIL}Error: {e}{C_RST}")
        # Re-raise with original traceback
        raise
