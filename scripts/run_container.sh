#!/usr/bin/env bash
set -euo pipefail
IMAGE=${IMAGE:-wxo-incident-data:latest}
CONTAINER=${CONTAINER:-wxo-incident-data}
ENV_FILE=${ENV_FILE:-.env}

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy .env.example to .env and fill creds."
  exit 1
fi

docker stop "$CONTAINER" >/dev/null 2>&1 || true
docker rm "$CONTAINER" >/dev/null 2>&1 || true

docker run -d --name "$CONTAINER"   --env-file "$ENV_FILE"   -v "$(pwd)":/app/workspace   wxo-incident-data:latest wxo-ingest --source-root /app/workspace

echo "Container running: $CONTAINER"
