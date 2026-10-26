#!/bin/bash
# Cloud sessions only: install the workspace and build radius-sdk and radius-cli, which the
# docs, the CLI tests and the eval runners all import from dist.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# package.json pins pnpm through packageManager; corepack fetches that version.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable pnpm
echo 'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0' >> "$CLAUDE_ENV_FILE"

# A resumed container already has node_modules; a no-op install still re-verifies all of it
# (6s warm, 25s on a cold page cache). Install only when the lockfile is newer than the tree.
if [ ! -f node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  pnpm install --frozen-lockfile
fi
pnpm build
