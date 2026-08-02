#!/usr/bin/env bash
# Verify pinned Zig can emit Wasm (Phase 2.3 acceptance).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIG="${ZIG:-zig}"

echo "==> $($ZIG version)"
test "$($ZIG version)" = "${EXPECT_ZIG_VERSION:-0.16.0}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$ROOT/native/hello.zig" "$TMP/hello.zig"
cd "$TMP"

# freestanding dynamic lib → .wasm (works across recent Zig releases)
$ZIG build-lib \
  -target wasm32-freestanding \
  -dynamic \
  -OReleaseSmall \
  -femit-bin=hello.wasm \
  hello.zig

test -f hello.wasm
file hello.wasm || ls -la hello.wasm
# wasm magic: \0asm
head -c 4 hello.wasm | od -An -tx1 | grep -q '00 61 73 6d'
echo "wasm OK ($(wc -c < hello.wasm) bytes)"
