#!/usr/bin/env bash
# Deprecated for Vercel path: use npm run fetch-harness (option B).
# Still useful to stage local dist → public/harness for offline testing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/native/dist/harness}"
DEST="$ROOT/public/harness"

if [[ ! -f "$SRC/harness.wasm" ]]; then
  echo "error: missing $SRC/harness.wasm" >&2
  echo "prefer: npm run fetch-harness" >&2
  echo "or:     ./native/harness/build.sh" >&2
  exit 1
fi

mkdir -p "$DEST"
cp -f "$SRC/harness.wasm" "$DEST/harness.wasm"
cp -f "$SRC/web.js" "$DEST/web.js"
if [[ -f "$SRC/index.html" ]]; then
  cp -f "$SRC/index.html" "$DEST/index.html"
fi
ls -la "$DEST"
echo "staged → public/harness/ (gitignored — not committed; Vercel uses fetch-harness)"
