#!/usr/bin/env bash
# Create invincible-runner via doctl (requires write-capable DIGITALOCEAN_ACCESS_TOKEN).
# Usage:
#   export DIGITALOCEAN_ACCESS_TOKEN=dop_v1_...
#   ./scripts/create-invincible-droplet.sh
set -euo pipefail

: "${DIGITALOCEAN_ACCESS_TOKEN:?set DIGITALOCEAN_ACCESS_TOKEN with droplet:create scope}"

NAME="${NAME:-invincible-runner}"
REGION="${REGION:-sfo3}"
SIZE="${SIZE:-s-2vcpu-4gb}"
IMAGE="${IMAGE:-ubuntu-24-04-x64}"
TAGS="${TAGS:-invincible,gha-runner}"

if ! command -v doctl >/dev/null 2>&1; then
  echo "doctl not found; install from https://docs.digitalocean.com/reference/doctl/how-to/install/" >&2
  exit 1
fi

doctl auth init -t "$DIGITALOCEAN_ACCESS_TOKEN" >/dev/null

# Prefer all account SSH keys so you can log in
mapfile -t KEY_IDS < <(doctl compute ssh-key list --format ID --no-header 2>/dev/null || true)
SSH_ARGS=()
if ((${#KEY_IDS[@]} > 0)); then
  SSH_ARGS=(--ssh-keys "$(IFS=,; echo "${KEY_IDS[*]}")")
  echo "Using SSH keys: ${KEY_IDS[*]}"
else
  echo "WARNING: no SSH keys on the DO account; root password will be emailed." >&2
fi

echo "Creating droplet name=$NAME region=$REGION size=$SIZE image=$IMAGE"
CREATE_OUT=$(doctl compute droplet create "$NAME" \
  --region "$REGION" \
  --size "$SIZE" \
  --image "$IMAGE" \
  --tag-names "$TAGS" \
  --enable-monitoring \
  --wait \
  "${SSH_ARGS[@]}" \
  --format ID,Name,PublicIPv4,Status,Region,Memory,VCPUs \
  --no-header)

echo "$CREATE_OUT"
DROPLET_ID=$(echo "$CREATE_OUT" | awk '{print $1}')
IP=$(doctl compute droplet get "$DROPLET_ID" --format PublicIPv4 --no-header)

echo
echo "Droplet ID: $DROPLET_ID"
echo "Public IP:  $IP"
echo
echo "Bootstrap (from this repo):"
echo "  ssh root@$IP 'bash -s' < scripts/bootstrap-runner-host.sh"
echo "Or:"
echo "  scp scripts/bootstrap-runner-host.sh root@$IP:/tmp/ && ssh root@$IP bash /tmp/bootstrap-runner-host.sh"
echo
echo "Record ID/IP/region/size in docs/runner.md and docs/project-ids.md"
