# Invincible host scripts

Curl these on the DO runner. The GitHub repo is **private**, so plain  
`raw.githubusercontent.com` URLs return 404 without auth.

## Auth (pick one)

```bash
# Fine-grained or classic PAT with Contents: Read on btipling/invincible
export GH_TOKEN=github_pat_...   # or ghp_...
```

Helper used below:

```bash
gh_raw() {
  # usage: gh_raw path/to/file.sh
  curl -fsSL \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/btipling/invincible/contents/$1?ref=main"
}
```

## Phase 2.3 — Zig (recommended one-shot)

```bash
export GH_TOKEN=...   # once
gh_raw scripts/phase-2.3-zig.sh | bash
# expects: zig version 0.16.0 + "wasm OK"
```

## Split install / verify

```bash
gh_raw scripts/install-zig.sh | bash
gh_raw scripts/verify-zig-wasm.sh | bash
```

## Phase 2.1 host bootstrap (packages + runner user)

```bash
gh_raw scripts/bootstrap-runner-host.sh | sudo bash
```

## No token? (manual)

From a machine with `gh auth`:

```bash
gh api repos/btipling/invincible/contents/scripts/phase-2.3-zig.sh?ref=main \
  -H "Accept: application/vnd.github.raw" | ssh root@204.48.30.46 bash
```

Or clone and run:

```bash
git clone https://github.com/btipling/invincible.git
cd invincible && ./scripts/phase-2.3-zig.sh
```

## Phase 2.7 — harden host

```bash
export GH_TOKEN=...
gh_raw() {
  curl -fsSL \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/btipling/invincible/contents/$1?ref=main"
}

# Default: key-only SSH, UFW SSH-only, unattended-upgrades, restricted runner sudo
gh_raw scripts/harden-runner-host.sh | sudo bash

# Lock SSH to your home/office IP (recommended):
# SSH_ALLOW_FROM='203.0.113.10/32' gh_raw scripts/harden-runner-host.sh | sudo bash
```

Then verify runner Online and re-run smoke:

```bash
gh workflow run runner-smoke.yml --repo btipling/invincible
```



## Phase 3 — fetch harness artifact (Vercel / local)

```bash
# Needs Actions: Read (HARNESS_ARTIFACT_TOKEN or GH_TOKEN)
node scripts/fetch-harness-artifact.mjs
# → public/harness/{harness.wasm,web.js}
```

On Vercel this runs as `npm run prebuild`. Wait-for-commit race fix: see `docs/harness-deploy-race.md`.
Full rebuild path: `docs/phase-3-handoff.md`.
