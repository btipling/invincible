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

## Cloud-native bootstrap (GHA) — phase 1 (#68)

Primary path for migrate+seed **without personal hardware**:

1. Set repository secrets (GitHub **web UI** or `gh secret set` from a cloud agent).
2. Actions → **db-tenancy-bootstrap** → Run workflow with `confirm` = `seed`.
3. Optional: `dry_run` = true validates secrets only (no mutate).

Workflow: [`.github/workflows/db-tenancy-bootstrap.yml`](../.github/workflows/db-tenancy-bootstrap.yml)

### Secret names (values never in git / issues / logs)

| Secret | Required | Notes |
|--------|----------|--------|
| `DATABASE_URL` | yes | Same value as Vercel Production |
| `CREDENTIALS_ENCRYPTION_KEY` | yes | Same value as Vercel Production (base64 32-byte KEK) |
| `SEED_ADMIN_EMAIL` | yes | Bootstrap admin |
| `SEED_ADMIN_PASSWORD` | yes | Re-seed **resets** password hash from this secret |
| `SANDBOX_URL` + `SANDBOX_TOKEN` | yes* | *or* `SEED_SANDBOX_*`; each field prefers `SEED_*` then `SANDBOX_*` (same as `seed-tenancy.ts`) |

**Dual-store identity:** GHA `DATABASE_URL` + `CREDENTIALS_ENCRYPTION_KEY` must
match Vercel Production or tokens will not decrypt after login flip.

**Cutover order:** keep `AUTH_SECRET` unset on Vercel until after seed so
tenancy stays OFF; then set `AUTH_SECRET` and redeploy (parent #67 / phase 3).

Full cutover prose: [docs/bring-your-own.md §4a](../docs/bring-your-own.md#4a-optional-multi-tenant-auth).

### Cloud agent / throwaway workspace alternate

Same scripts as GHA, for a **cloud agent checkout** (or other non-laptop
session) when you inject secrets into **process env for that session only**
(never commit; never paste into issues):

```bash
# Inject the SAME DATABASE_URL + CREDENTIALS_ENCRYPTION_KEY as the target
# Vercel env (dual-store identity). Do **not** openssl-rand a new KEK if
# Production/Preview already has one — wrong KEK → undecryptable tokens.
# Values never committed; session env only.
export DATABASE_URL='…'                      # === Vercel (pooled)
export CREDENTIALS_ENCRYPTION_KEY='…'        # === Vercel (base64 32-byte KEK)
export SEED_ADMIN_EMAIL=admin@example.com
export SEED_ADMIN_PASSWORD='…'
export SANDBOX_URL=http://127.0.0.1:8787     # or SEED_SANDBOX_*
export SANDBOX_TOKEN='…'

npm ci
npm run db:migrate
npm run db:seed
# → logs tenantId / userId / sandboxId only (no secrets)
# Re-seed is idempotent on uniques but **resets** bootstrap password_hash
# and sandbox token ciphertext from env (intentional bootstrap contract).
```

Greenfield throwaway DB only: generate a fresh KEK with
`openssl rand -base64 32` and set that **same** value on the matching Vercel
env before seed — never mint a second key after ciphertext exists.

**Production bootstrap still prefers GHA** (`confirm=seed`). This block is not
a personal-laptop primary path.

Schema: `db/schema.ts`. Crypto: `lib/tenancy/credentials.ts`. Auth.js: JWT + Credentials only (no adapter `accounts`/`sessions` tables).
When tenancy is on: `/login` with seed admin email/password.

## Tenancy public smoke (origin / BYO)

After Production cutover (#70), verify unauth gate without secrets:

```bash
npm run smoke:tenancy
# or: BASE_URL=https://<your-host> npm run smoke:tenancy
```

Expect exit 0 only when `POST /api/agent` returns **401** + exact
`Authentication required.` (see `lib/tenancy/errors.ts`).

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
