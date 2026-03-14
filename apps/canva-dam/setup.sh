#!/usr/bin/env bash
# Sets up the Etsy Product Ideas Canva DAM app for local development.
# Clones the Canva Apps SDK starter kit, copies our source into it,
# and starts the dev server.
#
# Usage:
#   BACKEND_HOST=https://your-worker.workers.dev bash apps/canva-dam/setup.sh
#
# After running, open the Canva Developer Portal and set your app's
# development URL to http://localhost:8080.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

STARTER_KIT_DIR="${REPO_ROOT}/.canva-starter-kit"
EXAMPLE_NAME="etsy_product_dam"
EXAMPLE_DIR="${STARTER_KIT_DIR}/examples/${EXAMPLE_NAME}"

BACKEND_HOST="${BACKEND_HOST:-}"

if [[ -z "${BACKEND_HOST}" ]]; then
  echo "❌  BACKEND_HOST is not set."
  echo "    Usage: BACKEND_HOST=https://your-worker.workers.dev bash apps/canva-dam/setup.sh"
  exit 1
fi

echo "🎨  Setting up Etsy Product Ideas Canva DAM app"
echo "    Backend: ${BACKEND_HOST}"
echo ""

# ── Clone starter kit if not already present ────────────────────────────────
if [[ ! -d "${STARTER_KIT_DIR}" ]]; then
  echo "📥  Cloning Canva Apps SDK starter kit..."
  git clone --depth=1 https://github.com/canva-sdks/canva-apps-sdk-starter-kit.git "${STARTER_KIT_DIR}"
else
  echo "✅  Starter kit already cloned at ${STARTER_KIT_DIR}"
fi

# ── Copy our example files ───────────────────────────────────────────────────
echo "📂  Copying source files into starter kit example..."
mkdir -p "${EXAMPLE_DIR}"
cp -r "${SCRIPT_DIR}/src/"* "${EXAMPLE_DIR}/"

# ── Write .env ───────────────────────────────────────────────────────────────
ENV_FILE="${STARTER_KIT_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${STARTER_KIT_DIR}/.env.example" "${ENV_FILE}" 2>/dev/null || touch "${ENV_FILE}"
fi

# Set BACKEND_HOST in .env (add or update)
if grep -q "^BACKEND_HOST=" "${ENV_FILE}"; then
  sed -i "s|^BACKEND_HOST=.*|BACKEND_HOST=${BACKEND_HOST}|" "${ENV_FILE}"
else
  echo "BACKEND_HOST=${BACKEND_HOST}" >> "${ENV_FILE}"
fi

echo ""
echo "⚙️   Make sure CANVA_APP_ID is set in ${ENV_FILE}"
echo "    You can get your App ID from https://www.canva.com/developers"
echo ""

# ── Install dependencies ─────────────────────────────────────────────────────
echo "📦  Installing dependencies..."
cd "${STARTER_KIT_DIR}"
npm install

# ── Start dev server ─────────────────────────────────────────────────────────
echo ""
echo "🚀  Starting dev server at http://localhost:8080"
echo "    Set this as your app's development URL in the Canva Developer Portal."
echo "    Press Ctrl+C to stop."
echo ""
npm start "${EXAMPLE_NAME}"
