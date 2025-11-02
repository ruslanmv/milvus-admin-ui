# Makefile - Cross-Platform for Python 3.11 + uv + Docker containers
# Works on Windows (PowerShell/CMD/Git Bash) and Unix-like systems (Linux/macOS).

.DEFAULT_GOAL := uv-install

# =============================================================================
#  Configuration
# =============================================================================

# --- User-Configurable Variables ---
PYTHON ?= python3.11
VENV   ?= .venv

# Docker image/container for this repo
IMAGE ?= milvus-admin-ui:latest
CONTAINER ?= milvus-admin-ui
DOCKERFILE ?= Dockerfile
ENV_FILE ?= .env
SRC_ROOT ?= .

# Docker config for Milvus (compose via scripts/*)
MILVUS_COMPOSE ?= milvus.docker-compose.yml
MILVUS_VERSION ?= 2.4.6
MINIO_VERSION  ?= RELEASE.2024-05-28T17-19-04Z
ETCD_VERSION   ?= v3.5.5

# UI paths
UI_DIR      ?= ui
UI_STATIC   ?= $(UI_DIR)/static
BUILD_UI_SH ?= scripts/build-ui.sh

# --- OS Detection for Paths and Commands ---
ifeq ($(OS),Windows_NT)
PYTHON         := py -3.11
PY_SUFFIX      := .exe
BIN_DIR        := Scripts
ACTIVATE       := $(VENV)\$(BIN_DIR)\activate
NULL_DEVICE    := $$null
RM             := Remove-Item -Force -ErrorAction SilentlyContinue
RMDIR          := Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
SHELL          := powershell.exe
.SHELLFLAGS    := -NoProfile -ExecutionPolicy Bypass -Command
ENVREF         := $$env:
# PowerShell PWD is an object; .Path is an absolute string path Docker understands on Windows
MOUNT_SRC      := "$$PWD.Path"
else
PY_SUFFIX      :=
BIN_DIR        := bin
ACTIVATE       := . $(VENV)/$(BIN_DIR)/activate
NULL_DEVICE    := /dev/null
RM             := rm -f
RMDIR          := rm -rf
SHELL          := /bin/bash
.ONESHELL:
.SHELLFLAGS    := -eu -o pipefail -c
ENVREF         := $$
# Use Make's absolute current dir (fixes the literal $(pwd) bug)
MOUNT_SRC      := $(CURDIR)
endif

# --- Derived Variables (venv) ---
PY_EXE     := $(VENV)/$(BIN_DIR)/python$(PY_SUFFIX)
PIP_EXE    := $(VENV)/$(BIN_DIR)/pip$(PY_SUFFIX)
BIN_PATH   := $(VENV)/$(BIN_DIR)
INGEST_EXE := $(BIN_PATH)/mui-ingest$(PY_SUFFIX)
CREATE_EXE := $(BIN_PATH)/mui-create-vectordb$(PY_SUFFIX)

# =============================================================================
#  Phonies
# =============================================================================
.PHONY: help uv-install update venv venv-clean pip-install install test lint fmt check \
        clean distclean python-version shell \
        install-milvus start stop status logs \
        build-container run-container stop-container logs-container up-container \
        ingest create-vectordb create-vectordb-container sync-docs \
        ui-install ui-dev run

# =============================================================================
#  Help & Summary
# =============================================================================

