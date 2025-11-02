# ui/extraction.py
# Turn heterogeneous documents into Markdown → text chunks using Docling.
# Now instrumented with fine-grained timing logs & aggregated stats.

from __future__ import annotations

import hashlib
import os
import re
import threading
import csv
import json
import time
import logging
from dataclasses import dataclass
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Iterable, Iterator, List, Optional, Union, Tuple

# ----------------- logging setup -----------------
_LOG = logging.getLogger("extraction")


def _setup_logger():
    # Respect existing app logging; only attach our handler if none present.
    if _LOG.handlers:
        return
    lvl = os.getenv("EXTRACT_LOG_LEVEL", "INFO").upper()
    try:
        level = getattr(logging, lvl)
    except Exception:
        level = logging.INFO
    _LOG.setLevel(level)
    h = logging.StreamHandler()
    fmt = logging.Formatter("%(asctime)s | %(levelname)s | extraction | %(message)s")
    h.setFormatter(fmt)
    _LOG.addHandler(h)
    # Prevent double logging via root handlers
    _LOG.propagate = False


_setup_logger()

# ----------------- optional deps -----------------
try:
    from langdetect import detect as _detect_lang  # type: ignore
except Exception:
    _detect_lang = None  # type: ignore

from docling.document_converter import DocumentConverter  # type: ignore
try:
    from docling.datamodel.document import InputDocument  # type: ignore  # noqa: F401
except Exception:
    InputDocument = None  # type: ignore

try:
    from docling.utils.export import (  # type: ignore
        ExportToMarkdownOptions,
        export_to_markdown,
    )
except Exception:
    ExportToMarkdownOptions = None  # type: ignore
    export_to_markdown = None  # type: ignore


# --- robust docling version detection (for logs/diagnostics) ---
def _docling_version() -> str:
    try:
        from importlib.metadata import version  # Python 3.8+
        return version("docling")
    except Exception:
        pass
    try:
        import docling  # type: ignore

        v = getattr(docling, "__version__", None)
        if v:
            return str(v)
    except Exception:
        pass
    return "unknown"


# ----------------- constants -----------------
PathLike = Union[str, os.PathLike]

SUPPORTED_EXTS = {
    ".pdf",
    ".doc",
    ".docx",
    ".ppt",
    ".pptx",
    ".txt",
    ".md",
    ".mdx",
    ".rtf",
    ".html",
    ".htm",
    ".csv",
    ".json",
    ".jsonl",
    ".epub",
    ".xls",
    ".xlsx",
    ".png",
    ".jpg",
    ".jpeg",
    ".tif",
    ".tiff",
    ".bmp",
    ".gif",
    ".webp",
}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp"}
NATIVE_EXTS = {".txt", ".md", ".mdx", ".csv", ".json", ".jsonl"}

# ----------------- options & chunk model -----------------
@dataclass
class IngestOptions:
    chunk_size: int = 512
    overlap: int = 64
    ocr: bool = False
    language_detect: bool = True
    dedupe: bool = True
    min_chars: int = 12  # drop tiny/noisy fragments


@dataclass
class Chunk:
    text: str
    meta: Dict[str, str]

    def stable_id(self) -> str:
        h = hashlib.sha1()
        h.update((self.text or "").encode("utf-8", errors="ignore"))
        for k in ("source", "page", "section", "title"):
            v = self.meta.get(k)
            if v:
                h.update(f"|{k}:{v}".encode("utf-8", errors="ignore"))
        return h.hexdigest()


__all__ = [
    "IngestOptions",
    "Chunk",
    "SUPPORTED_EXTS",
    "convert_paths",
    "convert_paths_parallel",
    "iter_convert_paths",
    "walk_supported_files",
    "get_converter",
    "get_stats_snapshot",
    "reset_stats",
]

# ----------------- metrics & timing -----------------
from collections import defaultdict

_STATS_LOCK = threading.Lock()
_STATS = {
    "files_total": 0,
    "files_docling": 0,
    "files_native": 0,
    "bytes_read": 0,
    "chunks_total": 0,
    "time_converter_init": 0.0,
    "time_docling_convert": 0.0,
    "time_docling_export": 0.0,
    "time_native_io": 0.0,
    "time_chunking": 0.0,
    "time_dedupe": 0.0,
    "time_langdetect": 0.0,
    "ext_counts": defaultdict(int),  # ext -> count
}


