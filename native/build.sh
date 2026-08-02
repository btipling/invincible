#!/usr/bin/env bash
# Build placeholder hello.wasm (Phase 2.5). Used by CI and local.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/usr/local/bin:${PATH}"

PIN="$(tr -d '[:space:]' < ZIG_VERSION)"
GOT="$(zig version)"
if [[ "$GOT" != "$PIN" ]]; then
  echo "error: zig $GOT != pinned $PIN" >&2
  exit 1
fi

OUT_DIR="${OUT_DIR:-dist}"
mkdir -p "$OUT_DIR"

zig build-lib \
  -target wasm32-freestanding \
  -dynamic \
  -OReleaseSmall \
  -femit-bin="${OUT_DIR}/hello.wasm" \
  hello.zig

test -f "${OUT_DIR}/hello.wasm"
# magic \0asm
head -c 4 "${OUT_DIR}/hello.wasm" | od -An -tx1 | grep -q '00 61 73 6d'
BYTES=$(wc -c < "${OUT_DIR}/hello.wasm" | tr -d ' ')
echo "built ${OUT_DIR}/hello.wasm (${BYTES} bytes) with zig ${GOT}"
