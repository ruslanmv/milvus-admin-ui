#!/usr/bin/env bash
set -euo pipefail

# Colors
C_GREEN="\033[1;32m"; C_YELLOW="\033[1;33m"; C_CYAN="\033[1;36m"; C_RED="\033[1;31m"; C_NC="\033[0m"
C_WARN="$C_YELLOW"; C_FAIL="$C_RED"

# Config
: "${DOCS_DIR:=}"
: "${REQ_TIMEOUT:=120}"
: "${DEBUG_DOCLING:=0}"
: "${DOCLING_TEST_FAST:=1}"        # fast defaults for CI
: "${DOCS_MAX:=300}"
: "${DOCS_SAMPLE:=0}"
: "${SKIP_STREAMING_PARITY:=0}"
: "${DOCLING_TEST_NO_PDF:=1}"
: "${EXTRACT_LOG_LEVEL:=INFO}"     # INFO|DEBUG for deep profiling

: "${CHUNK_SIZE:=128}"
: "${OVERLAP:=16}"
: "${LANGUAGE_DETECT:=1}"
: "${DEDUPE:=1}"
: "${OCR:=0}"

# Fast mode overrides
if [[ "$DOCLING_TEST_FAST" == "1" ]]; then
  CHUNK_SIZE="${CHUNK_SIZE:-256}"
  OVERLAP=0
  LANGUAGE_DETECT=0
  DOCLING_TEST_NO_PDF="${DOCLING_TEST_NO_PDF:-1}"
  SKIP_STREAMING_PARITY="${SKIP_STREAMING_PARITY:-1}"
  DOCS_MAX="${DOCS_MAX:-200}"
fi

export DOCS_DIR REQ_TIMEOUT DEBUG_DOCLING CHUNK_SIZE OVERLAP LANGUAGE_DETECT DEDUPE OCR
export DOCLING_TEST_FAST DOCS_MAX DOCS_SAMPLE SKIP_STREAMING_PARITY DOCLING_TEST_NO_PDF
export EXTRACT_LOG_LEVEL

echo -e "${C_GREEN}* Docling Conversion Smoke Test${C_NC}"
echo -e "${C_CYAN}--------------------------------------${C_NC}"
echo -e "* DOCS_DIR        = ${DOCS_DIR:-'(auto-generate samples)'}"
echo -e "* REQ_TIMEOUT     = $REQ_TIMEOUT"
echo -e "* FAST_MODE       = $DOCLING_TEST_FAST"
echo -e "* DOCS_MAX        = $DOCS_MAX"
echo -e "* DOCS_SAMPLE     = $DOCS_SAMPLE"
echo -e "* SKIP_STREAMING  = $SKIP_STREAMING_PARITY"
echo -e "* NO_PDF          = $DOCLING_TEST_NO_PDF"
echo -e "* CHUNK_SIZE      = $CHUNK_SIZE"
echo -e "* OVERLAP         = $OVERLAP"
echo -e "* LANGUAGE_DETECT = $LANGUAGE_DETECT"
echo -e "* DEDUPE          = $DEDUPE"
echo -e "* OCR             = $OCR"
echo -e "* EXTRACT_LOG_LEVEL = $EXTRACT_LOG_LEVEL"
echo -e "${C_CYAN}--------------------------------------${C_NC}"
echo

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
TEST_SCRIPT_PATH="$SCRIPT_DIR/../tests/test_docling.py"
if [[ ! -f "$TEST_SCRIPT_PATH" ]]; then
  echo -e "${C_FAIL}Error: Test script not found at $TEST_SCRIPT_PATH${C_NC}"
  exit 1
fi

# Python
if command -v python3 &>/dev/null; then PYTHON_CMD="python3"
elif command -v python &>/dev/null; then PYTHON_CMD="python"
else echo -e "${C_FAIL}Error: No 'python3' or 'python' found.${C_NC}"; exit 1; fi

# Modules
if ! $PYTHON_CMD - <<'PY' &>/dev/null
import importlib
importlib.import_module("docling")
PY
then
  echo -e "${C_FAIL}Error: 'docling' not installed.${C_NC}"
  echo -e "${C_WARN}Install with:${C_NC} pip install docling==2.60.0"
  exit 1
fi

if ! $PYTHON_CMD -c "import fitz" &>/dev/null; then
  echo -e "${C_WARN}Note: 'PyMuPDF' (fitz) not found. PDF generation will be skipped if enabled.${C_NC}"
fi

# timeout wrapper
TIMEOUT_BIN=""
if command -v timeout &>/dev/null; then TIMEOUT_BIN="timeout"
elif command -v gtimeout &>/dev/null; then TIMEOUT_BIN="gtimeout"; fi

if [[ -n "$TIMEOUT_BIN" ]]; then
  exec "$TIMEOUT_BIN" "$REQ_TIMEOUT" "$PYTHON_CMD" -u "$TEST_SCRIPT_PATH"
else
  echo -e "${C_WARN}Note: 'timeout' not found; running without time limit.${C_NC}"
  exec "$PYTHON_CMD" -u "$TEST_SCRIPT_PATH"
fi
