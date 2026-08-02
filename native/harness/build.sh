#!/usr/bin/env bash
# Build Invincible harness Wasm (Phase 3). Used by CI and local Zig 0.16 hosts.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="/usr/local/bin:${PATH}"

ROOT="$(cd .. && pwd)"
PIN="$(tr -d '[:space:]' < "${ROOT}/ZIG_VERSION")"
GOT="$(zig version)"
if [[ "$GOT" != "$PIN" ]]; then
  echo "error: zig $GOT != pinned $PIN" >&2
  exit 1
fi

RELEASE_MODE="${RELEASE_MODE:-small}"
echo "building harness (--release=${RELEASE_MODE}) with zig ${GOT}..."
zig build harness --release="${RELEASE_MODE}" --summary all

OUT="zig-out/bin"
test -f "${OUT}/harness.wasm"
head -c 4 "${OUT}/harness.wasm" | od -An -tx1 | grep -q '00 61 73 6d'
test -f "${OUT}/web.js"
test -f "${OUT}/index.html"
# Alias for stock loaders
if [[ ! -f "${OUT}/web.wasm" ]]; then
  cp -f "${OUT}/harness.wasm" "${OUT}/web.wasm"
fi

STAGE="${ROOT}/dist/harness"
rm -rf "${STAGE}"
mkdir -p "${STAGE}"
cp -a "${OUT}/harness.wasm" "${OUT}/web.js" "${OUT}/index.html" "${STAGE}/"
# Keep web.wasm alias in staged dist for convenience
cp -f "${OUT}/harness.wasm" "${STAGE}/web.wasm"

BYTES=$(wc -c < "${STAGE}/harness.wasm" | tr -d ' ')
JS_BYTES=$(wc -c < "${STAGE}/web.js" | tr -d ' ')
echo "built ${STAGE}/harness.wasm (${BYTES} bytes wasm, ${JS_BYTES} bytes js) with zig ${GOT}"
ls -la "${STAGE}"
