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
