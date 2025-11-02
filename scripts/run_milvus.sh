#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${1:-milvus.docker-compose.yml}"

# Ensure docker exists
if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker not found in PATH." >&2
  exit 1
fi

# Pick compose command: prefer 'docker compose', fallback to 'docker-compose'
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Error: neither 'docker compose' nor 'docker-compose' is available." >&2
  echo "Install Docker Desktop (macOS/Windows) or docker-ce + compose plugin (Linux)." >&2
  exit 1
fi

# Compose file check
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file '$COMPOSE_FILE' not found." >&2
  echo "Run: make install-milvus" >&2
  exit 1
fi

echo "Starting Milvus stack with: $COMPOSE_CMD -f $COMPOSE_FILE up -d"
$COMPOSE_CMD -f "$COMPOSE_FILE" up -d

echo "✅ Milvus stack is starting."
echo "Tip: 'make status' to see containers, 'make logs' to tail logs."
