#!/usr/bin/env bash
# Copy built harness artifacts into Next.js public/ for Vercel static serve (Phase 3.4).
# Run after ./native/harness/build.sh (or download CI artifact harness-wasm).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/native/dist/harness}"
DEST="$ROOT/public/harness"

if [[ ! -f "$SRC/harness.wasm" ]]; then
  echo "error: missing $SRC/harness.wasm" >&2
  echo "build first: ./native/harness/build.sh" >&2
  echo "or: gh run download <id> -n harness-wasm -D native/dist/harness" >&2
  exit 1
fi

mkdir -p "$DEST"
cp -f "$SRC/harness.wasm" "$DEST/harness.wasm"
cp -f "$SRC/web.js" "$DEST/web.js"
# optional host shell for static debugging
if [[ -f "$SRC/index.html" ]]; then
  cp -f "$SRC/index.html" "$DEST/index.html"
fi

ls -la "$DEST"
echo "synced → public/harness/ (commit to ship on Vercel)"
