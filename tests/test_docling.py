#!/usr/bin/env python3
"""
Docling conversion smoke test using ui/extraction.py, with timing logs & stats.
"""

from __future__ import annotations

import os
import sys
import json
import uuid
import time
import random
import logging
from pathlib import Path
from typing import List

# Colors (optional)
try:
    import colorama
    colorama.init()
    C_OK = colorama.Fore.GREEN + colorama.Style.BRIGHT
    C_FAIL = colorama.Fore.RED + colorama.Style.BRIGHT
    C_WARN = colorama.Fore.YELLOW + colorama.Style.BRIGHT
    C_INFO = colorama.Fore.CYAN
    C_RST = colorama.Style.RESET_ALL
except Exception:
    C_OK = C_FAIL = C_WARN = C_INFO = C_RST = ""

# Ensure we can import ui/extraction regardless of CWD
REPO_ROOT = Path(__file__).resolve().parents[1]
UI_DIR = REPO_ROOT / "ui"
if str(UI_DIR) not in sys.path:
    sys.path.insert(0, str(UI_DIR))

# Logging level (propagate to root so we see our module logs)
lvl = os.getenv("EXTRACT_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, lvl, logging.INFO),
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)

import docling  # type: ignore
import extraction as extraction_tool  # ui/extraction.py

# --- robust docling version detection for the banner ---
def _docling_version() -> str:
    try:
        from importlib.metadata import version
        return version("docling")
    except Exception:
        pass
    try:
        v = getattr(docling, "__version__", None)
        if v:
            return str(v)
    except Exception:
        pass
    return "unknown"

# Optional PDF generator
try:
    import fitz  # PyMuPDF
    HAVE_FITZ = True
except Exception:
    HAVE_FITZ = False

# Fast knobs (env)
DOCS_MAX = int(os.getenv("DOCS_MAX", "300"))
DOCS_SAMPLE = int(os.getenv("DOCS_SAMPLE", "0"))
SKIP_STREAMING_PARITY = os.getenv("SKIP_STREAMING_PARITY", "0").lower() in {"1","true","yes"}
TEST_NO_PDF = os.getenv("DOCLING_TEST_NO_PDF", "0").lower() in {"1","true","yes"}
DEBUG = os.getenv("DEBUG_DOCLING", "0").lower() in {"1","true","yes"}

def _write_samples(samples_dir: Path, unique_tag: str) -> List[str]:
    samples_dir.mkdir(parents=True, exist_ok=True)
    paths: List[str] = []
    (samples_dir / "sample.md").write_text(
        f"# Docling MD Test\n\nThis MD contains UNIQUE_TAG={unique_tag}.\n", encoding="utf-8"
    )
    paths.append(str(samples_dir / "sample.md"))
    (samples_dir / "sample.html").write_text(
        f"<!doctype html><html><body><h1>Docling HTML</h1><p>Hello UNIQUE_TAG={unique_tag}!</p></body></html>",
        encoding="utf-8",
    )
    paths.append(str(samples_dir / "sample.html"))
    (samples_dir / "sample.txt").write_text(
        f"Plain text file with UNIQUE_TAG={unique_tag}\n", encoding="utf-8"
    )
    paths.append(str(samples_dir / "sample.txt"))
    (samples_dir / "sample.json").write_text(
        json.dumps({"note": f"JSON says UNIQUE_TAG={unique_tag}"}), encoding="utf-8"
    )
    paths.append(str(samples_dir / "sample.json"))
    (samples_dir / "sample.csv").write_text(
        f"col1,col2\nhello,UNIQUE_TAG={unique_tag}\n", encoding="utf-8"
    )
    paths.append(str(samples_dir / "sample.csv"))
    if HAVE_FITZ and not TEST_NO_PDF:
        pdf_path = samples_dir / "sample.pdf"
        try:
            doc = fitz.open()
            page = doc.new_page()
            page.insert_text((72, 96), f"PDF created for Docling test. UNIQUE_TAG={unique_tag}")
            doc.save(str(pdf_path))
            doc.close()
            paths.append(str(pdf_path))
        except Exception as e:
            print(f"{C_WARN}PDF generation failed: {e}{C_RST}")
    elif not HAVE_FITZ and not TEST_NO_PDF:
        print(f"{C_WARN}PyMuPDF not installed; skipping PDF sample.{C_RST}")
    return paths

def _filter_supported(files: List[Path]) -> List[str]:
    exts = {e.lower() for e in extraction_tool.SUPPORTED_EXTS}
    out: List[str] = []
    for p in files:
        try:
            if p.is_file() and p.suffix.lower() in exts:
                out.append(str(p))
        except Exception:
            continue
    return out

