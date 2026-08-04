# Security

## Reporting

If you find a vulnerability in Invincible, please open a **private** security advisory on GitHub (or email the maintainer) rather than a public issue with exploit details.

## Secrets

| Never commit | Where it lives |
|--------------|----------------|
| `AI_GATEWAY_API_KEY` | Vercel project env only |
| `HARNESS_ARTIFACT_TOKEN` | Vercel (Actions: Read PAT for artifact download) |
| `VERCEL_DEPLOY_HOOK_URL` | GitHub Actions secrets |
| `SANDBOX_TOKEN` | Vercel project env **and** sandbox process env (same secret) |
| `DATABASE_URL` | Vercel / local only (prefer **pooled** Neon/PgBouncer URL) |
| `CREDENTIALS_ENCRYPTION_KEY` | Vercel / local only — base64 32-byte AES-256-GCM **AMK** (wraps per-tenant DEKs; tokens encrypt under DEK) |
| `SEED_ADMIN_PASSWORD` / `SEED_SANDBOX_TOKEN` | Bootstrap only (prefer GHA `db-tenancy-bootstrap`; cloud-agent `npm run db:seed` alternate); never commit; re-seed resets bootstrap password + token ciphertext |
| `AUTH_SECRET` | Auth.js session secret — set on Vercel **after** migrate/seed (seed does not need it) |
| `AUTH_OIDC_CLIENT_SECRET` | Optional OIDC client secret — Vercel/server only; never `NEXT_PUBLIC_*` |
| `SCIM_BEARER_TOKEN` | Optional SCIM shared bearer — Vercel/server only; IdP → `/api/scim/v2`; never client/Wasm |
| Runner registration tokens, DO API tokens | Operator machines only |

Session blobs and Wasm must never contain API keys or sandbox tokens.  
Never use `NEXT_PUBLIC_SANDBOX_*` (or any client-exposed sandbox secret).

## Self-hosted runner (public repo policy)

Zig builds run on a **self-hosted** GitHub Actions runner (default labels: `self-hosted`, `invincible`, `zig`).

To reduce abuse risk when this repository is **public**:

1. **No `pull_request` / `pull_request_target` triggers** on self-hosted workflows — only `push` to `main` (path-filtered) and `workflow_dispatch`.
2. Jobs include `if:` guards:
   - **Opt-in:** `vars.SELF_HOSTED_BUILDS == 'true'` (repository **Actions variable**, not a secret), **or**
   - **Origin grandfather:** `github.repository == 'btipling/invincible'` (maintainer continuity if the variable is unset)
   - and only `workflow_dispatch` or `push` to `main` (not merely “ref is main”).
3. **Clones / forks** must set `SELF_HOSTED_BUILDS=true` after attaching their own runner. Without that variable, self-hosted jobs **skip** (safe default).
4. Optional: `vars.RUNNER_LABELS` as a JSON array (e.g. `["self-hosted","invincible","zig"]`). If unset, workflows use that default list via `fromJSON`.
5. **Do not** add `pull_request` / `pull_request_target` to those workflows without a deliberate design review.
6. Prefer GitHub setting: require approval for first-time contributors’ workflows; keep fork PR workflows off the self-hosted pool.
7. Host inventory (IPs, droplet IDs) is **not** published in this repo — keep private notes offline.

| Setting | Kind | Purpose |
|---------|------|---------|
| `SELF_HOSTED_BUILDS` | Actions **variable** (`true`) | Enable self-hosted jobs on **this** repository |
| `RUNNER_LABELS` | Actions **variable** (JSON array) | Optional `runs-on` labels override |
| `VERCEL_DEPLOY_HOOK_URL` | Actions **secret** | Post-artifact redeploy (origin) |

Maintainers: still harden the VM (SSH keys, firewall, unattended upgrades) using private runbooks; public docs stay abstract.

## Agent sandbox (not the Zig runner)

The **agent sandbox** is an optional remote workspace for model tools
(`list_dir` / `read_file` / `write_file` / `exec`). It is **not** the
self-hosted GHA runner that compiles Zig.

| Rule | Detail |
|------|--------|
| Separate process | Dedicated OS user/unit; do **not** share Actions credentials with the sandbox env |
| Server-only calls | Only Vercel/Node server calls `SANDBOX_URL` with Bearer `SANDBOX_TOKEN` |
| Path jail | Workspace root + symlink-safe resolve; argv-only `exec` with timeouts |
| Public inventory | Host IPs / droplet IDs stay offline ([docs/sandbox.md](docs/sandbox.md)) |
| No PR trigger surface | Sandbox is not executed by untrusted PR workflows |

## Production app

Inference is server-side only (`POST /api/chat`, `POST /api/agent`). Report
client-side key or sandbox-token exposure immediately.

## Multi-tenant auth (optional)

| Rule | Detail |
|------|--------|
| Triple-env gate | Tenancy on only when `DATABASE_URL` **and** `AUTH_SECRET` **and** `CREDENTIALS_ENCRYPTION_KEY` are set — no separate `AUTH_ENABLED` |
| Tokens at rest | Sandbox bearer secrets AES-256-GCM under **per-tenant DEK** (AMK wraps DEK); dual-read cutover via `TENANT_TOKEN_DECRYPT_MODE` (default `dual`, then `dek-only` after backfill); decrypt only server-side for agent tools / admin mask |
| Never client | No `NEXT_PUBLIC_*` for DB, Auth.js secret, AMK/DEK, sandbox token, OIDC client secret, or SCIM bearer |
| Preview isolation | Prefer separate DB or tenancy off on public previews; avoid reusing Production AMK, OIDC client secret, or `SCIM_BEARER_TOKEN` casually |
| Seed | `SEED_ADMIN_PASSWORD` / seed sandbox token are operator-only; re-seed resets bootstrap hash + ciphertext |
| Bootstrap surface | Prefer GitHub Actions `db-tenancy-bootstrap` or cloud agent workspace — not personal-laptop primary ops |
| OIDC (optional) | `AUTH_OIDC_ISSUER` + `AUTH_OIDC_CLIENT_ID` + `AUTH_OIDC_CLIENT_SECRET` (+ optional `AUTH_OIDC_LABEL`); provider id `oidc`; callback `/api/auth/callback/oidc`; email auto-link requires verified `email_verified` claim |
| SCIM (optional) | `SCIM_BEARER_TOKEN` + tenancy triple; base `/api/scim/v2`; off → **404**; bad Bearer → **401**; DELETE = suspend |
| Hybrid roster | SCIM is **additive** — non-SCIM users remain; `/admin` lists all provision sources; SCIM list = SCIM-managed only |
| Break-glass | Credentials login remains when tenancy is on; SCIM must not suspend break-glass credentials owner |

Unauthenticated API when tenancy is on returns **401** with JSON
`{ "error": "Authentication required." }` (stable `error` constant
`AUTH_REQUIRED_ERROR`). Grant failures return **403**
`{ "error": "Sandbox access denied." }` (`SANDBOX_FORBIDDEN_ERROR`).

Cutover: [docs/bring-your-own.md](docs/bring-your-own.md) §4a.  
OIDC / SCIM operator notes: [docs/bring-your-own.md](docs/bring-your-own.md) §4b.

