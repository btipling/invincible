# Invincible host scripts

Scripts for provisioning / verifying the **self-hosted Zig runner**.  
Host IPs and cloud account IDs are **not** documented here (private operator notes).

## Public clone (no PAT)

When the repo is public:

```bash
git clone https://github.com/btipling/invincible.git
cd invincible
# on the runner host:
sudo bash scripts/bootstrap-runner-host.sh
bash scripts/phase-2.3-zig.sh
```

Or raw over HTTPS:

```bash
curl -fsSL https://raw.githubusercontent.com/btipling/invincible/main/scripts/phase-2.3-zig.sh | bash
```

## Private-era / restricted raw (optional)

If Contents API is required:

```bash
export GH_TOKEN=…   # Contents: Read — never commit
gh_raw() {
  curl -fsSL \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/btipling/invincible/contents/$1?ref=main"
}
gh_raw scripts/phase-2.3-zig.sh | bash
```

## Scripts

| Script | Role |
|--------|------|
| `bootstrap-runner-host.sh` | packages + `runner` user |
| `phase-2.3-zig.sh` / `install-zig.sh` / `verify-zig-wasm.sh` | Zig 0.16.0 pin |
| `harden-runner-host.sh` | SSH/UFW baseline (run with care) |
| `create-invincible-droplet.sh` | DO create (needs write token on laptop) |
| `fetch-harness-artifact.mjs` | Vercel/local: download `harness-wasm` artifact |

## Phase 3 — fetch harness artifact (Vercel / local)

```bash
# Needs Actions: Read (HARNESS_ARTIFACT_TOKEN or GH_TOKEN)
node scripts/fetch-harness-artifact.mjs
# → public/harness/{harness.wasm,web.js}
```

On Vercel this runs as `npm run prebuild`. Race wait: `docs/harness-deploy-race.md`.  
Product path: `docs/phase-4-handoff.md`.

## Safety

- Never pass live tokens into chat, issues, or commits.
- Do not document production host IPs in this repo ([SECURITY.md](../SECURITY.md)).