def _acc(key: str, val: float | int):
    with _STATS_LOCK:
        if key.startswith("time_") or key.endswith("_total"):
            _STATS[key] += float(val)
        elif key in (
            "files_total",
            "files_docling",
            "files_native",
            "bytes_read",
            "chunks_total",
        ):
            _STATS[key] += int(val)
        else:
            _STATS[key] = _STATS.get(key, 0) + val


def _inc_ext(ext: str):
    with _STATS_LOCK:
        _STATS["ext_counts"][ext] += 1


def get_stats_snapshot() -> Dict:
    with _STATS_LOCK:
        return {
            **{
                k: (v if not isinstance(v, float) else round(v, 4))
                for k, v in _STATS.items()
                if k != "ext_counts"
            },
            "ext_counts": dict(_STATS["ext_counts"]),
        }


def reset_stats():
    with _STATS_LOCK:
        for k in list(_STATS.keys()):
            if k == "ext_counts":
                _STATS[k].clear()
            elif isinstance(_STATS[k], (int, float)):
                _STATS[k] = 0


class _Timer:
    def __init__(self, key: Optional[str] = None):
        self.key = key
        self.t0 = 0.0
        self.dt = 0.0

    def __enter__(self):
        self.t0 = time.perf_counter()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.dt = time.perf_counter() - self.t0
        if self.key:
            _acc(self.key, self.dt)


# ----------------- converter reuse -----------------
_CONVERTER_SINGLETON: Optional[DocumentConverter] = None
_CONVERTER_LOCK = threading.Lock()


def get_converter() -> DocumentConverter:
    """Singleton Docling converter (cheap & reused across calls)."""
    global _CONVERTER_SINGLETON
    if _CONVERTER_SINGLETON is None:
        with _CONVERTER_LOCK:
            if _CONVERTER_SINGLETON is None:
                with _Timer("time_converter_init"):
                    _CONVERTER_SINGLETON = DocumentConverter()
                _LOG.info(
                    "Docling %s converter initialized (%.3fs)",
                    _docling_version(),
                    get_stats_snapshot()["time_converter_init"],
                )
    return _CONVERTER_SINGLETON


# ----------------- core API -----------------
def convert_paths(
    paths: Iterable[PathLike],
    opt: IngestOptions,
    *,
    converter: Optional[DocumentConverter] = None,
) -> List[Chunk]:
    """Eager conversion: returns list[Chunk]. Logs per-file breakdown + aggregate."""
    conv = converter or get_converter()
    out: List[Chunk] = []

    p_list = [str(p) for p in paths]
    _acc("files_total", len(p_list))

    for p in p_list:
        ext = Path(p).suffix.lower()
        _inc_ext(ext)
        if not _is_supported(p):
            _LOG.debug("Skip unsupported: %s", p)
            continue
        if (ext in IMAGE_EXTS) and not opt.ocr:
            _LOG.debug("Skip image without OCR: %s", p)
            continue

        per = {"convert": 0.0, "export": 0.0, "native": 0.0, "chunk": 0.0}
        chunks_before = len(out)

        if ext in NATIVE_EXTS:
            with _Timer("time_native_io") as t:
                md, meta = _native_to_markdown(p, opt)
            per["native"] = t.dt
            _acc("files_native", 1)
        else:
            with _Timer("time_docling_convert") as t_conv:
                res = _conv_with_fallback(conv, p)
            per["convert"] = t_conv.dt
            md = _export_markdown(res)
            per["export"] = md[1]  # md tuple returns (text, export_time)
            md, meta = md[0], {
                "source": str(Path(p).resolve()),
                "filename": Path(p).name,
                "ext": ext,
            }
            _acc("files_docling", 1)

        with _Timer("time_chunking") as t_chunk:
            for c in _chunk_markdown(md, meta, opt):
                if len(c.text) >= opt.min_chars:
                    out.append(c)
        per["chunk"] = t_chunk.dt

        size_b = 0
        try:
            size_b = Path(p).stat().st_size
        except Exception:
            pass
        _acc("bytes_read", size_b)

        added = len(out) - chunks_before
        _acc("chunks_total", added)
        _LOG.info(
            "Processed file=%s ext=%s mode=%s bytes=%s chunks=%s "
            "t_native=%.3fs t_convert=%.3fs t_export=%.3fs t_chunk=%.3fs",
            Path(p).name,
            ext,
            "native" if ext in NATIVE_EXTS else "docling",
            size_b,
            added,
            per["native"],
            per["convert"],
            per["export"],
            per["chunk"],
        )

    # de-dup once at the end (cheapest)
    if opt.dedupe and out:
        with _Timer("time_dedupe"):
            out = _dedupe(out)

    # language detect on a sample of chunks (faster)
    if opt.language_detect and out:
        sample_text = "\n\n".join(c.text for c in out[:50])
        with _Timer("time_langdetect"):
            lang = _detect_language(sample_text)
        for c in out:
            c.meta.setdefault("lang", lang)

    snap = get_stats_snapshot()
    _LOG.info(
        "Summary: files=%d (docling=%d native=%d) chunks=%d bytes=%d "
        "t_init=%.3fs t_conv=%.3fs t_export=%.3fs t_native=%.3fs t_chunk=%.3fs t_dedupe=%.3fs t_lang=%.3fs",
        snap["files_total"],
        snap["files_docling"],
        snap["files_native"],
        snap["chunks_total"],
        snap["bytes_read"],
        snap["time_converter_init"],
        snap["time_docling_convert"],
        snap["time_docling_export"],
        snap["time_native_io"],
        snap["time_chunking"],
        snap["time_dedupe"],
        snap["time_langdetect"],
    )
    _LOG.debug("Ext counts: %s", snap["ext_counts"])
    return out