help: ## Show this help message
	@echo "Usage: make <target>"
	@echo
	@echo "Python/uv targets:"
	@echo "  uv-install            Create .venv with uv and install deps (Python 3.11)"
	@echo "  update                Re-sync deps with uv (or pip fallback)"
	@echo "  venv/venv-clean       Create or remove .venv (pip fallback)"
	@echo "  pip-install           Install with pip into .venv (fallback; not uv)"
	@echo "  install               uv-install + install Milvus compose (does not start)"
	@echo "  test / lint / fmt     Dev helpers (if configured)"
	@echo "  clean / distclean     Remove caches, __pycache__, .venv"
	@echo "  python-version        Show interpreter version"
	@echo "  shell                 Instructions to activate .venv"
	@echo
	@echo "Milvus (local via Docker Compose):"
	@echo "  install-milvus        Create compose file and pull images"
	@echo "  start                 Start local Milvus (docker compose up -d)"
	@echo "  stop                  Stop local Milvus (docker compose down)"
	@echo "  status                Show Milvus containers status"
	@echo "  logs                  Tail Milvus logs"
	@echo
	@echo "Project container (this repo):"
	@echo "  build-container       Build Docker image ($(IMAGE))"
	@echo "  run-container         Run containerized ingest (mounts CWD; keeps running)"
	@echo "  up-container          Build + run (convenience target)"
	@echo "  stop-container        Stop and remove the container"
	@echo "  logs-container        Tail container logs"
	@echo
	@echo "Data ops (host .venv or container):"
	@echo "  ingest                Upload data/ to S3-compatible storage (host .venv)"
	@echo "  create-vectordb       Create Milvus collection/index (host .venv)"
	@echo "  sync-docs             Ingest files then (re)build the vector DB (one-shot)"
	@echo "  create-vectordb-container  Create Milvus collection/index (inside container)"
	@echo
	@echo "UI:"
	@echo "  ui-install            Install UI deps and build SPA to $(UI_STATIC)"
	@echo "  ui-dev                Run Vite dev server (proxy to FastAPI)"
	@echo "  run                   Start Milvus (compose) and the UI server"

# =============================================================================
#  Python env with uv (recommended)
# =============================================================================

install: uv-install install-milvus ## Install project (uv) and prepare local Milvus compose
	@echo "✅ Install complete. Next: 'make start' to launch Milvus."

uv-install: check-uv check-pyproject ## [uv] Create .venv with Python 3.11 and sync deps
	@echo "Ensuring Python 3.11 via uv ..."
	@uv python install 3.11
	@echo "Syncing environment with uv (Python 3.11) ..."
	@UV_PYTHON=3.11 uv sync
	@echo "✅ Done! To activate: source .venv/bin/activate (Unix) or .\\.venv\\Scripts\\Activate.ps1 (Windows)"

update: check-uv check-pyproject ## Re-sync deps (uv), or pip fallback
	@if command -v uv >$(NULL_DEVICE) 2>&1; then \
		echo "uv sync ..."; \
		uv sync; \
	else \
		echo "uv not found; falling back to pip"; \
		[ -x "$(VENV)/bin/python" ] || $(PYTHON) -m venv "$(VENV)"; \
		"$(VENV)/bin/python" -m pip install -U pip; \
		"$(VENV)/bin/pip" install -U -e ".[dev]"; \
	fi
	@echo "✅ Dependencies updated."

# =============================================================================
#  Python env with pip (fallback)
# =============================================================================

venv: check-python ## Create/refresh venv using pip (fallback, not uv)
	@echo "Creating virtual environment at $(VENV)..."
	@$(PYTHON) -m venv --clear "$(VENV)" || { rm -rf "$(VENV)"; $(PYTHON) -m venv "$(VENV)"; }
	@"$(VENV)/bin/python" -m pip install --upgrade pip
	@echo "✅ Created $(VENV) with $$\("$(VENV)/bin/python" -V\)"

pip-install: venv check-pyproject ## Install via pip into .venv
	@$(PY_EXE) -m pip install .

venv-clean: ## Remove the venv
	@echo "Removing virtualenv $(VENV) ..."
	@$(RMDIR) "$(VENV)"

# =============================================================================
#  Data ops (host-side CLI installed by pyproject)
# =============================================================================

ingest: uv-install ## Upload data/ to S3 using host .venv (skips cloud if misconfigured)
	$(INGEST_EXE) --source-root $(SRC_ROOT)/data

create-vectordb: uv-install ## Create Milvus collection/index using host .venv
	$(CREATE_EXE)

# One-shot combined sync: ingest then (re)create index/collections
sync-docs: uv-install ## Ingest files then (re)build the vector DB
	$(INGEST_EXE) --source-root $(SRC_ROOT)/data
	$(CREATE_EXE)

# =============================================================================
#  Project container (build/run like before)
# =============================================================================

build-container: ## Build Docker image for this repo
	docker build -t $(IMAGE) -f $(DOCKERFILE) .

