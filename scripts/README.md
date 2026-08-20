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

## Schema-only migrate (GHA) — db-migrate

Primary path for **additive schema** on existing Production (e.g. provider secrets /
BYOK tables):

1. Repository secret **`DATABASE_URL`** === Vercel Production (dual-store).
2. Actions → **db-migrate** → Run workflow with `confirm` = `migrate`.
3. Optional `dry_run` = true validates secret presence only (no mutate).

The workflow (and `npm run db:migrate` / `npm test`) runs
`scripts/drizzle-journal-gate.mjs` **before** `drizzle-kit migrate`. SQL files
under `db/migrations/` that are missing from `meta/_journal.json` fail the job
instead of a silent no-op (#735).

Workflow: [`.github/workflows/db-migrate.yml`](../.github/workflows/db-migrate.yml)

This is the schema-only path; the tenancy bootstrap is the app's first-run
sign-up (below). Do **not** use this workflow for data/backfill cutovers.

Full BYOK operator notes: [docs/bring-your-own.md §4a Inference keys](../docs/bring-your-own.md#inference-keys-byok).

## Tenancy bootstrap — first-run sign-up (no laptop)

A fresh database bootstraps itself through the app:

1. Ensure the tenancy triple is set and migrate schema via GHA **db-migrate**
   (`DATABASE_URL`, `CREDENTIALS_ENCRYPTION_KEY`, and the Auth.js secret in
   Vercel Production).
2. Open `/login` — if the DB has **no tenant**, a sign-up form creates the
   **first tenant + owner** in one step. Existing tenanted DBs never show it.
3. After sign-up, the owner provisions a sandbox at **`/admin/sandboxes`**;
   agent turns fail closed until one exists.

This is the config-free bootstrap: just `db-migrate` then open the app — no
workflow, no personal hardware. See
[docs/bring-your-own.md §4a](../docs/bring-your-own.md#4a-optional-multi-tenant-auth).

Schema: `db/schema.ts`. Crypto: `lib/tenancy/credentials.ts`. Auth.js: JWT + Credentials only (no adapter `accounts`/`sessions` tables).
When tenancy is on: `/login` with the owner email/password created at sign-up.

## Tenancy public smoke (origin / BYO)

After Production cutover (#70), verify unauth gate without secrets:

```bash
npm run smoke:tenancy
# or: BASE_URL=https://<your-host> npm run smoke:tenancy
```

Expect exit 0 only when `POST /api/agent` returns **401** + exact
`Authentication required.` (see `lib/tenancy/errors.ts`).

## Fetch harness artifact (Vercel / local)


```bash
# Needs Actions: Read (HARNESS_ARTIFACT_TOKEN or GH_TOKEN)
node scripts/fetch-harness-artifact.mjs
# → public/harness/{harness.wasm,web.js}
```

On Vercel this runs as `npm run prebuild`. Race wait: `docs/harness-deploy-race.md`.  
Product path: [README](../README.md) · [feature-divide.md](../docs/feature-divide.md).

## Sandbox orphan cleanup (optional)

List/delete leftover **product** Vercel Sandbox names (`inv-workspace-…` / `inv-http-…`)
that are **not** in `user_sandbox_instances`. Primary operator path is GitHub Actions:

**Actions → `sandbox-orphan-cleanup` → Run workflow**

| Input | Default | Meaning |
|-------|---------|---------|
| `confirm` | (required) | must equal `cleanup` |
| `dry_run` | `true` | list candidates only |
| `include_non_product` | `false` | if true, also old non-persistent non-product VMs ≥24h (project-wide) |

Secrets (names only; dual-store `DATABASE_URL` with Production): `DATABASE_URL`,
`VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`.

Script: `scripts/sandbox-orphan-cleanup.mjs` (never `Sandbox.create` / `getOrCreate`).
Docs: [docs/sandbox.md](../docs/sandbox.md).

## Safety

- Never pass live tokens into chat, issues, or commits.
- Do not document production host IPs in this repo ([SECURITY.md](../SECURITY.md)).