def convert_paths_parallel(
    paths: Iterable[PathLike],
    opt: IngestOptions,
    *,
    workers: Optional[int] = None,
) -> List[Chunk]:
    """
    Convert files in parallel. Each worker builds its own converter (thread-local)
    to avoid cross-thread sharing. Good for large batches of mixed docs.
    """
    if workers is None or workers <= 1:
        return convert_paths(paths, opt)

    _LOG.info("Parallel conversion start (workers=%d)", workers)
    tl = threading.local()

    def _ensure_conv() -> DocumentConverter:
        if getattr(tl, "conv", None) is None:
            with _Timer("time_converter_init"):
                tl.conv = DocumentConverter()
        return tl.conv

    def _one(path: str) -> Tuple[str, List[Chunk]]:
        ext = Path(path).suffix.lower()
        if not _is_supported(path):
            return ext, []
        if (ext in IMAGE_EXTS) and not opt.ocr:
            return ext, []
        if ext in NATIVE_EXTS:
            with _Timer():
                md, meta = _native_to_markdown(path, opt)
        else:
            conv = _ensure_conv()
            with _Timer("time_docling_convert"):
                res = _conv_with_fallback(conv, path)
            md, _t = _export_markdown(res)
            meta = {
                "source": str(Path(path).resolve()),
                "filename": Path(path).name,
                "ext": ext,
            }
        outs: List[Chunk] = []
        with _Timer("time_chunking"):
            for c in _chunk_markdown(md, meta, opt):
                if len(c.text) >= opt.min_chars:
                    outs.append(c)
        return ext, outs

    out: List[Chunk] = []
    p_list = [str(p) for p in paths]
    _acc("files_total", len(p_list))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(_one, p): p for p in p_list}
        for fut in as_completed(futs):
            ext, chunks = fut.result()
            _inc_ext(ext)
            if ext in NATIVE_EXTS:
                _acc("files_native", 1)
            elif ext in SUPPORTED_EXTS:
                _acc("files_docling", 1)
            out.extend(chunks)
            _acc("chunks_total", len(chunks))
    # de-dupe and lang
    if opt.dedupe and out:
        with _Timer("time_dedupe"):
            out = _dedupe(out)
    if opt.language_detect and out:
        sample_text = "\n\n".join(c.text for c in out[:50])
        with _Timer("time_langdetect"):
            lang = _detect_language(sample_text)
        for c in out:
            c.meta.setdefault("lang", lang)

    snap = get_stats_snapshot()
    _LOG.info(
        "Parallel summary: files=%d (docling=%d native=%d) chunks=%d "
        "t_init=%.3fs t_conv=%.3fs t_export=%.3fs t_native=%.3fs t_chunk=%.3fs t_dedupe=%.3fs t_lang=%.3fs",
        snap["files_total"],
        snap["files_docling"],
        snap["files_native"],
        snap["chunks_total"],
        snap["time_converter_init"],
        snap["time_docling_convert"],
        snap["time_docling_export"],
        snap["time_native_io"],
        snap["time_chunking"],
        snap["time_dedupe"],
        snap["time_langdetect"],
    )
    _LOG.debug("Ext counts: %s", snap["ext_counts"])
    return out


