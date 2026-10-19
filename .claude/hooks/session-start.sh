#!/bin/bash
# Cloud sessions only: install the workspace and build radius-sdk and radius-cli, which the
# docs, the CLI tests and the eval runners all import from dist. Then set up the Python SDK's
# environment when uv is available.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# package.json pins pnpm through packageManager; corepack fetches that version.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable pnpm
echo 'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0' >> "$CLAUDE_ENV_FILE"

pnpm install
pnpm build

if command -v uv >/dev/null 2>&1; then
  (cd packages/sdk-python && uv sync --frozen --all-extras --quiet)
fi
