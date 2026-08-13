# Security

## Reporting

If you find a vulnerability in Invincible, please open a **private** security advisory on GitHub (or email the maintainer) rather than a public issue with exploit details.

## Secrets

| Never commit | Where it lives |
|--------------|----------------|
| `AI_GATEWAY_API_KEY` | Vercel project env only |
| `HARNESS_ARTIFACT_TOKEN` | Vercel (Actions: Read PAT for artifact download) |
| `VERCEL_DEPLOY_HOOK_URL` | GitHub Actions secrets |
| `SANDBOX_TOKEN` | **BYO daemon / local bootstrap only** — not a Vercel product-routing secret (product tool turns resolve credentials from DB grants); sandbox process env; never client/Wasm |
| `DATABASE_URL` | Vercel / local only (prefer **pooled** Neon/PgBouncer URL) |
| `REDIS_URL` | Vercel project env only (optional BYO multi-session Redis; node-redis RESP — the URL **embeds** the credential `redis://default:<secret>@<host>:<port>`). **Never** log it; never `NEXT_PUBLIC_*`. Old `SESSION_REDIS_*` / `UPSTASH_REDIS_REST_*` names are **removed** — if present, the store logs a one-time (value-free) deprecation hint then 503s until `REDIS_URL` is set |
| `CREDENTIALS_ENCRYPTION_KEY` | Vercel / local only — base64 32-byte AES-256-GCM **AMK** (wraps per-tenant DEKs; tokens encrypt under DEK) |
| `AUTH_SECRET` | Auth.js session secret — set on Vercel **after** migrate + the first-run sign-up bootstrap |
| `AUTH_OIDC_CLIENT_SECRET` | Optional OIDC client secret — Vercel/server only; never `NEXT_PUBLIC_*` |
| `SCIM_BEARER_TOKEN` | Optional SCIM shared bearer — Vercel/server only; IdP → `/api/scim/v2`; never client/Wasm |
| Runner registration tokens, DO API tokens | Operator machines only |
| `VERCEL_TOKEN` (GHA secret for **dev-image-build** VCR push) | GitHub Actions only — docker login password to `vcr.vercel.com`; never commit; never echo in logs/summaries |
| `VERCEL_TEAM_ID` / `VCR_IMAGE_PREFIX` (GHA vars for dogfood image) | Identifiers for VCR push; not app runtime env; never put production DB/Gateway secrets in the dogfood image |

Session blobs and Wasm must never contain API keys or sandbox tokens.  
Never use `NEXT_PUBLIC_SANDBOX_*` (or any client-exposed sandbox secret).

### Harness session store (local + cloud)