run-container: ## Run containerized ingest (mount current dir; keeps running for logs)
	- docker stop $(CONTAINER) >/dev/null 2>&1 || true
	- docker rm $(CONTAINER) >/dev/null 2>&1 || true
	docker run -d --name $(CONTAINER) $$([ -f $(ENV_FILE) ] && echo --env-file $(ENV_FILE)) \
	  -v "$(MOUNT_SRC)":/app/workspace \
	  $(IMAGE) mui-ingest --source-root /app/workspace/data
	@echo "Container running: $(CONTAINER)"

up-container: build-container run-container ## Build + run (convenience)

stop-container: ## Stop and remove the container
	- docker stop $(CONTAINER) >/dev/null 2>&1 || true
	- docker rm $(CONTAINER) >/dev/null 2>&1 || true
	@echo "Container stopped/removed: $(CONTAINER)"

logs-container: ## Tail logs from the container
	docker logs -f $(CONTAINER)

# Dynamic network attach: discover the compose network used by milvus-standalone
create-vectordb-container: ## Create Milvus collection/index inside the container (same network as Milvus)
	@set -e; \
	NET=$$(docker inspect -f '{{range $$k,$$v := .NetworkSettings.Networks}}{{$$k}}{{end}}' milvus-standalone 2>/dev/null || true); \
	if [ -z "$$NET" ]; then \
	  echo "Milvus container 'milvus-standalone' not found or not running."; \
	  echo "Run: make start   (to launch Milvus via docker compose)"; \
	  exit 1; \
	fi; \
	echo "Using docker network: $$NET"; \
	docker run --rm $$([ -f $(ENV_FILE) ] && echo --env-file $(ENV_FILE)) \
	  --network="$$NET" \
	  -v "$(MOUNT_SRC)":/app/workspace \
	  -e IN_DOCKER=1 \
	  -e MILVUS_HOST=$${MILVUS_HOST:-milvus} \
	  -e MANIFEST_PATH=/app/workspace/.wxo/manifest.json \
	  -e DATA_SOURCE_ROOT=/app/workspace/data \
	  $(IMAGE) mui-create-vectordb

# =============================================================================
#  Milvus (local via Docker Compose) using scripts/
# =============================================================================

install-milvus: ## Create compose file and pull images
	@bash scripts/install_milvus.sh "$(MILVUS_COMPOSE)" "$(MILVUS_VERSION)" "$(ETCD_VERSION)" "$(MINIO_VERSION)"

start: ## Start local Milvus (Docker Compose)
	@bash scripts/run_milvus.sh "$(MILVUS_COMPOSE)"

stop: ## Stop local Milvus (Docker Compose)
	@bash scripts/stop_milvus.sh "$(MILVUS_COMPOSE)"

status: ## Show Milvus containers status
	@if command -v docker >/dev/null 2>&1; then \
		if docker compose -f "$(MILVUS_COMPOSE)" ps >/dev/null 2>&1; then \
			docker compose -f "$(MILVUS_COMPOSE)" ps; \
		elif command -v docker-compose >/dev/null 2>&1; then \
			docker-compose -f "$(MILVUS_COMPOSE)" ps; \
		else \
			echo "docker compose not available"; exit 1; \
		fi \
	else \
		echo "docker not found in PATH"; exit 1; \
	fi

logs: ## Tail Milvus logs
	@if command -v docker >/dev/null 2>&1; then \
		docker logs -f milvus-standalone || true; \
		docker logs -f milvus-minio || true; \
		docker logs -f milvus-etcd || true; \
	else \
		echo "docker not found in PATH"; exit 1; \
	fi

# =============================================================================
#  UI
# =============================================================================