def iter_convert_paths(
    paths: Iterable[PathLike],
    opt: IngestOptions,
    *,
    converter: Optional[DocumentConverter] = None,
) -> Iterator[Chunk]:
    """Streaming conversion: yields chunks progressively; logs per-file summary."""
    conv = converter or get_converter()
    p_list = [str(p) for p in paths]
    _acc("files_total", len(p_list))

    for p in p_list:
        ext = Path(p).suffix.lower()
        _inc_ext(ext)
        if not _is_supported(p):
            _LOG.debug("Skip unsupported: %s", p)
            continue
        if (ext in IMAGE_EXTS) and not opt.ocr:
            _LOG.debug("Skip image without OCR: %s", p)
            continue

        chunks_for_file = 0
        t_native = t_convert = t_export = t_chunk = 0.0

        if ext in NATIVE_EXTS:
            with _Timer("time_native_io") as t:
                md, meta = _native_to_markdown(p, opt)
            t_native = t.dt
            _acc("files_native", 1)
        else:
            with _Timer("time_docling_convert") as t:
                res = _conv_with_fallback(conv, p)
            t_convert = t.dt
            md, t_export = _export_markdown(res)
            t_export_total = t_export
            t_export = t_export_total
            meta = {"source": str(Path(p).resolve()), "filename": Path(p).name, "ext": ext}
            _acc("files_docling", 1)

        lang = None
        if opt.language_detect:
            with _Timer("time_langdetect"):
                lang = _detect_language(md)

        with _Timer("time_chunking") as t:
            for c in _chunk_markdown(md, meta, opt):
                if len(c.text) < opt.min_chars:
                    continue
                if lang:
                    c.meta.setdefault("lang", lang)
                if opt.ocr:
                    c.meta.setdefault("ocr", "true")
                yield c
                chunks_for_file += 1
                _acc("chunks_total", 1)
        t_chunk = t.dt

        size_b = 0
        try:
            size_b = Path(p).stat().st_size
        except Exception:
            pass
        _acc("bytes_read", size_b)
        _LOG.info(
            "Processed(file/stream) file=%s ext=%s mode=%s bytes=%s chunks=%s "
            "t_native=%.3fs t_convert=%.3fs t_export=%.3fs t_chunk=%.3fs",
            Path(p).name,
            ext,
            "native" if ext in NATIVE_EXTS else "docling",
            size_b,
            chunks_for_file,
            t_native,
            t_convert,
            t_export,
            t_chunk,
        )


# ----------------- helpers -----------------
def walk_supported_files(root: PathLike) -> List[str]:
    root = Path(root)
    out: List[str] = []
    if root.is_file() and _is_supported(str(root)):
        return [str(root)]
    if root.is_dir():
        for p in root.rglob("*"):
            if p.is_file() and _is_supported(p.name):
                out.append(str(p))
    return out


def _is_supported(path: str) -> bool:
    return Path(path).suffix.lower() in SUPPORTED_EXTS


def _native_to_markdown(path: str, opt: IngestOptions) -> Tuple[str, Dict[str, str]]:
    ext = Path(path).suffix.lower()
    meta = {
        "source": str(Path(path).resolve()),
        "filename": Path(path).name,
        "ext": ext,
    }
    t0 = time.perf_counter()
    try:
        if ext in {".txt", ".md", ".mdx"}:
            text = Path(path).read_text(encoding="utf-8", errors="ignore")
            if ext == ".txt" and not text.lstrip().startswith("# "):
                text = "# Document\n" + text
            return text, meta

        if ext == ".json":
            obj = json.loads(Path(path).read_text(encoding="utf-8", errors="ignore"))
            return (
                "```json\n" + json.dumps(obj, indent=2, ensure_ascii=False) + "\n```",
                meta,
            )

        if ext == ".jsonl":
            lines = []
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                for i, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                        lines.append(json.dumps(obj, ensure_ascii=False))
                    except Exception:
                        lines.append(line)
                    if i >= 500:
                        break
            return "# JSON Lines\n" + "\n".join(lines), meta

        if ext == ".csv":
            out = []
            with open(path, newline="", encoding="utf-8", errors="ignore") as f:
                reader = csv.reader(f)
                rows = []
                for i, row in enumerate(reader, 1):
                    rows.append(row)
                    if i >= 500:
                        break
            if rows:
                header = rows[0]
                out.append("| " + " | ".join(header) + " |")
                out.append("| " + " | ".join("---" for _ in header) + " |")
                for r in rows[1:]:
                    out.append("| " + " | ".join(r) + " |")
            return "\n".join(out) or "# CSV (empty)\n", meta
    finally:
        _acc("time_native_io", time.perf_counter() - t0)

    return "", meta


