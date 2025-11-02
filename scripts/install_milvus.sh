#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${1:-milvus.docker-compose.yml}"
MILVUS_VERSION="${2:-2.4.6}"
ETCD_VERSION="${3:-v3.5.5}"
MINIO_VERSION="${4:-RELEASE.2024-05-28T17-19-04Z}"
FORCE_COMPOSE="${MILVUS_FORCE_COMPOSE:-0}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not in PATH." >&2
  exit 1
fi

# detect compose command
COMPOSE_CMD="docker compose"
if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_CMD="docker-compose"
  else
    echo "Error: neither 'docker compose' nor 'docker-compose' is available." >&2
    exit 1
  fi
fi

mkdir -p volumes/milvus volumes/etcd volumes/minio

# Resolve correct Milvus tag: some registries use a leading 'v'
MILVUS_TAG="$MILVUS_VERSION"
if ! docker pull -q "milvusdb/milvus:${MILVUS_TAG}" >/dev/null 2>&1; then
  ALT="v${MILVUS_VERSION}"
  echo "Info: milvusdb/milvus:${MILVUS_TAG} not found, trying ${ALT} ..."
  if docker pull -q "milvusdb/milvus:${ALT}" >/dev/null 2>&1; then
    MILVUS_TAG="$ALT"
  else
    echo "Error: could not pull milvus image tag '${MILVUS_VERSION}' (tried '${MILVUS_VERSION}' and 'v${MILVUS_VERSION}')." >&2
    exit 1
  fi
fi

# Create/overwrite compose file (unless user wants to keep their own)
if [[ ! -f "$COMPOSE_FILE" || "$FORCE_COMPOSE" == "1" ]]; then
  cat > "$COMPOSE_FILE" <<YAML
# No `version:` key (Compose v2+ ignores it and warns).
# Cross-platform Milvus Standalone (Linux + macOS/Apple Silicon)

services:
  etcd:
    # Default: upstream etcd; override with ETCD_IMAGE or ETCD_PLATFORM at runtime.
    image: ${ETCD_IMAGE:-quay.io/coreos/etcd:v3.5.18}
    # On Apple Silicon, you can run amd64 under emulation (safe & reliable):
    #   ETCD_PLATFORM=linux/amd64
    # Or use a native ARM image:
    #   ETCD_IMAGE=rancher/mirrored-coreos-etcd:v3.5.18-arm64
    platform: ${ETCD_PLATFORM:-}
    container_name: milvus-etcd
    restart: unless-stopped
    environment:
      - ETCD_AUTO_COMPACTION_MODE=revision
      - ETCD_AUTO_COMPACTION_RETENTION=1000
      - ETCD_QUOTA_BACKEND_BYTES=4294967296
      - ETCD_SNAPSHOT_COUNT=50000
      - ETCDCTL_API=3
    command:
      - etcd
      - -advertise-client-urls=http://etcd:2379
      - -listen-client-urls
      - http://0.0.0.0:2379
      - --data-dir
      - /etcd
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/etcd:/etcd
    healthcheck:
      test: ["CMD", "etcdctl", "endpoint", "health", "--endpoints=http://127.0.0.1:2379"]
      interval: 30s
      timeout: 10s
      retries: 5
    ports:
      - "2379:2379"

  minio:
    image: ${MINIO_IMAGE:-minio/minio:RELEASE.2024-05-28T17-19-04Z}
    container_name: milvus-minio
    restart: unless-stopped
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-minioadmin}
    command: ["minio", "server", "/minio_data", "--console-address", ":9001"]
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/minio:/minio_data
    ports:
      - "9000:9000"
      - "9001:9001"
    # FYI: Many MinIO tags no longer include curl/wget. If you *know* your tag has curl,
    # you may enable the healthcheck below and change Milvus depends_on to service_healthy.
    # healthcheck:
    #   test: ["CMD-SHELL", "curl -f http://127.0.0.1:9000/minio/health/ready || exit 1"]
    #   interval: 30s
    #   timeout: 10s
    #   retries: 5

  milvus:
    image: milvusdb/milvus:v${MILVUS_VERSION:-2.4.6}
    container_name: milvus-standalone
    restart: unless-stopped
    command: ["milvus", "run", "standalone"]
    environment:
      # etcd
      ETCD_ENDPOINTS: ${ETCD_ENDPOINTS:-etcd:2379}
      # MinIO/S3 (names per Milvus docs)
      MINIO_ADDRESS: ${MINIO_ADDRESS:-minio:9000}
      MINIO_ACCESS_KEY_ID: ${MINIO_ACCESS_KEY_ID:-minioadmin}
      MINIO_SECRET_ACCESS_KEY: ${MINIO_SECRET_ACCESS_KEY:-minioadmin}
      MINIO_BUCKET_NAME: ${MINIO_BUCKET_NAME:-milvus-bucket}
      MINIO_USE_SSL: ${MINIO_USE_SSL:-false}
      MINIO_REGION: ${MINIO_REGION:-us-east-1}
    volumes:
      - ${DOCKER_VOLUME_DIRECTORY:-.}/volumes/milvus:/var/lib/milvus
    ports:
      - "19530:19530"   # gRPC
      - "9091:9091"     # metrics/healthz
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9091/healthz"]
      interval: 30s
      start_period: 90s
      timeout: 10s
      retries: 5
    depends_on:
      etcd:
        condition: service_healthy
      # Change to `service_healthy` if you enable MinIO healthcheck above.
      minio:
        condition: service_started
YAML
  echo "Wrote $COMPOSE_FILE (milvus image tag: ${MILVUS_TAG})"
else
  echo "Compose file already exists: $COMPOSE_FILE (set MILVUS_FORCE_COMPOSE=1 to regenerate)"
fi

echo "Pulling images with $COMPOSE_CMD ..."
$COMPOSE_CMD -f "$COMPOSE_FILE" pull

echo "✅ Milvus compose prepared."
echo "Next: make start"