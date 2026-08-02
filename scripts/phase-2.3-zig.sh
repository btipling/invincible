#!/usr/bin/env bash
# Phase 2.3 one-shot for Invincible runner host.
# Installs Zig 0.16.0 to /opt/zig/0.16.0, links /usr/local/bin/zig, verifies wasm.
#
# Public raw (if repo public):
#   curl -fsSL https://raw.githubusercontent.com/btipling/invincible/main/scripts/phase-2.3-zig.sh | bash
#
# Private repo (PAT with contents:read):
#   export GH_TOKEN=ghp_...   # or fine-grained read-only on btipling/invincible
#   curl -fsSL \
#     -H "Authorization: Bearer $GH_TOKEN" \
#     -H "Accept: application/vnd.github.raw" \
#     "https://api.github.com/repos/btipling/invincible/contents/scripts/phase-2.3-zig.sh?ref=main" \
#     | bash
#
set -euo pipefail

ZIG_VERSION="${ZIG_VERSION:-0.16.0}"
ZIG_ARCH="${ZIG_ARCH:-x86_64-linux}"
ZIG_TARBALL="zig-${ZIG_ARCH}-${ZIG_VERSION}.tar.xz"
ZIG_URL="https://ziglang.org/download/${ZIG_VERSION}/${ZIG_TARBALL}"
ZIG_SHA256="${ZIG_SHA256:-70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00}"
PREFIX="${PREFIX:-/opt/zig}"
INSTALL_DIR="${PREFIX}/${ZIG_VERSION}"
LINK_PATH="${LINK_PATH:-/usr/local/bin/zig}"

install_zig() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Need root for install under ${PREFIX}; re-running with sudo..."
    exec sudo env ZIG_VERSION="$ZIG_VERSION" ZIG_SHA256="$ZIG_SHA256" PREFIX="$PREFIX" LINK_PATH="$LINK_PATH" bash -s -- <<'INNER'
# re-read from stdin not available — fall through using sudo bash "$0" when file
INNER
  fi
}

# Prefer sudo re-exec when not root and script path known
if [[ "$(id -u)" -ne 0 ]]; then
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    echo "Re-running with sudo..."
    exec sudo env ZIG_VERSION="$ZIG_VERSION" ZIG_SHA256="$ZIG_SHA256" PREFIX="$PREFIX" LINK_PATH="$LINK_PATH" bash "${BASH_SOURCE[0]}"
  fi
  if command -v sudo >/dev/null 2>&1; then
    echo "Re-running piped script with sudo -E bash..."
    # When piped, re-invoke via sudo bash reading the already-fetched content is hard;
    # require sudo for the install block only:
    SUDO=(sudo)
  else
    echo "error: run as root or install sudo" >&2
    exit 1
  fi
else
  SUDO=()
fi

echo "==> Zig ${ZIG_VERSION} → ${INSTALL_DIR}"

if [[ -x "${INSTALL_DIR}/zig" ]] && "${INSTALL_DIR}/zig" version 2>/dev/null | grep -qx "${ZIG_VERSION}"; then
  echo "Already installed: $("${INSTALL_DIR}/zig" version)"
  "${SUDO[@]}" ln -sfn "${INSTALL_DIR}/zig" "${LINK_PATH}"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  cd "$TMP"
  echo "==> download ${ZIG_URL}"
  curl -fL --retry 3 -o "${ZIG_TARBALL}" "${ZIG_URL}"
  echo "${ZIG_SHA256}  ${ZIG_TARBALL}" | sha256sum -c -
  tar --no-same-owner -xJf "${ZIG_TARBALL}"
  SRC="$(find . -maxdepth 1 -type d -name "zig-${ZIG_ARCH}-${ZIG_VERSION}" | head -1)"
  "${SUDO[@]}" mkdir -p "${PREFIX}"
  "${SUDO[@]}" rm -rf "${INSTALL_DIR}"
  "${SUDO[@]}" mv "${SRC}" "${INSTALL_DIR}"
  "${SUDO[@]}" ln -sfn "${INSTALL_DIR}/zig" "${LINK_PATH}"
  trap - EXIT
  rm -rf "$TMP"
fi

hash -r 2>/dev/null || true
export PATH="/usr/local/bin:${PATH}"

echo "==> zig version"
zig version
test "$(zig version)" = "${ZIG_VERSION}"

echo "==> wasm probe"
WTMP="$(mktemp -d)"
cd "$WTMP"
cat > hello.zig << 'ZIG'
export fn add(a: i32, b: i32) i32 {
    return a + b;
}
ZIG
zig build-lib \
  -target wasm32-freestanding \
  -dynamic \
  -OReleaseSmall \
  -femit-bin=hello.wasm \
  hello.zig
test -f hello.wasm
head -c 4 hello.wasm | od -An -tx1
BYTES=$(wc -c < hello.wasm | tr -d ' ')
echo "wasm OK (${BYTES} bytes)"
rm -rf "$WTMP"

echo "==> Phase 2.3 complete (Zig ${ZIG_VERSION})"
