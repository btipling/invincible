#!/usr/bin/env bash
# Install pinned Zig for Invincible runner hosts. Idempotent. curl|bash safe.
#
# Private repo:
#   curl -fsSL -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github.raw" \
#     "https://api.github.com/repos/btipling/invincible/contents/scripts/install-zig.sh?ref=main" | bash
set -euo pipefail

ZIG_VERSION="${ZIG_VERSION:-0.16.0}"
ZIG_ARCH="${ZIG_ARCH:-x86_64-linux}"
ZIG_TARBALL="zig-${ZIG_ARCH}-${ZIG_VERSION}.tar.xz"
ZIG_URL="https://ziglang.org/download/${ZIG_VERSION}/${ZIG_TARBALL}"
ZIG_SHA256="${ZIG_SHA256:-70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00}"
PREFIX="${PREFIX:-/opt/zig}"
INSTALL_DIR="${PREFIX}/${ZIG_VERSION}"
LINK_PATH="${LINK_PATH:-/usr/local/bin/zig}"

if [[ "$(id -u)" -ne 0 ]]; then
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" && "${BASH_SOURCE[0]}" != *bash* ]]; then
    echo "Re-running with sudo..."
    exec sudo env ZIG_VERSION="$ZIG_VERSION" ZIG_SHA256="$ZIG_SHA256" PREFIX="$PREFIX" LINK_PATH="$LINK_PATH" bash "${BASH_SOURCE[0]}"
  fi
  SUDO=(sudo)
else
  SUDO=()
fi

echo "==> Zig ${ZIG_VERSION} → ${INSTALL_DIR}"

if [[ -x "${INSTALL_DIR}/zig" ]] && "${INSTALL_DIR}/zig" version 2>/dev/null | grep -qx "${ZIG_VERSION}"; then
  echo "Already installed: $("${INSTALL_DIR}/zig" version)"
  "${SUDO[@]}" ln -sfn "${INSTALL_DIR}/zig" "${LINK_PATH}"
  "${LINK_PATH}" version 2>/dev/null || zig version
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

echo "==> download ${ZIG_URL}"
curl -fL --retry 3 -o "${ZIG_TARBALL}" "${ZIG_URL}"
echo "${ZIG_SHA256}  ${ZIG_TARBALL}" | sha256sum -c -

echo "==> extract"
tar --no-same-owner -xJf "${ZIG_TARBALL}"
SRC="$(find . -maxdepth 1 -type d -name "zig-${ZIG_ARCH}-${ZIG_VERSION}" | head -1)"
if [[ -z "$SRC" ]]; then
  SRC="$(find . -maxdepth 1 -type d -name 'zig-*' | head -1)"
fi
"${SUDO[@]}" mkdir -p "${PREFIX}"
"${SUDO[@]}" rm -rf "${INSTALL_DIR}"
"${SUDO[@]}" mv "${SRC}" "${INSTALL_DIR}"
"${SUDO[@]}" ln -sfn "${INSTALL_DIR}/zig" "${LINK_PATH}"

echo "==> verify"
export PATH="/usr/local/bin:${PATH}"
zig version
echo "OK: zig ${ZIG_VERSION} at ${INSTALL_DIR}"
