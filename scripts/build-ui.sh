#!/usr/bin/env bash
set -Eeuo pipefail

# Build the production UI bundle into ui/static
# Usage: scripts/build-ui.sh [--skip-install] [--no-clean] [--pm npm|yarn|pnpm]

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
UI_DIR="${ROOT}/ui"
OUT_DIR="${UI_DIR}/static"

SKIP_INSTALL="false"
DO_CLEAN="true"
PM_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install) SKIP_INSTALL="true"; shift ;;
    --no-clean)     DO_CLEAN="false"; shift ;;
    --pm)           PM_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help)      echo "Usage: $0 [--skip-install] [--no-clean] [--pm npm|yarn|pnpm]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

FRONT_DIR=""
if [[ -d "${ROOT}/ui" && -f "${ROOT}/ui/package.json" ]]; then
  FRONT_DIR="${ROOT}/ui"
elif [[ -f "${UI_DIR}/package.json" ]]; then
  FRONT_DIR="${UI_DIR}"
elif [[ -f "${UI_DIR}/app/package.json" ]]; then
  FRONT_DIR="${UI_DIR}/app"
else
  echo "✖ Could not find a frontend project (ui/, ui/, ui/app/)." >&2
  exit 1
fi

choose_pm() {
  local dir="$1"
  if [[ -n "${PM_OVERRIDE}" ]]; then
    echo "${PM_OVERRIDE}"; return
  fi
  if [[ -f "${dir}/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then echo "pnpm"; return; fi
  if [[ -f "${dir}/yarn.lock" ]] && command -v yarn >/dev/null 2>&1; then echo "yarn"; return; fi
  echo "npm"
}
PM="$(choose_pm "${FRONT_DIR}")"

echo "• Repo root:       ${ROOT}"
echo "• UI output dir:   ${OUT_DIR}"
echo "• Frontend dir:    ${FRONT_DIR}"
echo "• Package manager: ${PM}"
echo "• Clean output:    ${DO_CLEAN}"
echo "• Skip install:    ${SKIP_INSTALL}"
echo

if [[ "${DO_CLEAN}" == "true" ]]; then
  echo "→ Cleaning ${OUT_DIR}"
  rm -rf "${OUT_DIR}"
fi
mkdir -p "${OUT_DIR}"

if [[ "${SKIP_INSTALL}" != "true" ]]; then
  echo "→ Installing dependencies"
  pushd "${FRONT_DIR}" >/dev/null
  case "${PM}" in
    pnpm) pnpm install --frozen-lockfile || pnpm install ;;
    yarn) yarn install --frozen-lockfile || yarn install ;;
    npm)
      if [[ -f package-lock.json ]]; then npm ci || npm install; else npm install; fi
      ;;
  esac
  popd >/dev/null
else
  echo "→ Skipping dependency install"
fi

echo "→ Building production bundle"
pushd "${FRONT_DIR}" >/dev/null
case "${PM}" in
  pnpm) pnpm run build ;;
  yarn) yarn build ;;
  npm)  npm run build ;;
esac
popd >/dev/null

if [[ ! -f "${OUT_DIR}/index.html" ]]; then
  echo "✖ Build finished, but ${OUT_DIR}/index.html was not found." >&2
  echo "  Ensure Vite outDir: '../ui/static' and base: '/static/' in vite.config.ts" >&2
  exit 1
fi

echo
echo "✅ UI build complete."
echo "   Served by FastAPI from: ${OUT_DIR}"
echo "   Entry:                  ${OUT_DIR}/index.html"
if command -v du >/dev/null 2>&1; then
  echo -n "   Bundle size:            "; du -sh "${OUT_DIR}" | awk '{print $1}'
fi
echo
echo "Next:"
echo "  1) python ui/server.py (or make run)"
echo "  2) Open http://127.0.0.1:${UI_PORT:-7860}/"
