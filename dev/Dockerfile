# Invincible dogfood sandbox image — toolchain only (no app source).
# Build (repo root): docker buildx build --platform linux/amd64 -f dev/Dockerfile -t invincible-dev .
# Context must include native/ZIG_VERSION.
# Sandbox.create ignores ENTRYPOINT/CMD; tools run via exec/runCommand.

FROM --platform=linux/amd64 ubuntu:24.04

LABEL org.opencontainers.image.source="https://github.com/btipling/invincible" \
      org.opencontainers.image.title="invincible-dev" \
      org.opencontainers.image.description="Agent/dev toolchain for Invincible dogfood sandboxes (Node, Zig, gh, rg)"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH="/usr/local/node/bin:/usr/local/bin:${PATH}"

# Pin Node major 22 (match origin GHA). Bump patch intentionally when refreshing image.
ARG NODE_VERSION=22.17.0
# Zig pin file from repo (must match native/ZIG_VERSION on the build ref).
COPY native/ZIG_VERSION /tmp/ZIG_VERSION

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      build-essential \
      python3 \
      gnupg \
      xz-utils \
      unzip; \
    rm -rf /var/lib/apt/lists/*; \
    \
    # Node.js 22 (official linux x64 tarball)
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      -o /tmp/node.tar.xz; \
    mkdir -p /usr/local/node; \
    tar -xJf /tmp/node.tar.xz -C /usr/local/node --strip-components=1; \
    rm /tmp/node.tar.xz; \
    node -v | grep -E '^v22\.'; \
    npm -v; \
    \
    # GitHub CLI
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg; \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    gh --version; \
    \
    # ripgrep (pinned deb)
    RG_VER=14.1.1; \
    curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VER}/ripgrep_${RG_VER}-1_amd64.deb" \
      -o /tmp/rg.deb; \
    dpkg -i /tmp/rg.deb; \
    rm /tmp/rg.deb; \
    rg --version; \
    \
    # Zig (official tarball; pin from native/ZIG_VERSION)
    PIN="$(tr -d '[:space:]' < /tmp/ZIG_VERSION)"; \
    test -n "$PIN"; \
    curl -fsSL "https://ziglang.org/download/${PIN}/zig-x86_64-linux-${PIN}.tar.xz" \
      -o /tmp/zig.tar.xz; \
    mkdir -p /opt/zig; \
    tar -xJf /tmp/zig.tar.xz -C /opt/zig --strip-components=1; \
    ln -sfn /opt/zig/zig /usr/local/bin/zig; \
    rm /tmp/zig.tar.xz /tmp/ZIG_VERSION; \
    test "$(zig version)" = "$PIN"; \
    \
    apt-get purge -y gnupg || true; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /workspace

WORKDIR /workspace

# No secrets. No app tree. Sandbox does not rely on CMD.
CMD ["/bin/bash"]
