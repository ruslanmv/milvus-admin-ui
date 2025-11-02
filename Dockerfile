FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    IN_DOCKER=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Copy package metadata and source, then install so console_scripts land in PATH
COPY pyproject.toml README.md /app/
COPY src/ /app/src/
RUN pip install --no-cache-dir .

# (Optional) helper scripts (compose, etc.)
COPY scripts/ /app/scripts/

# Default command just shows help; make targets override with args
CMD ["wxo-ingest", "--help"]
