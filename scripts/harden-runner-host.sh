#!/usr/bin/env bash
# Phase 2.7 — harden Invincible DO build host (curl|bash safe).
#
#   gh_raw scripts/harden-runner-host.sh | sudo bash
#
# Optional env:
#   SSH_ALLOW_FROM=203.0.113.10/32   # UFW: only this CIDR may hit :22 (repeat with spaces)
#   SKIP_UFW=1                      # skip firewall (not recommended)
#   SKIP_SSH=1                      # skip sshd_config changes
#   KEEP_RUNNER_NOPASSWD=1          # keep full passwordless sudo for runner (default: restrict)
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" && "${BASH_SOURCE[0]}" != *bash* ]]; then
    exec sudo env SSH_ALLOW_FROM="${SSH_ALLOW_FROM:-}" SKIP_UFW="${SKIP_UFW:-}" SKIP_SSH="${SKIP_SSH:-}" \
      KEEP_RUNNER_NOPASSWD="${KEEP_RUNNER_NOPASSWD:-}" bash "${BASH_SOURCE[0]}"
  fi
  echo "error: run as root (sudo)" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> packages: ufw unattended-upgrades"
apt-get update -y
apt-get install -y --no-install-recommends ufw unattended-upgrades apt-listchanges

echo "==> unattended-upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'APT'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT
# Enable security updates (Ubuntu default template)
if [[ -f /etc/apt/apt.conf.d/50unattended-upgrades ]]; then
  sed -i 's|^//\s*"\${distro_id}:\${distro_codename}-security";|        "${distro_id}:${distro_codename}-security";|' \
    /etc/apt/apt.conf.d/50unattended-upgrades || true
fi
systemctl enable unattended-upgrades.service 2>/dev/null || true
systemctl start unattended-upgrades.service 2>/dev/null || true

if [[ "${SKIP_SSH:-}" != "1" ]]; then
  echo "==> SSH harden (key-only)"
  mkdir -p /etc/ssh/sshd_config.d
  cat >/etc/ssh/sshd_config.d/99-invincible-harden.conf <<'SSH'
# Invincible Phase 2.7 — managed by scripts/harden-runner-host.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin prohibit-password
PubkeyAuthentication yes
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
SSH
  # Validate config before reload
  if sshd -t; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || systemctl restart ssh
    echo "sshd reloaded"
  else
    echo "error: sshd -t failed; leaving old config" >&2
    rm -f /etc/ssh/sshd_config.d/99-invincible-harden.conf
    exit 1
  fi
  # Warn if no authorized_keys for root/runner
  for u in root runner; do
    home=$(eval echo "~$u" 2>/dev/null || true)
    if [[ -n "$home" && -f "$home/.ssh/authorized_keys" ]]; then
      keys=$(grep -cE '^(ssh-|ecdsa-|ed25519)' "$home/.ssh/authorized_keys" 2>/dev/null || echo 0)
      echo "  $u authorized_keys: $keys line(s)"
    else
      echo "  WARN: no authorized_keys for $u — use DO web console if locked out"
    fi
  done
else
  echo "==> SKIP_SSH=1"
fi

if [[ "${SKIP_UFW:-}" != "1" ]]; then
  echo "==> UFW: default deny inbound, allow SSH"
  ufw --force reset >/dev/null
  ufw default deny incoming
  ufw default allow outgoing
  if [[ -n "${SSH_ALLOW_FROM:-}" ]]; then
    for cidr in ${SSH_ALLOW_FROM}; do
      echo "  allow 22/tcp from $cidr"
      ufw allow from "$cidr" to any port 22 proto tcp comment 'invincible-ssh'
    done
  else
    echo "  allow 22/tcp from anywhere (set SSH_ALLOW_FROM to lock down)"
    ufw allow 22/tcp comment 'invincible-ssh'
  fi
  # Explicitly do NOT open 80/443 — build box is not a web server
  ufw --force enable
  ufw status verbose
else
  echo "==> SKIP_UFW=1"
fi

echo "==> runner sudo policy"
if id runner >/dev/null 2>&1; then
  if [[ "${KEEP_RUNNER_NOPASSWD:-}" == "1" ]]; then
    echo 'runner ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/runner
    echo "  kept full NOPASSWD (KEEP_RUNNER_NOPASSWD=1)"
  else
    # GHA jobs should not need sudo; allow limited package ops for maintenance
    cat >/etc/sudoers.d/runner <<'SUDO'
# Invincible Phase 2.7 — restricted passwordless sudo
runner ALL=(root) NOPASSWD: /usr/bin/apt-get, /usr/bin/apt, /usr/bin/systemctl status *, /usr/bin/systemctl restart actions.runner.*, /usr/bin/systemctl start actions.runner.*, /usr/bin/systemctl stop actions.runner.*, /home/runner/actions-runner/svc.sh
SUDO
    echo "  restricted NOPASSWD (apt + runner service only)"
  fi
  chmod 440 /etc/sudoers.d/runner
  visudo -cf /etc/sudoers.d/runner
else
  echo "  WARN: user runner missing"
fi

echo "==> verify runner not root"
if systemctl is-active --quiet 'actions.runner.btipling-invincible.invincible-do-1.service' 2>/dev/null; then
  unit='actions.runner.btipling-invincible.invincible-do-1.service'
  user=$(systemctl show -p User --value "$unit" || true)
  echo "  unit $unit User=$user Active=$(systemctl is-active "$unit")"
  if [[ "$user" == "root" ]]; then
    echo "error: runner service running as root" >&2
    exit 1
  fi
else
  echo "  note: invincible-do-1 unit not active (check name if re-registered)"
  systemctl list-units 'actions.runner.*' --no-pager || true
fi

echo "==> disk snapshot"
df -h /
du -sh /home/runner/actions-runner/_work 2>/dev/null || true
du -sh /opt/zig 2>/dev/null || true

# Marker for ops
mkdir -p /var/lib/invincible
date -u +%Y-%m-%dT%H:%M:%SZ >/var/lib/invincible/hardened-at
echo "2.7" >/var/lib/invincible/harden-version

echo "==> Phase 2.7 host harden complete"
echo "    Confirm: GitHub runner still Idle/Online"
echo "    Optional: DO UI → Billing → set spend alert; Cloud Firewall mirror of UFW"