| Surface | Trust rule |
|---------|------------|
| Browser `localStorage` / memory | UX convenience only; same-origin; **not** multi-tenant isolation |
| Cloud store (Redis multi-session) | id-shaped **`/api/sessions*`**; one **record** per `{tenant,user,sessionId}` in the `harness:session:{tenant}:{user}:{id}` keyspace; ownership always server-derived from the authenticated user — never client-supplied tenant/user |
| API | `GET`/`POST` `/api/sessions` + `GET`/`PUT`/`DELETE` `/api/sessions/:id` — signed in + middleware-protected; **write key = the path `:id`**, body `id` must equal the path id |
| Unauthenticated | **401** — client disables cloud sync for the page load |
| No such session / other user | **404** `NOT_FOUND` (no existence leak — never 403) |
| Store unavailable | **503** `SESSION_STORE_UNAVAILABLE` — local continues; response never includes host/port/`REDIS_URL` |
| Cross-user isolation | Tenant via `loadSoleMembership` (server); other-user id → **404**; ids/fn restricted to Redis-safe `^[A-Za-z0-9_-]{1,128}# Security

## Reporting

If you find a vulnerability in Invincible, please open a **private** security advisory on GitHub (or email the maintainer) rather than a public issue with exploit details.

## Secrets

| Never commit | Where it lives |
|--------------|----------------|
| `AI_GATEWAY_API_KEY` | Vercel project env only |
| `HARNESS_ARTIFACT_TOKEN` | Vercel (Actions: Read PAT for artifact download) |
| `VERCEL_DEPLOY_HOOK_URL` | GitHub Actions secrets |
| `SANDBOX_TOKEN` | **BYO daemon / local bootstrap only** — not a Vercel product-routing secret (product tool turns resolve credentials from DB grants); sandbox process env; never client/Wasm |
| `DATABASE_URL` | Vercel / local only (prefer **pooled** Neon/PgBouncer URL) |
| `REDIS_URL` | Vercel project env only (optional BYO multi-session Redis; node-redis RESP — the URL **embeds** the credential `redis://default:<secret>@<host>:<port>`). **Never** log it; never `NEXT_PUBLIC_*`. Old `SESSION_REDIS_*` / `UPSTASH_REDIS_REST_*` names are **removed** — if present, the store logs a one-time (value-free) deprecation hint then 503s until `REDIS_URL` is set |
| `CREDENTIALS_ENCRYPTION_KEY` | Vercel / local only — base64 32-byte AES-256-GCM **AMK** (wraps per-tenant DEKs; tokens encrypt under DEK) |
| `AUTH_SECRET` | Auth.js session secret — set on Vercel **after** migrate + the first-run sign-up bootstrap |
| `AUTH_OIDC_CLIENT_SECRET` | Optional OIDC client secret — Vercel/server only; never `NEXT_PUBLIC_*` |
| `SCIM_BEARER_TOKEN` | Optional SCIM shared bearer — Vercel/server only; IdP → `/api/scim/v2`; never client/Wasm |
| Runner registration tokens, DO API tokens | Operator machines only |
| `VERCEL_TOKEN` (GHA secret for **dev-image-build** VCR push) | GitHub Actions only — docker login password to `vcr.vercel.com`; never commit; never echo in logs/summaries |
| `VERCEL_TEAM_ID` / `VCR_IMAGE_PREFIX` (GHA vars for dogfood image) | Identifiers for VCR push; not app runtime env; never put production DB/Gateway secrets in the dogfood image |

Session blobs and Wasm must never contain API keys or sandbox tokens.  
Never use `NEXT_PUBLIC_SANDBOX_*` (or any client-exposed sandbox secret).

### Harness session store (local + cloud)

| Surface | Trust rule |
|---------|------------|
 so no glob/key bleed |