def _print_stats(label: str):
    snap = extraction_tool.get_stats_snapshot()
    ext_counts = ", ".join(f"{k}:{v}" for k, v in sorted(snap["ext_counts"].items()))
    print(
        f"{C_INFO}{label} :: files={snap['files_total']} docling={snap['files_docling']} native={snap['files_native']} "
        f"chunks={snap['chunks_total']} bytes={snap['bytes_read']} | "
        f"t_init={snap['time_converter_init']:.3f}s t_conv={snap['time_docling_convert']:.3f}s "
        f"t_export={snap['time_docling_export']:.3f}s t_native={snap['time_native_io']:.3f}s "
        f"t_chunk={snap['time_chunking']:.3f}s t_dedupe={snap['time_dedupe']:.3f}s t_lang={snap['time_langdetect']:.3f}s | "
        f"exts=[{ext_counts}]{C_RST}"
    )

def main():
    print(f"{C_INFO}Docling version: {_docling_version()}{C_RST}")
    print(f"{C_INFO}Supported exts (extraction): {sorted(extraction_tool.SUPPORTED_EXTS)}{C_RST}")

    # Options from env
    CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "128"))
    OVERLAP = int(os.getenv("OVERLAP", "16"))
    LANGUAGE_DETECT = os.getenv("LANGUAGE_DETECT", "1").lower() in {"1","true","yes"}
    DEDUPE = os.getenv("DEDUPE", "1").lower() in {"1","true","yes"}
    OCR = os.getenv("OCR", "0").lower() in {"1","true","yes"}

    opts = extraction_tool.IngestOptions(
        chunk_size=CHUNK_SIZE, overlap=OVERLAP, ocr=OCR,
        language_detect=LANGUAGE_DETECT, dedupe=DEDUPE
    )

    # Docs dir (or auto-generate)
    docs_dir_env = os.getenv("DOCS_DIR", "").strip()
    unique_tag = uuid.uuid4().hex[:8]
    if docs_dir_env:
        docs_dir = Path(docs_dir_env)
        if not docs_dir.exists():
            print(f"{C_FAIL}DOCS_DIR not found: {docs_dir}{C_RST}")
            raise SystemExit(1)
        all_files = _filter_supported(list(docs_dir.rglob("*")))
        if DOCS_SAMPLE > 0 and len(all_files) > DOCS_SAMPLE:
            all_files = random.sample(all_files, DOCS_SAMPLE)
        paths = all_files[:DOCS_MAX]
        print(f"{C_INFO}Using DOCS_DIR={docs_dir} with {len(paths)} supported files{C_RST}")
    else:
        samples_dir = REPO_ROOT / "tests" / "_samples_docling"
        paths = _write_samples(samples_dir, unique_tag)
        print(f"{C_INFO}Generated {len(paths)} sample files at {samples_dir}{C_RST}")

    # Reset/prepare stats
    extraction_tool.reset_stats()

    # Reuse one converter
    conv = extraction_tool.get_converter()

    # Eager convert
    t0 = time.perf_counter()
    chunks = extraction_tool.convert_paths(paths, opts, converter=conv)
    dt = time.perf_counter() - t0
    print(f"{C_INFO}convert_paths -> {len(chunks)} chunks in {dt:.2f}s{C_RST}")
    _print_stats("After eager")

    if not docs_dir_env:
        if not any(f"UNIQUE_TAG={unique_tag}" in c.text for c in chunks):
            print(f"{C_FAIL}Unique tag not found in chunks.{C_RST}")
            raise SystemExit(3)

    if os.getenv("DEBUG_DOCLING", "0").lower() in {"1","true","yes"}:
        for i, c in enumerate(chunks[:5], 1):
            snip = (c.text or "").replace("\n", " ")
            if len(snip) > 160: snip = snip[:160] + "..."
            print(f"  [{i}] id={c.stable_id()[:8]} sec={c.meta.get('section','-')} page={c.meta.get('page','-')} :: {snip}")

    # Streaming parity (optional)
    if not SKIP_STREAMING_PARITY:
        extraction_tool.reset_stats()
        t1 = time.perf_counter()
        count_stream = sum(1 for _ in extraction_tool.iter_convert_paths(paths, opts, converter=conv))
        dt2 = time.perf_counter() - t1
        print(f"{C_INFO}iter_convert_paths -> {count_stream} chunks in {dt2:.2f}s{C_RST}")
        _print_stats("After streaming")
        if count_stream != len(chunks):
            print(f"{C_FAIL}Chunk count mismatch: eager={len(chunks)} vs streaming={count_stream}.{C_RST}")
            raise SystemExit(4)

    print(f"{C_OK}✅ Docling conversion test passed.{C_RST}")

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"{C_FAIL}Unexpected error: {e}{C_RST}")
        raise