def _conv_with_fallback(conv: "DocumentConverter", path: str):
    # 1) modern
    try:
        return conv.convert(path)
    except TypeError:
        pass
    except Exception:
        pass

    if InputDocument is None:
        raise

    # 2) factory
    try:
        if hasattr(InputDocument, "from_path"):
            inst = InputDocument.from_path(path)  # type: ignore[attr-defined]
            return conv.convert(inst)
    except Exception:
        pass

    # 3) keyword variants
    for kw in ("path", "location", "uri", "file"):
        try:
            inst = InputDocument(**{kw: path})  # type: ignore
            return conv.convert(inst)
        except Exception:
            continue

    # 4) positional
    try:
        inst = InputDocument(path)  # type: ignore
        return conv.convert(inst)
    except Exception as e:
        raise TypeError(
            f"Docling InputDocument fallback failed for '{path}': {e}"
        ) from e


def _export_markdown(res) -> Tuple[str, float]:
    t0 = time.perf_counter()
    md: Optional[str] = None
    if export_to_markdown and ExportToMarkdownOptions:
        try:
            opts = ExportToMarkdownOptions(
                page_titles=True, preserve_lines=False, include_images=False
            )  # type: ignore
            md = export_to_markdown(res.document, opts)  # type: ignore
        except Exception:
            md = None
    if md is None:
        try:
            if hasattr(res.document, "export_to_markdown"):
                md = res.document.export_to_markdown()  # type: ignore[attr-defined]
            elif hasattr(res.document, "to_markdown"):
                md = res.document.to_markdown()  # type: ignore[attr-defined]
            else:
                md = str(res.document)
        except Exception:
            md = ""
    dt = time.perf_counter() - t0
    _acc("time_docling_export", dt)
    return md or "", dt


_MD_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+.*$", re.MULTILINE)


def _split_on_headings(md: str) -> List[str]:
    if not _MD_HEADING_RE.search(md):
        md = "# Document\n" + md
    parts = _MD_HEADING_RE.split(md)
    if parts and parts[0].strip() == "":
        parts = parts[1:]
    return [p.strip() for p in parts if p.strip()]


def _chunk_markdown(md: str, base_meta: Dict[str, str], opt: IngestOptions) -> Iterator[Chunk]:
    size = max(32, int(opt.chunk_size))
    overlap = max(0, int(opt.overlap))
    text = re.sub(r"[ \t]+", " ", (md or "")).strip()
    sections = _split_on_headings(text) or [text]
    for sec_idx, sec in enumerate(sections):
        i = 0
        while i < len(sec):
            j = min(len(sec), i + size)
            snippet = sec[i:j]
            if j < len(sec):
                nl = sec.find("\n", j, min(len(sec), j + 80))
                if nl != -1:
                    snippet = sec[i:nl]
                    j = nl
            meta = dict(base_meta)
            meta["section"] = str(sec_idx)
            m = re.search(r"\bPage\s+(\d+)\b", snippet, re.IGNORECASE)
            if m:
                meta["page"] = m.group(1)
            snippet = snippet.strip()
            if snippet:
                yield Chunk(snippet, meta)
            i = j - overlap if overlap > 0 else j
            if i < 0:
                i = 0


def _sig(text: str) -> str:
    return hashlib.sha1(
        re.sub(r"\s+", " ", (text or "").strip().lower()).encode("utf-8")
    ).hexdigest()


def _dedupe(chunks: List[Chunk]) -> List[Chunk]:
    t0 = time.perf_counter()
    seen: set[str] = set()
    out: List[Chunk] = []
    for c in chunks:
        s = _sig(c.text)
        if s in seen:
            continue
        seen.add(s)
        out.append(c)
    _acc("time_dedupe", time.perf_counter() - t0)
    return out


def _detect_language(text: str) -> str:
    if not _detect_lang:
        return "und"
    try:
        return _detect_lang((text or "")[:10_000]) or "und"
    except Exception:
        return "und"