| Minting | Server mints **UUID** session ids; a brand-new session seeds `updatedAt: 0` |
| Conflict | LWW on `updatedAt` (epoch ms); stale PUT → **409** + server record |
| Caps (abuse / size) | No message-count cap; ≤**262 144** UTF-8 bytes per message text; ≤**~2 MiB** raw body; record id ≤128; `meta` is schema-typed reserved (title/legacySnapshotId/logicalCwd/activeSandboxId…) + serialized size cap |
| Blob contents | Message roles/text/ids/timestamps + reserved `meta` scalars only — **never** Gateway keys, sandbox tokens, MCP secrets, PATs, or host absolute paths |
| `cwd` | **Session-owned** workspace-relative field (P1/GAP-1, #452) — stored on the cloud record as `meta.logicalCwd`; the host-absolute path is never stored (shared predicate re-sanitizes on parse) |
| `REDIS_URL` | Single RESP wire URL (`redis://`/`rediss://`) embeds the credential — **never** log/echo it or `NEXT_PUBLIC_*`; dual-store `REDIS_URL` == Vercel Production env == GHA secret |
| Backfill | One-shot Postgres `harness_sessions` → Redis via GHA **`sessions-redis-backfill`** (per-`{tenant,user}` marker, idempotent); Postgres becomes a **read-only archive**; legacy `/api/session` write route removed |
| Client bundle | Session repository is client-safe (`lib/sessionRepository.ts`); must **not** import server `db` / Drizzle modules |

Product behavior: [docs/session-model.md](docs/session-model.md).

## Builtin HTTPS fetch (Vercel Sandbox)

When `BUILTIN_HTTP_FETCH=sandbox`, agent tools may fetch **public HTTPS** URLs via a
**durable HTTP/curl** Vercel Sandbox instance (hop B) — attach-only to a name the
user created under **Settings → Sandbox**. App-side SSRF
policy runs first (https-only; no private/metadata hosts; redirects only after
re-check of each Location). Never put Gateway, BYO sandbox, or MCP secrets into
the Sandbox child env. No `NEXT_PUBLIC_*` for this feature. Instance names and
control-plane credentials never enter client/Wasm. See [docs/builtin-http.md](docs/builtin-http.md).

**Residual (v1):** Policy is preflight-only on the app (literal + DNS at check
time). Hop B re-resolves the hostname under Sandbox `networkPolicy: allow-all`.
A short-TTL / DNS-rebinding name could flip to a private or link-local address
between preflight and curl. Redirects are followed **hop-by-hop** with the same
policy on each `Location` (curl still `--max-redirs 0` so the microVM never
blind-follows). Accept residual DNS rebinding for v1; harden later (IP pin /
egress deny) if product needs stronger guarantees.


## Self-hosted runner (public repo policy)

Zig builds run on a **self-hosted** GitHub Actions runner (default labels: `self-hosted`, `invincible`, `zig`).

To reduce abuse risk when this repository is **public**:

1. **Default triggers** on self-hosted workflows: `push` to `main` (path-filtered) and `workflow_dispatch`.
2. **`build-harness` only** also runs on **`pull_request` → `main`** when **all** of:
   - head branch is in **this** repository (`head.repo.full_name == github.repository`) — **not** forks;
   - `author_association` is one of `OWNER` / `MEMBER` / `COLLABORATOR` / `CONTRIBUTOR`;
   - path filter matches harness sources / this workflow.
   - **Never** `pull_request_target`. **Never** Vercel deploy hook on PR. Other self-hosted workflows stay main/`workflow_dispatch` only.
3. Jobs include `if:` guards:
   - **Opt-in:** `vars.SELF_HOSTED_BUILDS == 'true'` (repository **Actions variable**, not a secret), **or**
   - **Origin grandfather:** `github.repository == 'btipling/invincible'` (maintainer continuity if the variable is unset)
   - and event is `workflow_dispatch`, `push` to `main`, or the same-repo contributor `pull_request` rules above (`build-harness`).
4. **Clones / forks** must set `SELF_HOSTED_BUILDS=true` after attaching their own runner. Without that variable, self-hosted jobs **skip** (safe default).
5. Optional: `vars.RUNNER_LABELS` as a JSON array (e.g. `["self-hosted","invincible","zig"]`). If unset, workflows use that default list via `fromJSON`.
6. **Do not** add fork PR or `pull_request_target` builds on self-hosted without a deliberate design review. Expanding PR CI beyond same-repo contributor heads is a security change.
7. Prefer GitHub setting: require approval for first-time contributors’ workflows; keep **fork** PR workflows off the self-hosted pool.
8. Host inventory (IPs, droplet IDs) is **not** published in this repo — keep private notes offline.

| Setting | Kind | Purpose |
|---------|------|---------|
| `SELF_HOSTED_BUILDS` | Actions **variable** (`true`) | Enable self-hosted jobs on **this** repository |
| `RUNNER_LABELS` | Actions **variable** (JSON array) | Optional `runs-on` labels override |
| `VERCEL_DEPLOY_HOOK_URL` | Actions **secret** | Post-artifact redeploy (origin; **main / dispatch only**) |

Maintainers: still harden the VM (SSH keys, firewall, unattended upgrades) using private runbooks; public docs stay abstract.

## Agent sandbox (not the Zig runner)

The **agent sandbox** is an optional remote workspace for model tools
(`list_dir` / `read_file` / `write_file` / `exec`). It is **not** the
self-hosted GHA runner that compiles Zig.

Each sandbox row may use **`backend=byo`** (URL + DEK-encrypted
token) or **`backend=vercel`** (host Vercel project OIDC; optional image ref).
Users **Create** durable Workspace/HTTP instances in **Settings**; the agent only
**attaches** (never `Sandbox.create` / `getOrCreate` on a turn). Destroy removes
the platform VM and the DB row. There is **no** product host env
`SANDBOX_BACKEND`. Registry credentials for custom images stay on the host
Vercel/CI side — never in the DB. Token rotate applies to **byo** only. Per-user
instance names are server-generated and never exposed as client secrets.

**Dogfood image push (GHA `dev-image-build`):** builds a toolchain OCI image
from `dev/Dockerfile` and pushes to Vercel Container Registry. Uses Actions
`VERCEL_TOKEN` + team/prefix identifiers only. **Never** bake
`AI_GATEWAY_API_KEY`, `DATABASE_URL`, sandbox tokens, or AMK/DEK material into
image layers. The dogfood image is **not** the self-hosted Zig build-harness
runner.

| Rule | Detail |
|------|--------|
| Separate process | Dedicated OS user/unit; do **not** share Actions credentials with the sandbox env |
| Server-only calls | Only Vercel/Node server calls `SANDBOX_URL` with Bearer `SANDBOX_TOKEN` |
| Path jail | Workspace root + symlink-safe resolve; argv-only `exec` with timeouts |
| Public inventory | Host IPs / droplet IDs stay offline ([docs/sandbox.md](docs/sandbox.md)) |
| No PR trigger surface | Sandbox is not executed by untrusted PR workflows |
| Daemon version gate | BYO daemons behind the expected `daemonVersion` return **426** out-of-date (exact string + `code`); never mapped to `Sandbox access denied.` **403**. Client probes `/health` once per instance; missing daemonVersion = 0 |
| `/health` discloses the jail root | Since daemon v2, `GET /health` returns the **low-sensitivity** `workspaceRoot` (per-binding jail root) **without** bearer auth, alongside `version`/`daemonVersion`. It is the **resolved** root (`resolveWorkspaceRoot`, realpath — not the raw env string), read **fail-closed** by the client (absolute, control-char-free, no bare `/`, no `//`/trailing slash, no `..`; everything else → `null`). Liveness is **not** coupled to `realpath` — if the jail root cannot be resolved, `/health` still returns 200 + `version`/`daemonVersion` with `workspaceRoot` omitted (a missing-jail-root boot race is an FS-ops concern, never a liveness/version blank). It is reachable only on the token-private daemon port and is already visible to any bearer-token holder via `exec pwd`, so this is not a new secret class. All FS mutation stays `/v1/*` token-gated; keep other host paths/IDs private and do **not** expose the daemon port publicly |
| Auto-update trust | Opt-in `SANDBOX_AUTO_UPDATE` runs `git fetch` + **ff-only** merge on `SANDBOX_GIT_DIR`, then exits for supervisor restart. Fails closed on divergent/dirty checkouts (stays up, keeps serving 426). Uses a **local** repo checkout / optional **read-only** deploy key — never Actions or GitHub write credentials in the sandbox unit env |

## Production app

Inference is server-side only (`POST /api/chat`, `POST /api/agent`). Report
client-side key or sandbox-token exposure immediately.

**Agent SSE:** when `Accept: text/event-stream`, event string fields (`text`,
`summary`, `error`, tool names, etc.) are redacted with the same secret list as
JSON responses before they hit the wire. Never put Gateway keys, sandbox tokens,
provider/MCP secrets, or raw DEK material in stream payloads. See
[docs/agent-stream.md](docs/agent-stream.md).

## Multi-tenant auth

| Rule | Detail |
|------|--------|
| Triple-env gate | Tenancy is always required: `DATABASE_URL` **and** `AUTH_SECRET` **and** `CREDENTIALS_ENCRYPTION_KEY` must be set — no separate `AUTH_ENABLED` |
| Tokens at rest | Envelope: env **AMK** (`CREDENTIALS_ENCRYPTION_KEY`) wraps each **per-tenant DEK**; sandbox bearer secrets AES-256-GCM under that tenant’s DEK only. Decrypt server-side for agent tools / admin mask only |
| Provider secrets (BYOK) | Ciphertext under **tenant DEK only** (no AMK dual-read path). Admin mask only; never plaintext in client/Wasm/logs. Schema migrate: GHA **`db-migrate`** |
| Per-user MCP API keys | Ciphertext under **tenant DEK** on `user_mcp_servers`. Settings mask only; never plaintext in client/Wasm/logs. HTTPS-only URL policy + no redirect follow (SSRF). Schema: GHA **`db-migrate`**. Ops: [docs/mcp.md](docs/mcp.md) |
| Per-user GitHub PAT | Ciphertext under **tenant DEK** on `user_github_tokens`. Settings mask only; decrypt server-side for sandbox **exec** inject as `GH_TOKEN` + `GITHUB_TOKEN` (omit when unset). Never client/Wasm/image/host env. Schema: GHA **`db-migrate`**. Ops: [docs/sandbox.md](docs/sandbox.md) |
| Inference (BYOK) | Chat/agent always attach request-scoped `providerOptions.gateway.byok` + `only` for a **granted** model. **Never** route via a host env-model. Unauthorized / empty grants → **4xx** |
| Residual (platform) | Invincible does **not** fall back to host env-model routing. Vercel AI Gateway remains a third party: (1) **BYOK requires paid AI Gateway credits** on the Vercel team — free tier does not allow request-scoped BYOK even with valid provider keys ([pricing](https://vercel.com/docs/ai-gateway/pricing)); (2) misconfigured BYOK / provider errors still surface from the platform. Mitigate with always-send BYOK, `only: [provider]`, top up credits, surface errors, redact secret material from error JSON |
| Redaction | Inference error paths redact provider secret material via resolve redact lists |
| Dual-read cutover | `TENANT_TOKEN_DECRYPT_MODE`: default **`dual`** (DEK then AMK) until backfill verified; then **`dek-only`**. Order: dual-read app live → GHA **db-tenancy-backfill-deks** (`confirm=backfill`, job sets `ALLOW_TENANT_DEK_BACKFILL=1`) → verify → dek-only. **Never** backfill under AMK-only runtime |
| DEK rotate | Owner-only (`rotateTenantDek` / `/admin`); re-encrypts that tenant’s sandbox tokens, provider secrets, MCP header ciphertexts, **and** user GitHub PAT ciphertext; never shows DEK/token/plaintext. Other tenants untouched |
| AMK rotate | **Not automated.** Changing Production AMK without a re-wrap tool breaks all DEK unwraps. Keep GHA `CREDENTIALS_ENCRYPTION_KEY` **===** Vercel Production AMK (dual-store). Re-wrap is a future sequel |
| Never client | No `NEXT_PUBLIC_*` for DB, Auth.js secret, AMK/DEK, sandbox token, provider API keys, MCP API keys, user GitHub PATs, OIDC client secret, or SCIM bearer |
| Preview isolation | Use a separate DB on public previews; avoid reusing Production AMK, OIDC client secret, or `SCIM_BEARER_TOKEN` casually |
| Bootstrap vs backfill vs schema | Bootstrap = the app's **first-run sign-up** on `/login` (no env, no seed script). Existing Production data / AMK→DEK cutover = GHA **`db-tenancy-backfill-deks`** only. Schema-only = GHA **`db-migrate`**. **Never** re-seed a bootstrapped DB — it would add a second tenant and break the sole-tenant join |
| Ops surface | Schema/backfill via GitHub Actions: **`db-migrate`** (schema), **`db-tenancy-backfill-deks`** (AMK→DEK data), **`sessions-redis-backfill`** — or a cloud agent workspace. Not personal-laptop primary ops |
| OIDC (optional) | `AUTH_OIDC_ISSUER` + `AUTH_OIDC_CLIENT_ID` + `AUTH_OIDC_CLIENT_SECRET` (+ optional `AUTH_OIDC_LABEL`); provider id `oidc`; callback `/api/auth/callback/oidc`; email auto-link requires verified `email_verified` claim |
| SCIM (optional) | `SCIM_BEARER_TOKEN` (feature-env only, no tenancy-gate); base `/api/scim/v2`; off → **404**; bad Bearer → **401**; DELETE = suspend |
| Hybrid roster | SCIM is **additive** — non-SCIM users remain; `/admin` lists all provision sources; SCIM list = SCIM-managed only |
| Break-glass | Credentials login always remains; SCIM must not suspend break-glass credentials owner |

Unauthenticated API returns **401** with JSON
`{ "error": "Authentication required." }` (stable `error` constant
`AUTH_REQUIRED_ERROR`). Sandbox grant failures return **403**
`{ "error": "Sandbox access denied." }` (`SANDBOX_FORBIDDEN_ERROR`). Multiple usable sandboxes without a Settings preference → 403 selection-required message.
Inference grant / model failures return **403** / **400**
(`INFERENCE_FORBIDDEN_ERROR` / `INFERENCE_MODEL_REQUIRED_ERROR`); temporary
resolve/catalog failures return **503** (`INFERENCE_UNAVAILABLE_ERROR`).

Cutover: [docs/bring-your-own.md](docs/bring-your-own.md) §4a.  
OIDC / SCIM operator notes: [docs/bring-your-own.md](docs/bring-your-own.md) §4b.

