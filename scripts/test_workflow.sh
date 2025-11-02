#!/usr/bin/env bash
set -euo pipefail

# --- Colors ---
C_GREEN="\033[1;32m"
C_YELLOW="\033[1;33m"
C_CYAN="\033[1;36m"
C_RED="\033[1;31m"
C_NC="\033[0m" # No Color

# Aliases for semantics
C_WARN="$C_YELLOW"
C_FAIL="$C_RED"

# Defaults you can override on the command line:
: "${SERVER_URL:=http://127.0.0.1:7860}"
: "${REQ_TIMEOUT:=300}"        # allow time for first-run model download
: "${DEBUG_HTTP:=0}"           # set 1 for verbose request/response logs
: "${PRINT_STATUS:=0}"         # set 1 to dump full /api/status

# Strong suggestion for first runs to avoid CUDA meta-tensor crash:
: "${RAG_DEVICE:=cpu}"

export SERVER_URL REQ_TIMEOUT DEBUG_HTTP PRINT_STATUS RAG_DEVICE

echo -e "${C_GREEN}* Starting Milvus Admin UI E2E Test ${C_NC}"
echo -e "${C_CYAN}--------------------------------------${C_NC}"
echo -e "* ${C_YELLOW}SERVER_URL${C_NC}  = $SERVER_URL"
echo -e "* ${C_YELLOW}REQ_TIMEOUT${C_NC} = $REQ_TIMEOUT"
echo -e "* ${C_YELLOW}RAG_DEVICE${C_NC}  = $RAG_DEVICE"
echo -e "* ${C_YELLOW}DEBUG_HTTP${C_NC}  = $DEBUG_HTTP"
echo -e "* ${C_YELLOW}PRINT_STATUS${C_NC}= $PRINT_STATUS"
echo -e "${C_CYAN}--------------------------------------${C_NC}"
echo

# Find the python script relative to this bash script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
TEST_SCRIPT_PATH="$SCRIPT_DIR/../tests/test_workflow.py"

if [[ ! -f "$TEST_SCRIPT_PATH" ]]; then
    echo -e "${C_FAIL}Error: Test script not found at $TEST_SCRIPT_PATH${C_NC}"
    exit 1
fi

# Try to find python, preferring 'python3'
if command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
elif command -v python &>/dev/null; then
    PYTHON_CMD="python"
else
    echo -e "${C_FAIL}Error: No 'python3' or 'python' command found in PATH.${C_NC}"
    exit 1
fi

# Check for requests and colorama
if ! $PYTHON_CMD -c "import requests" &>/dev/null; then
    echo -e "${C_FAIL}Error: 'requests' library not found. Please install: pip install requests${C_NC}"
    exit 1
fi
if ! $PYTHON_CMD -c "import colorama" &>/dev/null; then
    echo -e "${C_WARN}Warning: 'colorama' not found. Output will not be colored.${C_NC}"
    echo -e "${C_WARN}Install with: pip install colorama${C_NC}"
    # Don't exit, just continue without colors
fi

# Execute the test
$PYTHON_CMD "$TEST_SCRIPT_PATH"

