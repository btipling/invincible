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
# Clean local zig cache for this crate so export_symbol_names changes always apply.
rm -rf zig-cache zig-out .zig-cache
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

# Fail CI if bridge exports missing (Zig 0.16 export_symbol_names whitelist).
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const need = [
      "inv_protocol_version","inv_ping","inv_set_lifecycle","inv_push_message",
      "inv_clear_messages","inv_echo","inv_echo_len","inv_echo_copy",
      "inv_has_pending_submit","inv_pending_submit_len","inv_pending_submit_copy",
      "inv_ack_pending_submit","dvui_init","gpa_u8","memory",
    ];
    WebAssembly.compile(fs.readFileSync(process.argv[1])).then((mod) => {
      const names = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
      const missing = need.filter((n) => !names.has(n));
      if (missing.length) {
        console.error("harness.wasm missing exports:", missing.join(", "));
        process.exit(1);
      }
      console.log("bridge exports OK (" + need.length + " checked)");
    });
  ' "${OUT}/harness.wasm"
else
  # Fallback: strings scan (weaker)
  strings "${OUT}/harness.wasm" | grep -qx 'inv_ping' || {
    echo "error: inv_ping not found in wasm (install node for full check)" >&2
    exit 1
  }
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
