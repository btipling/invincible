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
| `seed-tenancy.ts` | Phase 1: idempotent tenancy seed (`npm run db:seed`) |

## Phase 1 — Postgres migrate + seed

Local / bootstrap (values never committed):

```bash
# Prefer pooled DATABASE_URL on Vercel (Neon pooler).
export DATABASE_URL=postgres://… 
export CREDENTIALS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export SEED_ADMIN_EMAIL=admin@example.com
export SEED_ADMIN_PASSWORD='…'
export SANDBOX_URL=http://127.0.0.1:8787
export SANDBOX_TOKEN='…'

npm run db:migrate
npm run db:seed
# → logs tenantId / userId / sandboxId only (no secrets)
# Re-seed is idempotent on uniques but **resets** bootstrap password_hash
# and sandbox token ciphertext from env (intentional bootstrap contract).
```

Schema: `db/schema.ts`. Crypto: `lib/tenancy/credentials.ts`. Auth.js tables: phase 2.

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
