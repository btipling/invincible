#!/usr/bin/env bash
# Build Invincible dvui Wasm spike (Phase 3.1). Used by CI and local Zig 0.16 hosts.
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

# Zig 0.16 uses --release[=mode] (fast|safe|small), not -Doptimize=
RELEASE_MODE="${RELEASE_MODE:-small}"
echo "building dvui spike (--release=${RELEASE_MODE}) with zig ${GOT}..."
# First build may fetch dvui + transitive deps (network required).
zig build web-app --release="${RELEASE_MODE}" --summary all

OUT="zig-out/bin"
test -f "${OUT}/web.wasm"
# magic \0asm
head -c 4 "${OUT}/web.wasm" | od -An -tx1 | grep -q '00 61 73 6d'
test -f "${OUT}/web.js"
test -f "${OUT}/index.html"

# Stage into native/dist/dvui-spike for a stable artifact path
STAGE="${ROOT}/dist/dvui-spike"
rm -rf "${STAGE}"
mkdir -p "${STAGE}"
cp -a "${OUT}/web.wasm" "${OUT}/web.js" "${OUT}/index.html" "${STAGE}/"

BYTES=$(wc -c < "${STAGE}/web.wasm" | tr -d ' ')
JS_BYTES=$(wc -c < "${STAGE}/web.js" | tr -d ' ')
echo "built ${STAGE}/web.wasm (${BYTES} bytes wasm, ${JS_BYTES} bytes js) with zig ${GOT}"
ls -la "${STAGE}"
