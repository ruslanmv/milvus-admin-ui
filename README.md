# milvus-admin-ui

Simple admin UI + utilities for Milvus:

- Inspect status & health, list collections and indexes
- Create/drop collections
- Quick RAG test (insert + semantic search)
- Utilities to upload local data to S3-compatible storage and create Milvus collections

## Quick start

```bash
# Setup venv (if not already)
make uv-install

# Install UI deps
make ui-install

# Start Milvus (Docker Compose) + run the UI server together
make run
```

Open http://127.0.0.1:7860
