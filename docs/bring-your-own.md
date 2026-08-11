# Bring your own Vercel + keys

End-to-end guide for **third-party operators**: clone this repository, attach
**your** Vercel project and AI Gateway key, supply harness Wasm, and run the
product without depending on the maintainer production URL.

You own the GitHub repo (clone/fork), the Vercel project, the secrets, the
Postgres tenancy, and (optionally) the self-hosted runner. This is
**bring-your-own deploy**, not a hosted multi-tenant SaaS control plane.
**Postgres tenancy + login are required** and always on — see
[§4a](#4a-multi-tenant-auth).

**Maintainer sample deployment** (demos only): see [project-ids.md](project-ids.md)
and the **Reference deployment** section in the [README](../README.md). Success
for BYO does **not** require `invincible-dun-ten.vercel.app`.

Related: [feature-divide.md](feature-divide.md) · [sandbox.md](sandbox.md) ·
[SECURITY.md](../SECURITY.md) · [runner.md](runner.md) ·
[harness-deploy-race.md](harness-deploy-race.md) · [AGENTS.md](../AGENTS.md)

---

## 1. What you get

| Piece | Role |
|-------|------|
| **Wasm harness** | Primary product UI — transcript, composer, Send, busy/error chrome |
| **Next.js host** | Shell only — nav, load module, bridge glue, SessionStore, thin status chips |
| **`POST /api/chat`** | Server-side single-shot inference via **your** Vercel AI Gateway key |
| **`POST /api/agent`** | Optional multi-step tools when you configure a **sandbox** ([sandbox.md](sandbox.md)) |

- Secrets stay on the **server** (Vercel env). Never put `AI_GATEWAY_API_KEY` or
  `SANDBOX_TOKEN` in client code, Wasm, or the browser.
- Do **not** build a competing React chat panel — canvas is the workspace.
- **Sandbox MVP is shipped**; product tool turns resolve sandbox from **DB
  grants**, not raw env (`SANDBOX_URL` + `SANDBOX_TOKEN` are seed/local-daemon
  only). Without a usable grant + no alternate tools → **403** — there is **no**
  503 → chat fallback. Full guide: [sandbox.md](sandbox.md).
- **Multi-tenant auth** (login + DB sandbox grants) is **required and always
  on** — every deploy configures the triple. See
  [§4a](#4a-multi-tenant-auth). Per-row sandbox **backend** + image
  admin is at `/admin/sandboxes` ([sandbox.md](sandbox.md)). **Per-user MCP** is
  shipped — [mcp.md](mcp.md). Multi-tenant process/fleet isolation (single
  workspace root per process) remains future — see [§8 Future](#8-future-not-shipped).

---

## 2. Prerequisites

| Need | Notes |
|------|--------|
| **Node.js 18+** | Next.js 15 app |
| **GitHub** | Your clone or fork of this repo |
| **Vercel account** | New project linked to **your** repo (any project name) |
| **AI Gateway key** | Create via [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) |
| **Optional** | Self-hosted runner with Zig **0.16.0** if you will rebuild `native/harness` |

---

## 3. Quick path (local app + keys)

```bash
git clone <your-fork-or-clone-url>
cd invincible
npm install
cp .env.example .env.local
# edit .env.local — set AI_GATEWAY_API_KEY=…
```

### Harness files (`public/harness/`)

Binaries are **gitignored**. Pick one:

| Approach | How |
|----------|-----|
| Fetch artifact | `HARNESS_ARTIFACT_TOKEN=<PAT with Actions:Read> npm run fetch-harness` |
| Skip network | `HARNESS_SKIP_FETCH=1` if you already have valid files under `public/harness/` |
| Local Zig | Build on a machine with Zig 0.16.0 per [native/harness/README.md](../native/harness/README.md), then sync into `public/harness/` |

```bash
npm run dev
# open http://localhost:3000/harness
```

Optional overrides (see `.env.example`): `HARNESS_OWNER`, `HARNESS_REPO`,
wait/poll knobs for deploy races.

**Local resolution note:** when not in “require” mode, owner/repo can fall back
to `btipling/invincible` if no git env is set. Prefer explicit `HARNESS_*` or a
normal Vercel Git deploy so fetches hit **your** artifacts. Resolution order is
documented in `scripts/harnessRepo.mjs`.

---

## 4. Deploy on your Vercel

1. Import **your** GitHub repository into Vercel → create a **new** project
   (name is yours; it does not need to match the maintainer’s).
2. **Choose a Wasm supply path before first prod deploy** (see [§5](#5-wasm-supply-paths)).
   A fresh fork/clone has **no** `harness-wasm` Actions artifact until **you** publish
   one (path **A**) or you point fetch at a repo that already publishes it (path **B**).
   Without that, Vercel prebuild resolves owner/repo to **your** connected git repo,
   finds nothing, and the deploy fails or ships an empty harness.
3. Set **Environment Variables** (Production + Preview as needed):

| Name | Required | Purpose |
|------|----------|---------|
| `AI_GATEWAY_API_KEY` | **Yes** | Server-side inference — never client/Wasm |
| `HARNESS_ARTIFACT_TOKEN` | **Yes** for prod builds that download Wasm | Fine-grained PAT: **Actions: Read** on the repo that publishes artifact `harness-wasm` (your repo for path **A**, or the upstream/build repo for path **B**) |
| `HARNESS_OWNER` / `HARNESS_REPO` | **Yes until your repo publishes `harness-wasm`** | Point at a repo that already has artifact `harness-wasm` (typical cold-start: path **B**). Once path **A** has uploaded artifacts on **your** repo, omit these so Vercel Git env (`VERCEL_GIT_REPO_OWNER` / `VERCEL_GIT_REPO_SLUG`) is used |
| `SANDBOX_URL` / `SANDBOX_TOKEN` | No | Seed / local daemon only — product tool turns resolve sandbox from **DB grants**; **server only**, URL reachable from Vercel in prod ([sandbox.md](sandbox.md)). Per-sandbox config: [§4a](#4a-multi-tenant-auth) |
| `AGENT_MAX_STEPS` | No | Optional safety ceiling (1…256); **omit** for model-ended tool loop + user Stop |

4. Optional GitHub Actions **secret** (on **your** repo): `VERCEL_DEPLOY_HOOK_URL` —
   only if you use `build-harness`’s post-artifact deploy-hook ping. Not required
   for a first deploy once prebuild can fetch a real artifact (Git integration
   redeploy alone does **not** create Wasm).
5. Deploy. Open **`https://<your-vercel-host>/harness`**.

On Vercel Git deploys, artifact owner/repo resolve to the **connected** Git repo
unless you set `HARNESS_*`. Runtime does **not** depend on the maintainer prod
**host** URL — but cold-start forks **do** need an explicit artifact **source**
(path **B** or a completed path **A**) before prebuild succeeds.

Race-safe wait for the matching `harness-wasm` artifact:
[harness-deploy-race.md](harness-deploy-race.md).

---

## 4a. Multi-tenant auth

Postgres tenancy is **required and always on** for every deploy: credentials
login, login wall + fail-closed session gate on harness/APIs, DB-resolved
sandbox credentials + R/W grants, and a minimal `/admin` shell. **Every page is
behind a login wall** and protected APIs fail closed with 401 when
unauthenticated.

Cloud-native cutover (no personal hardware). GHA bootstrap workflow:
[`.github/workflows/db-tenancy-bootstrap.yml`](../.github/workflows/db-tenancy-bootstrap.yml).

### Enablement (triple env — no AUTH_ENABLED flag)

Tenancy is enabled when **all three** are non-empty on the **running** deploy;
any missing var is a misconfiguration (no open fallback):

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres (prefer **pooled** Neon / PgBouncer URL on Vercel) |
| `AUTH_SECRET` | Auth.js session signing (`openssl rand -base64 32`) |
| `CREDENTIALS_ENCRYPTION_KEY` | Base64 **32-byte** AES-256-GCM **AMK** (wraps per-tenant DEKs; tokens encrypt under DEK) (`openssl rand -base64 32`) — not a fourth secret |

### Behaviour

| Surface | Behaviour |
|---------|-----------|
| Unauthenticated `/api/chat` or `/api/agent` | **401** `{ "error": "Authentication required." }` |
| Unauthenticated `/`, `/harness`, `/admin` | Redirect to `/login?callbackUrl=…` |
| Agent tools | **DB-resolved** sandbox for the session user (grants enforced); not raw process env alone |
| `/admin` | Owner|admin: tenant + **Users** roster + sandboxes + **Inference keys** (`/admin/inference`) + encryption; tokens/credentials **masked** |
| `/settings` | Signed-in member with **sole** tenant membership: personal **MCP servers** (`/settings/mcp`) — not shared Admin; keys masked |
| Logout | Clears Auth.js session (and local harness session blob) |

Grant failures return **403** `{ "error": "Sandbox access denied." }`
(`SANDBOX_FORBIDDEN_ERROR`). See [sandbox.md](sandbox.md).

### Multi-device harness session

Each signed-in user has one durable harness transcript row in Postgres
(`harness_sessions`), synced by the host after local first paint.

| Need | Action |
|------|--------|
| Schema | GitHub Actions → **`db-migrate`** → `confirm=migrate` (includes `harness_sessions`). Workflow: [`.github/workflows/db-migrate.yml`](../.github/workflows/db-migrate.yml). Do **not** use `db-tenancy-bootstrap` / seed solely for this table. |
| Runtime | Tenancy triple env already on; user signs in → `/harness` |
| Smoke | Same user, two browsers: turn on A → refresh B shows messages; Clear on A → DELETE cloud row |
| Failures | Unauth → **401**; no row yet → **404** `NOT_FOUND`; store unavailable → **503**. Auth is always required |

Product detail (LWW, caps, hybrid wire): [session-model.md](session-model.md).  
Security boundary: [SECURITY.md](../SECURITY.md) (Harness session store).

### Sandboxes (BYO daemon vs Vercel)

Each **sandbox row** chooses a backend — not a host env flip
(`SANDBOX_BACKEND` is **not** a product setting).

| Backend | Admin | Credentials |
|---------|-------|-------------|
| **byo** | URL + token | Token encrypted under tenant DEK |
| **vercel** | Image preset or custom VCR/VMI ref (null = universal default) | Host Vercel project OIDC/quota; no BYO URL/token on the row |

Create and edit at **`/admin/sandboxes`**. Schema for `backend`/`image` ships via
GHA **`db-migrate`**. Seed bootstrap may set `SEED_SANDBOX_BACKEND=vercel` and
optional `SEED_SANDBOX_IMAGE` (seed-only env names).

**Dogfood / custom toolchain images:** the app runtime does **not** build images.
Origin (and forks) may push a first-party image with Docker + VCR auth. Origin
reference: repo [`dev/Dockerfile`](../dev/Dockerfile) + GHA **`dev-image-build`**
(`confirm=push`; secrets/vars **`VERCEL_TOKEN`**, **`VERCEL_TEAM_ID`**,
**`VCR_IMAGE_PREFIX`** — names only). Point the sandbox **image** field at
`${VCR_IMAGE_PREFIX}/invincible-dev:latest` after VCR shows **Ready**. Details:
[dev/README.md](../dev/README.md), [sandbox.md](sandbox.md).

V1 agent resolve still requires **exactly one** usable grant per user. Creating a
sandbox in admin grants you R/W and revokes your other grants on that tenant so
the agent keeps a single workspace.

Builtin HTTPS fetch (`http_get`) is unrelated to `backend=vercel` — see
[builtin-http.md](builtin-http.md) (possible second VM when both are enabled).

### Inference keys (BYOK)


Inference uses **tenant Bring-Your-Own-Key (BYOK)** so **provider billing is
the tenant’s**, not Invincible host system credits.

| Role | What they do |
|------|----------------|
| Tenant **admin** / owner | `/admin/inference` — create provider secrets (encrypted under the **tenant DEK**), attach **model ids**, grant members **`can_use`**. UI shows **masks** only — never plaintext keys. |
| Member | Signs in → `/harness` → catalog from **`GET /api/models`** (session-gated, grants only) → cycles model with **Next** in the **canvas** header (protocol v3) → Send. Host chip **mirrors** selection (not a second picker). |

**Request path:**

1. Host reads selected model id from the Wasm bridge and POSTs `{ prompt, modelId? }` to `/api/chat` or `/api/agent`.
2. Server re-authorizes grants and attaches **request-scoped**
   `providerOptions.gateway.byok` + `only` (never routes via a host env-model
   fallback).
3. Missing grants / unauthorized model → **4xx** — not silent host spend.
4. Empty catalog → host blocks Send with an in-canvas error (reload if catalog failed to load).

**`AI_GATEWAY_API_KEY` is still required** on the host (Gateway routing/auth). It
is **not** a substitute for tenant provider keys.

**Schema (provider secrets tables):** if the BYOK tables are not yet applied on
Production Postgres, run **schema-only** migrate — **not** seed/bootstrap:

1. Actions → **db-migrate** → Run workflow  
2. `confirm` = `migrate` (required)  
3. Optional `dry_run` = true (validate `DATABASE_URL` presence only)  
4. Workflow: [`.github/workflows/db-migrate.yml`](../.github/workflows/db-migrate.yml)  
5. Repository secret **`DATABASE_URL`** must equal Vercel Production (dual-store)

Do **not** use `db-tenancy-bootstrap` / seed for schema-only BYOK cutover (seed
resets bootstrap password hash + sandbox token ciphertext).

#### Operator checklist (BYOK inference)

Timeless steps (no personal-laptop Production shell):

1. **Schema (if needed):** Actions → **db-migrate** → `confirm=migrate` (optional `dry_run=true` first).
2. **App:** tenancy triple on Production; redeploy if you just migrated.
3. **Vercel credits:** team has **paid AI Gateway credits** (BYOK is not on free tier).
4. **Admin:** sign in → **`/admin/inference`** → create provider secret + model ids → grant members.
5. **Harness:** member → `/harness` → catalog loads → **Next** cycles models → Send; chip mirrors selection.
6. **Negative smoke:** member without grant cannot use ungranted models; empty catalog does not hit Gateway.
7. **Never** put provider API keys in client, Wasm, git, issues, or logs.

Also: [SECURITY.md](../SECURITY.md) · [feature-divide.md](feature-divide.md) ·
[native/harness/README.md](../native/harness/README.md).

### Per-user MCP servers

Each signed-in member with a **sole** tenant membership can register personal
**remote HTTPS MCP** servers under **Settings → MCP servers** (`/settings/mcp`).
API keys (optional) are encrypted under the **tenant DEK**. Tools load on
**agent** turns only (`POST /api/agent`), merged with sandbox tools
under the `mcp_*` name prefix.

| Role | What they do |
|------|----------------|
| Member (sole membership) | `/settings/mcp` — CRUD servers, Test connection, enable/disable. Mask only — never plaintext after save. |
| Owner | DEK rotate on `/admin` also re-encrypts MCP header ciphertexts. |

**Schema (`user_mcp_servers`):** same schema-only path as BYOK tables — Actions →
**db-migrate** → `confirm=migrate` (not seed). Dual-store `DATABASE_URL` ≡ Vercel
Production.

Full guide + **Exa** operator smoke checklist: **[mcp.md](mcp.md)**.

### Cloud cutover checklist (primary path)

Tenancy turns **on** only when **all three** secrets are present on the running
deploy. Seed needs `DATABASE_URL` + `CREDENTIALS_ENCRYPTION_KEY` (+ seed inputs)
but **not** `AUTH_SECRET`. Prefer finishing migrate/seed **before** the third
var lands on Production so tenancy does not activate against an empty DB.

**Dual-store identity:** GitHub Actions secrets `DATABASE_URL` and
`CREDENTIALS_ENCRYPTION_KEY` must be the **same values** as Vercel Production
runtime. Wrong AMK → unwrap of tenant DEKs fails (agent/tools 403).

### Per-tenant DEK envelope + cutover

- **AMK** = `CREDENTIALS_ENCRYPTION_KEY` (env only). **DEK** = random 32-byte key
  per tenant, stored AMK-wrapped on `tenants.dek_ciphertext`.
- Product paths encrypt sandbox tokens under the **tenant DEK**. Runtime default
  is **dual-read** (`TENANT_TOKEN_DECRYPT_MODE` unset or `dual`: try DEK, then
  AMK) so legacy AMK ciphertext still works until backfill completes.
- **Greenfield:** GHA **db-tenancy-bootstrap** (migrate + seed) — seed **ensures**
  a DEK and encrypts the bootstrap sandbox token under it.
- **Existing Production data (legacy AMK tokens):** one-time **backfill only**.
  **Do not** re-run seed/bootstrap for this (seed resets bootstrap password hash
  + token ciphertext).
  - **Primary path:** GitHub Actions → **db-tenancy-backfill-deks** → Run workflow  
    - `confirm` = `backfill` (required)  
    - optional `dry_run=true` (secrets only, no mutate)  
    - optional `run_migrate=true` if DEK columns are missing (migrate only — still
      **no seed**)  
    - Workflow: [`.github/workflows/db-tenancy-backfill-deks.yml`](../.github/workflows/db-tenancy-backfill-deks.yml)  
    - Secrets: `DATABASE_URL` + `CREDENTIALS_ENCRYPTION_KEY` (**same as** Vercel
      Production — dual-store identity)  
  - Only after dual-read app is live on the target deploy.
  - Alternate (cloud agent only): same env names + `ALLOW_TENANT_DEK_BACKFILL=1`
    and the repo backfill entrypoint — **not** a personal laptop.
- After backfill verify (login + agent tools): set Vercel
  `TENANT_TOKEN_DECRYPT_MODE=dek-only` and redeploy.
- **Owner DEK rotate:** `/admin` → “Rotate encryption key” (server helper
  `rotateTenantDek`) re-encrypts that tenant only. Never change Production AMK
  without a re-wrap tool (not shipped — dual-store GHA≡Vercel must stay locked).


Names only — never commit passwords, tokens, DB hosts, or KEK material. Never
paste secret values into issues or PR chat.

1. **Postgres** — create a **pooled** Production `DATABASE_URL` in a hosted
   console (Neon / DO / etc.). Do **not** put host inventory in git.
2. **Vercel Production** — set `DATABASE_URL` +
   `CREDENTIALS_ENCRYPTION_KEY` only (defer `AUTH_SECRET` so tenancy is not yet
   enabled against an unprepared DB).
3. **GitHub Actions secrets** (same DB + KEK as Vercel) — set via GitHub **web
   UI** or `gh secret set` from a **cloud agent**:

   | Secret | Required |
   |--------|----------|
   | `DATABASE_URL` | yes (=== Vercel Production) |
   | `CREDENTIALS_ENCRYPTION_KEY` | yes (=== Vercel Production) |
   | `SEED_ADMIN_EMAIL` | yes |
   | `SEED_ADMIN_PASSWORD` | yes (re-seed **resets** password hash) |
   | `SANDBOX_URL` + `SANDBOX_TOKEN` | yes* (*or* `SEED_SANDBOX_URL` + `SEED_SANDBOX_TOKEN`) |

4. **Migrate + seed (GHA)** — Actions → **db-tenancy-bootstrap** → Run workflow  
   - `confirm` = `seed` (required misclick guard)  
   - optional `dry_run` = true validates secret **presence** only (no mutate)  
   - Workflow: [`.github/workflows/db-tenancy-bootstrap.yml`](../.github/workflows/db-tenancy-bootstrap.yml)  
   - Re-run **resets** bootstrap `password_hash` + sandbox token ciphertext (by design).

5. **Enable tenancy** — set Vercel Production `AUTH_SECRET` → **Redeploy**.
   Runtime now sees all three → login required.

6. **Smoke (public, no host inventory)**

   ```bash
   # unauth API must be 401 + exact error field
   curl -sS -o /tmp/agent-body.json -w '%{http_code}' \
     -X POST https://<your-production-host>/api/agent \
     -H 'content-type: application/json' \
     -d '{"prompt":"ping"}'
   # expect: 401 and {"error":"Authentication required."}
   ```

   Then: `/login` with seed admin → `/harness`; `/admin` shows base URL +
   **masked** token (owner can rotate).

7. **Origin only** — after smoke, mark `DATABASE_URL` / `AUTH_SECRET` /
   `CREDENTIALS_ENCRYPTION_KEY` **Done** in [AGENTS.md](../AGENTS.md).
   Never invent hosts.

Also: [sandbox.md](sandbox.md) · [SECURITY.md](../SECURITY.md) ·
[scripts/README.md](../scripts/README.md) · [`.env.example`](../.env.example) ·
[AGENTS.md operator model](../AGENTS.md).

### Cloud agent alternate (same scripts)

When GHA secrets are awkward (e.g. one-shot throwaway DB), a **cloud agent
workspace** (Grok Build / similar) may check out the repo and inject secrets
into **process env for the session only** (from Vercel/GHA — never commit,
never leave in issue comments):

```bash
npm ci
npm install --no-save --no-audit --no-fund drizzle-kit@0.31.10
npx drizzle-kit migrate
npm run db:seed
```

This is **not** “run on a personal laptop.” Prefer GHA for Production bootstrap.

### Preview / Production tips

| Environment | Recommendation |
|-------------|----------------|
| **Preview** | Use a separate `DATABASE_URL`. Do **not** casually reuse the Production encryption key on public previews. |
| **Lockout** | Keep the Production-grade triple in place and verify migrate+seed and `/login` work before enabling credentials login broadly. |
| **DB firewall** | Prefer Neon/public pooled SSL so GitHub-hosted runners can reach Postgres; allowlist GHA egress if using DO firewall. |

### Local harness note

[§3 Quick path](#3-quick-path-local-app--keys) is for **local Wasm/host smoke**
(Gateway key + harness files). It is **not** the tenancy cutover path — use the
cloud checklist above for migrate/seed/login flip.

### 4b. Optional SSO (OIDC) + SCIM

**Optional** on top of tenancy: generic OpenID Connect sign-in and/or
SCIM 2.0 user provisioning. Neither is required for credentials login or
sandbox grants.

#### Hybrid identity (anti-Figma)

**SCIM is additive.** Enabling SCIM does **not** hide, delete, or disable
non-SCIM users (credentials break-glass, OIDC JIT, manual). Product `/admin`
**Users** roster shows **all** provision sources (`credentials` · `oidc` ·
`scim` · `manual`). SCIM list endpoints return **SCIM-managed only** (IdP
compatibility). SCIM deprovision **suspends** SCIM-managed rows only; the
break-glass credentials owner is protected from SCIM suspend. Credentials
login remains available whenever tenancy is on.

#### OIDC (generic Auth.js provider)

Enable only when the three OIDC secrets are non-empty (tenancy is always on):

| Variable | Required | Purpose |
|----------|----------|---------|
| `AUTH_OIDC_ISSUER` | yes | Issuer URL (OIDC discovery) |
| `AUTH_OIDC_CLIENT_ID` | yes | Client id |
| `AUTH_OIDC_CLIENT_SECRET` | yes | Client secret — **server-only** |
| `AUTH_OIDC_LABEL` | no | Button label (default `Sign in with SSO`) |

| Item | Value |
|------|--------|
| Auth.js provider id | `oidc` |
| Callback URL (register at IdP) | `{your-origin}/api/auth/callback/oidc` |
| Login UI | `/login` — credentials form always; OIDC button only when configured |

**SCIM users and login:** directory-provisioned users typically have no
password. Interactive sign-in for those users is **OIDC** (same IdP) after
email/`idp_subject` link. Pure SCIM without OIDC = provisioned in DB only until
OIDC is configured. Do not expect password login for SCIM rows by default.

**Account linking:** when OIDC finds an existing user by email with no
`idp_subject` yet (typical SCIM → first SSO), the IdP must send a **verified**
email claim (`email_verified` true / `"true"`). Unverified email → link refused
(no account takeover). Subject match (`issuer|sub`) does not require re-verify.
Configure the IdP to emit verified emails for SSO users.

#### SCIM 2.0 Users API

Enable when `SCIM_BEARER_TOKEN` is non-empty (tenancy is always on):

| Variable | Required | Purpose |
|----------|----------|---------|
| `SCIM_BEARER_TOKEN` | yes | Bearer secret for IdP → app — **server-only**; timing-safe compare |

| Surface | Behaviour |
|---------|-----------|
| Base path | `/api/scim/v2` (`Users`, `ServiceProviderConfig`, `Schemas`) |
| Feature off (token empty) | **404** (fail closed) |
| Wrong / missing `Authorization: Bearer …` | **401** + `WWW-Authenticate: Bearer` |
| Responses | `Content-Type: application/scim+json` |
| DELETE | **Suspend** (`status=suspended`) — not hard delete |
| Pagination | `count` default **50**, max **100** |
| Session middleware | SCIM routes are **outside** the session matcher — bearer only |

Set the token in Vercel (or your host) env only. Never commit real token values.
Never put the token in client bundles or Wasm.

#### Preview isolation (OIDC / SCIM)

| Environment | Recommendation |
|-------------|----------------|
| **Public Preview** | Prefer **omit** OIDC secrets and/or use a **separate** `SCIM_BEARER_TOKEN` (and separate DB). Do **not** casually reuse Production SCIM token or OIDC client secret on public previews. |
| **Production** | Set OIDC/SCIM only when you intend SSO / directory provisioning. |

#### Operator checklist (OIDC / SCIM)

1. Tenancy configured + seed admin can `/login` with **credentials**.  
2. **(Optional OIDC)** Set issuer + client id + secret (+ label); register
   callback `{origin}/api/auth/callback/oidc` at the IdP; redeploy; confirm
   button on `/login` → session → `/harness`.  
3. Confirm **credentials still work** with OIDC enabled (break-glass).  
4. **(Optional SCIM)** Set `SCIM_BEARER_TOKEN`; redeploy.  
   - `GET /api/scim/v2/ServiceProviderConfig` **with** Bearer → **200**  
   - Same request without Bearer when configured → **401**  
   - Token unset → **404**  
5. SCIM create user → appears on `/admin` with `scim` badge; existing
   credentials user still listed (hybrid).  
6. Preview: separate token/DB or leave OIDC/SCIM unset.

Env comment block: [`.env.example`](../.env.example). Security notes:
[SECURITY.md](../SECURITY.md).


---

## 5. Wasm supply paths

| Path | When | What to do |
|------|------|------------|
| **A — Own runner** | You edit `native/harness` and want CI builds | Register a self-hosted runner on **your** repo → set Actions **variable** `SELF_HOSTED_BUILDS=true` → optional `RUNNER_LABELS` JSON array (default `["self-hosted","invincible","zig"]`) → follow [runner.md](runner.md) · [SECURITY.md](../SECURITY.md) |
| **B — Other repo’s artifacts** | **Typical first deploy** (fork has no artifact yet) or you always consume upstream/build-repo Wasm | Set `HARNESS_OWNER` / `HARNESS_REPO` + token with Actions:Read on **that** repo (e.g. origin `btipling` / `invincible` while you have no runner) |
| **C — Local / skip (non-prod)** | Dev without CI | Zig 0.16.0 local build, or `HARNESS_SKIP_FETCH=1` with existing files — **not** recommended as sole prod strategy |

**Origin (`btipling/invincible`) note:** workflows also allow a **grandfather**
path (`github.repository == 'btipling/invincible'`) so maintainer CI stays
eligible if the Actions variable is unset. **Clones and forks must set**
`SELF_HOSTED_BUILDS=true` after attaching **their** runner; without it, jobs
**skip** (safe default).

**Never** add `pull_request` / `pull_request_target` triggers to self-hosted
workflows. Jobs run only on `workflow_dispatch` or `push` to `main`.

---

## 6. Security

| Rule | Detail |
|------|--------|
| Secrets server-side | `AI_GATEWAY_API_KEY`, `SANDBOX_TOKEN`, `AUTH_OIDC_CLIENT_SECRET`, `SCIM_BEARER_TOKEN` only on Vercel (or local `.env.local`); never in Wasm or client bundles |
| Variables ≠ secrets | `SELF_HOSTED_BUILDS` / `RUNNER_LABELS` are Actions **variables** (non-secret) |
| Public-repo runners | No PR execution on self-hosted; see [SECURITY.md](../SECURITY.md) |
| Agent sandbox ≠ Zig runner | Separate process/user; see [sandbox.md](sandbox.md) · [runner.md](runner.md) |
| No host inventory in git | IPs, droplet IDs, cloud account GUIDs stay offline |

---

## 7. Verify (any host)

Use **your** deploy URL (local or Vercel). Do not require the maintainer prod host.

1. Open `/harness` — after load, the **canvas** is the workspace (not a React chat card).  
2. Type in the canvas composer → **Enter** or **Send**.  
3. **Send** a short prompt to smoke the host Gateway path (reply appears in canvas).  
4. Refresh restores session into Wasm; nav **Clear** resets.  
5. DOM chrome = nav + status chips only (host shell).  
6. ~390px width remains usable.  
7. **Optional agent tools:** with a usable sandbox grant, try a write/exec prompt; without a grant and no alternate tools (MCP / builtin HTTP) the turn returns **403** — no chat fallback ([sandbox.md](sandbox.md)).

Feature divide: [feature-divide.md](feature-divide.md). Visitor try path / samples: [README](../README.md).

If the canvas stays blank: check Vercel build logs for harness fetch failures
(token, artifact missing, wrong owner/repo). Prefer fail-loud over shipping an
empty `public/harness`.

---

## 8. Future (not shipped)

| Capability | Status |
|------------|--------|
| Pluggable **sandbox** for agent build/run tools | **Shipped (MVP)** — config seam; see [sandbox.md](sandbox.md) |
| Multi-tenant auth (login + DB grants) | **Required & always on** — [§4a](#4a-multi-tenant-auth) |
| Tenant BYOK inference keys + harness model cycle | **Shipped** — [§4a Inference keys](#inference-keys-byok) |
| Multi-tenant sandbox isolation / fleet | **Not shipped** — single workspace root per process for now |
| Optional **OIDC SSO** + **SCIM** provisioning | **Shipped (optional config)** — [§4b](#4b-optional-sso-oidc--scim) |
| Per-user **MCP** tools (remote HTTPS) | **Shipped** — [mcp.md](mcp.md); Settings `/settings/mcp` |

This guide covers **BYO Vercel + keys + runner/Wasm supply + optional sandbox**.
Target projects can be any language or platform; Invincible is the harness
workspace, not a locked stack for the work you operate on.

---

## 9. Reference deployment (maintainer sample)

| | |
|--|--|
| **GitHub** | `btipling/invincible` |
| **Production** | https://invincible-dun-ten.vercel.app |
| **Harness** | https://invincible-dun-ten.vercel.app/harness |
| **IDs** | [project-ids.md](project-ids.md) |

Agents working **on that origin** should not re-prompt for secrets already
listed as Done in [AGENTS.md](../AGENTS.md). Operators on **forks/clones** use
**this** document instead.

---

## Checklist

- [ ] Cloned **your** repo; Node 18+; `npm install`
- [ ] `.env.local` / Vercel: `AI_GATEWAY_API_KEY` set (server only)
- [ ] Harness path chosen (A / B / C); cold-start forks set `HARNESS_OWNER`/`HARNESS_REPO` (B) or publish path A first; Vercel has `HARNESS_ARTIFACT_TOKEN` with Actions:Read on the **artifact** repo
- [ ] Deployed **your** Vercel project; opened **your** `/harness`
- [ ] Send + multi-turn + refresh + Clear work in canvas
- [ ] If using self-hosted builds: runner online + `SELF_HOSTED_BUILDS=true`
- [ ] Optional: sandbox daemon + Vercel/local `SANDBOX_URL`/`SANDBOX_TOKEN` ([sandbox.md](sandbox.md))
- [ ] Tenancy: cloud cutover [§4a](#4a-multi-tenant-auth) (GHA migrate/seed, then `AUTH_SECRET`)
- [ ] Optional BYOK: GHA **db-migrate** if needed + `/admin/inference` + harness model cycle ([§4a](#inference-keys-byok))
- [ ] Optional MCP: GHA **db-migrate** if needed + `/settings/mcp` + Exa smoke ([mcp.md](mcp.md))
- [ ] Optional OIDC / SCIM: [§4b](#4b-optional-sso-oidc--scim) (credentials break-glass still works; hybrid roster)
- [ ] No keys in client/Wasm; no PR triggers on self-hosted workflows
