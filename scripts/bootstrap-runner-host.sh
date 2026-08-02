#!/usr/bin/env bash
# Phase 2.1 host bootstrap for invincible-runner
# Run once on a fresh Ubuntu 24.04 droplet as root (or via: ssh root@IP 'bash -s' < scripts/bootstrap-runner-host.sh)
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "==> apt update/upgrade"
apt-get update -y
apt-get upgrade -y

echo "==> baseline packages"
apt-get install -y --no-install-recommends \
  curl \
  ca-certificates \
  git \
  build-essential \
  jq \
  unzip \
  sudo \
  gnupg \
  openssh-client

echo "==> ensure runner user"
if ! id -u runner >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash runner
fi
usermod -aG sudo runner
# passwordless sudo for package installs during Phase 2 (tighten in 2.7)
echo 'runner ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/runner
chmod 440 /etc/sudoers.d/runner

# Copy root authorized_keys to runner if present (so same DO SSH keys work)
if [[ -f /root/.ssh/authorized_keys ]]; then
  install -d -m 700 -o runner -g runner /home/runner/.ssh
  install -m 600 -o runner -g runner /root/.ssh/authorized_keys /home/runner/.ssh/authorized_keys
fi

echo "==> outbound HTTPS check"
curl -fsSL -o /dev/null -w "github.com %{http_code}\n" https://github.com/ || true
curl -fsSL -o /dev/null -w "objects.githubusercontent.com %{http_code}\n" https://objects.githubusercontent.com/ || true

echo "==> host identity"
hostnamectl || true
uname -a
echo "bootstrap complete — next: Phase 2.2 (GitHub Actions runner as user runner)"