# Install Python UI deps AND build the React app located in ./ui (Vite/Refine).
ifeq ($(OS),Windows_NT)
ui-install: uv-install
	@& $(PY_EXE) -m ensurepip --upgrade
	@& $(PY_EXE) -m pip install -U pip
	@& $(PY_EXE) -m pip install -U fastapi uvicorn "pydantic>=2,<3" "sentence-transformers>=3.0" python-dotenv pymilvus
	@if (Test-Path -LiteralPath '$(BUILD_UI_SH)') { \
		echo 'Building UI via scripts/build-ui.sh ...'; \
		bash $(BUILD_UI_SH); \
	} else { \
		if (Test-Path -LiteralPath '$(UI_DIR)\package.json') { \
			if (Get-Command npm -ErrorAction SilentlyContinue) { \
				echo 'Installing UI deps (npm ci) ...'; \
				npm ci --prefix $(UI_DIR); \
				echo 'Building UI ...'; \
				npm run build --prefix $(UI_DIR); \
				if (Test-Path -LiteralPath '$(UI_STATIC)\index.html') { \
					echo 'UI already built into $(UI_STATIC)'; \
				} elseif (Test-Path -LiteralPath '$(UI_DIR)\dist') { \
					if (Test-Path -LiteralPath '$(UI_STATIC)') { Remove-Item -Recurse -Force '$(UI_STATIC)'; } \
					New-Item -ItemType Directory -Force -Path '$(UI_STATIC)' | Out-Null; \
					Copy-Item -Recurse -Force '$(UI_DIR)\dist\*' '$(UI_STATIC)'; \
				} elseif (Test-Path -LiteralPath '$(UI_DIR)\build') { \
					if (Test-Path -LiteralPath '$(UI_STATIC)') { Remove-Item -Recurse -Force '$(UI_STATIC)'; } \
					New-Item -ItemType Directory -Force -Path '$(UI_STATIC)' | Out-Null; \
					Copy-Item -Recurse -Force '$(UI_DIR)\build\*' '$(UI_STATIC)'; \
				} else { \
					echo 'WARN: No UI bundle found to copy. Ensure Vite outDir -> $(UI_STATIC)'; \
				} \
			} else { \
				echo 'npm not found; skipping UI build (serve existing ui/static).'; \
			} \
		} else { \
			echo 'No $(UI_DIR)/package.json; skipping UI build.'; \
		} \
	}
