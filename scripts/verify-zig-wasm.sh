#!/usr/bin/env bash
# Verify pinned Zig can emit Wasm (Phase 2.3).
# Usage: curl …/verify-zig-wasm.sh | bash
#    or: ./scripts/verify-zig-wasm.sh
set -euo pipefail

EXPECT_ZIG_VERSION="${EXPECT_ZIG_VERSION:-0.16.0}"
ZIG="${ZIG:-zig}"

if ! command -v "$ZIG" >/dev/null 2>&1; then
  echo "error: zig not on PATH" >&2
  exit 1
fi

GOT="$("$ZIG" version)"
echo "==> zig version: $GOT"
if [[ "$GOT" != "$EXPECT_ZIG_VERSION" ]]; then
  echo "error: expected Zig ${EXPECT_ZIG_VERSION}, got ${GOT}" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

# Prefer repo copy if present next to script; else embedded probe
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [[ -n "${SCRIPT_DIR}" && -f "${SCRIPT_DIR}/../native/hello.zig" ]]; then
  cp "${SCRIPT_DIR}/../native/hello.zig" hello.zig
else
  cat > hello.zig << 'ZIG'
export fn add(a: i32, b: i32) i32 {
    return a + b;
}
ZIG
fi

"$ZIG" build-lib \
  -target wasm32-freestanding \
  -dynamic \
  -OReleaseSmall \
  -femit-bin=hello.wasm \
  hello.zig

test -f hello.wasm
# magic \0asm
head -c 4 hello.wasm | od -An -tx1
BYTES=$(wc -c < hello.wasm | tr -d ' ')
echo "wasm OK (${BYTES} bytes)"
