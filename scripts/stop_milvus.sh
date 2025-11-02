#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${1:-milvus.docker-compose.yml}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker not found in PATH." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Error: neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "Compose file '$COMPOSE_FILE' not found." >&2
  exit 1
fi

echo "Stopping Milvus stack with: $COMPOSE_CMD -f $COMPOSE_FILE down"
$COMPOSE_CMD -f "$COMPOSE_FILE" down

echo "✅ Milvus stack stopped."