else
ui-install: uv-install
	@$(PY_EXE) -m ensurepip --upgrade || true
	@$(PY_EXE) -m pip install -U pip
	@$(PY_EXE) -m pip install -U fastapi uvicorn "pydantic>=2,<3" "sentence-transformers>=3.0" python-dotenv pymilvus
	@if [ -x "$(BUILD_UI_SH)" ]; then \
		echo "Building UI via $(BUILD_UI_SH) ..."; \
		bash $(BUILD_UI_SH); \
	else \
		if [ -f $(UI_DIR)/package.json ]; then \
			if command -v npm >/dev/null 2>&1; then \
				echo "Installing UI deps (npm ci) ..."; \
				npm ci --prefix $(UI_DIR); \
				echo "Building UI ..."; \
				npm run build --prefix $(UI_DIR); \
				if [ -f $(UI_STATIC)/index.html ]; then \
					echo "UI already built into $(UI_STATIC)"; \
				elif [ -d $(UI_DIR)/dist ]; then \
					rm -rf $(UI_STATIC); mkdir -p $(UI_STATIC); cp -r $(UI_DIR)/dist/* $(UI_STATIC)/; \
				elif [ -d $(UI_DIR)/build ]; then \
					rm -rf $(UI_STATIC); mkdir -p $(UI_STATIC); cp -r $(UI_DIR)/build/* $(UI_STATIC)/; \
				else \
					echo "WARN: No UI bundle found to copy. Ensure Vite outDir -> $(UI_STATIC)"; \
				fi; \
			else \
				echo "npm not found; skipping UI build (serve existing ui/static)."; \
			fi; \
		else \
			echo "No $(UI_DIR)/package.json; skipping UI build."; \
		fi; \
	fi
endif

# Optional: Vite dev server (for local UI development)
ui-dev:
	@if [ -f $(UI_DIR)/package.json ]; then \
		echo "Starting Vite dev server (http://127.0.0.1:5173) ..."; \
		npm run dev --prefix $(UI_DIR); \
	else \
		echo "No $(UI_DIR)/package.json found"; \
	fi

run: start ## Start Milvus (compose) and the UI server
	$(PY_EXE) ui/server.py

# =============================================================================
#  Clean (OS-specific)
# =============================================================================

ifeq ($(OS),Windows_NT)
clean: ## Remove Python artifacts, caches, and .venv
	@echo "Cleaning project ..."
	-$(RMDIR) $(VENV)
	-$(RMDIR) .pytest_cache
	-$(RMDIR) .ruff_cache
	-$(RMDIR) build
	-$(RMDIR) dist
	-$(RMDIR) *.egg-info
	@echo "Removing compiled Python files and __pycache__ ..."
	@& powershell -NoProfile -Command "Get-ChildItem -Recurse -Force -Include *.pyc,*.pyo,*~ -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue; Get-ChildItem -Recurse -Directory -Force -Filter __pycache__ -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue"
	@echo "✅ Clean complete."
else
clean: ## Remove Python artifacts, caches, and .venv
	@echo "Cleaning project ..."
	-$(RMDIR) $(VENV)
	-$(RMDIR) .pytest_cache
	-$(RMDIR) .ruff_cache
	-$(RMDIR) build
	-$(RMDIR) dist
	-$(RMDIR) *.egg-info
	@echo "Removing compiled Python files and __pycache__ ..."
	@find . -type f \( -name '*.pyc' -o -name '*.pyo' -o -name '*~' \) -print -delete || true
	@find . -type d -name '__pycache__' -print -exec rm -rf {} + || true
	@echo "✅ Clean complete."
endif

distclean: clean ## Alias for clean

python-version: check-python ## Show interpreter version
	@echo "Using: $(PYTHON)"
	@$(PYTHON) -V

shell: ## How to activate the .venv
	@echo "To activate the environment:"
	@echo "  Unix/macOS:   source .venv/bin/activate"
	@echo "  Windows PS:   .\\.venv\\Scripts\\Activate.ps1"

# =============================================================================
#  Checks
# =============================================================================

ifeq ($(OS),Windows_NT)
check-python:
	@echo "Checking for a Python 3.11 interpreter..."
	@& $(PYTHON) -c "import sys; sys.exit(0 if sys.version_info[:2]==(3,11) else 1)" 2>$(NULL_DEVICE); if ($$LASTEXITCODE -ne 0) { echo "Error: '$(PYTHON)' is not Python 3.11."; echo "Install Python 3.11 or override: make uv-install PYTHON='py -3.11'"; exit 1; }
	@& $(PYTHON) -V

check-pyproject:
	@if (Test-Path -LiteralPath 'pyproject.toml') { echo 'Found pyproject.toml' } else { echo ('Error: pyproject.toml not found in ' + (Get-Location)); exit 1 }

check-uv: ## Check for uv and install if missing
	@echo "Checking for uv..."
	@$$cmd = Get-Command uv -ErrorAction SilentlyContinue; if (-not $$cmd) { echo 'Info: ''uv'' not found. Installing...'; iwr https://astral.sh/uv/install.ps1 -UseBasicParsing | iex; $$localBin = Join-Path $$env:USERPROFILE '.local\\bin'; if (Test-Path $$localBin) { $$env:Path = "$$localBin;$$env:Path" } }
	@$$cmd = Get-Command uv -ErrorAction SilentlyContinue; if (-not $$cmd) { $$candidate = Join-Path $$env:USERPROFILE '.local\\bin\\uv.exe'; if (Test-Path $$candidate) { echo ('Using ' + $$candidate); $$env:Path = (Split-Path $$candidate) + ';' + $$env:Path } else { echo 'Error: ''uv'' still not available.'; exit 1 } }
	@echo "✅ uv is available."
else
check-python:
	@echo "Checking for a Python 3.11 interpreter..."
	@$(PYTHON) -c "import sys; sys.exit(0 if sys.version_info[:2]==(3,11) else 1)" 2>$(NULL_DEVICE) || ( \
		echo "Error: '$(PYTHON)' is not Python 3.11."; \
		echo "Install Python 3.11 or override: make uv-install PYTHON=python3.11"; \
		exit 1; \
	)
	@$(PYTHON) -V

check-pyproject:
	@[ -f pyproject.toml ] || { echo "Error: pyproject.toml not found in $$\(pwd\)"; exit 1; }
	@echo "Found pyproject.toml"

check-uv: ## Check for uv and install if missing
	@echo "Checking for uv..."
	@command -v uv >$(NULL_DEVICE) 2>&1 || ( \
		echo "Info: 'uv' not found. Installing..."; \
		curl -LsSf https://astral.sh/uv/install.sh | sh; \
	)
	@command -v uv >$(NULL_DEVICE) 2>&1 || ( echo "Error: 'uv' still not available."; exit 1; )
	@echo "✅ uv is available."
endif
