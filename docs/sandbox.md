# Agent sandbox

What tools the agent gets when a sandbox is configured: a remote path-jailed
workspace with `list_dir` / `read_file` / `write_file` / `str_replace` / `exec` during a
harness turn.

Related: [bring-your-own.md](bring-your-own.md) · [feature-divide.md](feature-divide.md) ·
[mcp.md](mcp.md) · [builtin-http.md](builtin-http.md) · [SECURITY.md](../SECURITY.md) · [runner.md](runner.md) · package detail
[`sandbox/README.md`](../sandbox/README.md)

---

## 1. What it is / is not

| | |
|--|--|
| **Is** | A **workspace for agent tools** — either a BYO HTTP daemon (protocol v2) or a **durable Vercel Sandbox Workspace instance** (user-created in Settings; agent **attach-only**) |
| **Is** | **Per sandbox row under a tenant** when tenancy is on: each row chooses `backend` (`byo` \| `vercel`) and, for vercel, an optional **image** |
| **Is** | **BYO** path: any operator points URL + token at **their** daemon (env when tenancy off; admin/seed when tenancy on) |
| **Is not** | The Zig **GHA build runner** (`invincible-do-1` / `self-hosted` + `zig` labels) |
| **Is not** | A host-wide product env like `SANDBOX_BACKEND` — backend is **never** a deploy-global switch |
| **Is not** | A multi-sandbox picker **inside the harness canvas**. Prefer sandbox under **Settings → Sandbox** when you have multiple usable grants |
| **Is not** | Required for basic chat — without tools, harness falls back to `POST /api/chat` when the 503 contract applies (tenancy off) |
| **Is not** | Builtin HTTPS fetch (`http_get`) — that is a separate **Vercel Sandbox hop B** path; see [builtin-http.md](builtin-http.md) |

Never put GHA Actions credentials in a BYO sandbox process env. Prefer a dedicated
OS user and reverse-proxy TLS in production for BYO daemons.

---

## 1b. Per-row backend and image (tenancy)

When tenancy is on, operators create and edit sandboxes in **Admin → Sandboxes**
(`/admin/sandboxes`). Schema columns:

| Column | Meaning |
|--------|---------|
| `backend` | `byo` (default) or `vercel` |
| `image` | Vercel image ref when `backend=vercel`; **null** means product default `vercel/sandbox/universal:latest` at resolve time |
| `base_url` / `token_ciphertext` | Required for `byo`; **null** for `vercel` |

### Catalog vs user instances

| Layer | What it is | Who manages |
|-------|------------|-------------|
| **Catalog sandbox** | Admin `sandboxes` row (`backend` / `image` / BYO URL) + grants | Admin |
| **Preferred catalog** | Settings preference when multiple usable grants | User |
| **Workspace instance** | Durable named Vercel microVM (`user_sandbox_instances`, purpose `workspace`) | User — **Settings → Sandbox** Create/Start/Stop/Destroy |
| **HTTP / curl instance** | Separate durable microVM for `http_get` / `http_head` (purpose `http`) | User — same Settings page |

The agent and hop-B **only attach** (`Sandbox.get` + `extendTimeout`). They **never**
`Sandbox.create` / `getOrCreate` / stop-on-turn-end. Files on a **running** Workspace
instance survive across turns until idle auto-stop (~30m) or user Stop/Destroy.

### BYO vs Vercel vs hop-B

| Kind | How tools reach a workspace | Credentials |
|------|----------------------------|-------------|
| **byo** | HTTP client → protocol v2 daemon | URL + token (DEK-encrypted at rest) |
| **vercel** (FS tools) | Attach-only `@vercel/sandbox` client to the user's **Workspace instance** | **Host** Vercel project OIDC/quota. No per-tenant Vercel tokens in DB |
| **hop-B** `http_get` | Attach-only runner to the user's **HTTP instance** when `BUILTIN_HTTP_FETCH=sandbox` | Same host OIDC; not a catalog-row backend |

When hop-B and Workspace FS both run on one turn, **two durable** named VMs may be
attached (sharing one VM is not a product goal). Missing Workspace → soft-continue
without FS when HTTP/MCP can still run. Missing HTTP instance → **omit** http tools
(no create).

### How to get a useful toolchain on Vercel rows

1. **Managed image (VMI)** — pick a preset in admin (Node, Python, Ubuntu, Arch, or default universal). Snapshot freezes onto the Workspace instance at **Create**.
2. **Origin dogfood image** — first-party `invincible-dev` on Vercel Container Registry (see below).
3. **Custom VCR ref** — build/push an image your **host** Vercel team can pull, paste the ref in admin. The **Next.js / agent runtime does not build images**.
4. **Runtime `exec` install** — still available inside the VM; image is the durable deps path.

After **Settings → Create Workspace**, the agent attaches to that VM. Do **not** expect
the agent to provision a microVM for you.

### Origin dogfood image (`dev/` + GHA)

To run Invincible **on Invincible** with a prebuilt toolchain image (Node/Zig/gh/rg) on durable Workspace instances:

| Piece | Role |
|-------|------|
| [`dev/Dockerfile`](../dev/Dockerfile) | Toolchain image (Ubuntu amd64, Node 22, Zig from `native/ZIG_VERSION`, `gh`, `rg`) — **no** app source; WORKDIR `/vercel/workspace` |
| GHA **`dev-image-build`** | Official build/push to **Vercel Container Registry** (`linux/amd64`) |
| Admin sandbox row | `backend=vercel`, `image=` full VCR ref to `…/invincible-dev:latest` (or sha tag) |

**Operator path (cloud-native):**

1. Set GitHub Actions secret **`VERCEL_TOKEN`**, variable **`VERCEL_TEAM_ID`** (docker username; secret allowed), variable **`VCR_IMAGE_PREFIX`** = `vcr.vercel.com/<team-slug>/<project-slug>` (no trailing slash). Names only — never commit values.
2. Actions → **dev-image-build** → Run workflow with **`confirm=push`** (optional **`dry_run`** validates config only).
3. Wait until the image is **Ready** in the Vercel project Container Registry UI.
4. **Admin → Sandboxes**: create/edit `backend=vercel`, set image to  
   `${VCR_IMAGE_PREFIX}/invincible-dev:latest`  
   (short `team/project/invincible-dev:latest` also passes shape validation; prefer full prefix in ops notes).
5. Smoke via harness tools: `node -v`, `zig version`, `gh --version`, `rg --version`.

This image is **not** the self-hosted Zig **build-harness** runner that produces production `harness.wasm`. See [runner.md](runner.md) and [dev/README.md](../dev/README.md).

Forks/BYO: copy `dev/` + the workflow; use **your** team/project prefix and token.

### Operator path (schema + create)

| Step | Surface |
|------|---------|
| Schema migrate | GitHub Actions **`db-migrate`** (`confirm=migrate`) — not laptop-primary |
| Create / edit / image | Browser **/admin/sandboxes** |
| Seed bootstrap (optional) | GHA **`db-tenancy-bootstrap`** / seed with `SEED_SANDBOX_BACKEND` + optional `SEED_SANDBOX_IMAGE` |
| Smoke | Harness agent tools with a usable grant (or preferred when several) |

### Preferred sandbox (Settings)

When a user has **more than one usable grant**, agent resolve requires a **preferred**
sandbox stored per user (`user_preferred_sandbox`). Set it under **Settings → Sandbox**.

| Case | Behavior |
|------|----------|
| Zero usable grants | 403 sandbox access denied |
| Exactly one usable grant | That row (preference optional) |
| Multiple usable, preference set and usable | Preferred row |
| Multiple usable, no / invalid preference | 403 — choose under Settings → Sandbox |
| Admin selects ungranted tenant sandbox | Selection **grants** the admin R/W on that row + saves preference |

Creating a sandbox still grants the actor R/W but **no longer revokes** their other grants.
Schema: GHA **db-migrate** for `user_preferred_sandbox`.


---


## 1c. User durable instances (Settings)

Tenancy on: each user may own **at most one Workspace** and **one HTTP/curl**
Vercel Sandbox instance (server-generated names `inv-workspace-…` /
`inv-http-…`).

| Action | Effect |
|--------|--------|
| **Create** | `Sandbox.create` once (lifecycle module only); row `status=running` |
| **Stop** | Platform stop; row `stopped` |
| **Start** | `Sandbox.get` + resume only — **never** create/getOrCreate if missing |
| **Destroy** | stop + delete platform VM + delete DB row |
| **Agent attach** | `get({ name, resume: true })` + best-effort `extendTimeout(30m)`; turn end **releases** the handle (no stop) |

**Preconditions**

- Workspace Create: sole tenant membership + preferred catalog row with `backend=vercel` + usable grant.
- HTTP Create: sole membership only (host OIDC entitlement).

**Errors**

- No/stopped Workspace and no alternate tools → 403 with Settings guidance.
- No/stopped Workspace but HTTP/MCP available → soft-continue without FS tools.
- Builtin HTTP on but no running HTTP instance → omit `http_get` / `http_head`.

**Orphan cleanup (optional):** user Destroy is primary. Operators may run GitHub
Actions workflow **`sandbox-orphan-cleanup`** (`confirm=cleanup`, `dry_run` default
true) to list/delete leftover **product** names (`inv-workspace-…` / `inv-http-…`)
that are **not** in `user_sandbox_instances`. Non-product non-persistent VMs are
**not** swept unless `include_non_product=true` (project-wide; avoid on shared
host projects). Hard delete failures fail the job (not counted as deleted).
Secrets: `DATABASE_URL`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`
(names only).


## 2. Architecture (product path)

```text
User types in Wasm composer
  → host polls pending submit (inflight guard)
  → runHarnessTurn
       → formatPromptWithHistory(session user/assistant only)
       → POST /api/agent { prompt }
            if HTTP 503 + exact not-configured string
              → POST /api/chat   (today’s single-shot path)
            else
              generateText + tools → sandbox (env SANDBOX_* / DB grants + backend)
                                   + enabled per-user MCP tools (server-side; soft-fail)
              (sandbox Bearer + MCP header secrets; server-only)
  → host pushes ≤6 system toolTrace lines (≤240 chars) + assistant/error into Wasm
  → user reads in canvas
```

- **Wasm** remains the product UI (transcript + composer). No dual React chat.
- **Gateway key**, **sandbox token**, and **MCP API keys** never enter the client or Wasm.
- Per-user MCP config lives under Settings (`/settings/mcp`) — not this sandbox daemon guide; see [mcp.md](mcp.md).
- Detection is **server-side only** — no `NEXT_PUBLIC_SANDBOX_*`.

### Exact 503 contract (host fallback)

When `SANDBOX_URL` or `SANDBOX_TOKEN` is unset on the Next/Vercel server:

```http
HTTP/1.1 503
Content-Type: application/json

{ "error": "Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN." }
```

The host falls back to chat **only** for status **503** and this **exact**
`error` string (`SANDBOX_NOT_CONFIGURED_ERROR` in `lib/sandbox/config.ts`).
Other 4xx/5xx/network errors are shown as error lines — **no** chat fallback.

### Tenancy on vs legacy env

| Mode | When | Sandbox credentials |
|------|------|---------------------|
| **Legacy (tenancy off)** | Any of `DATABASE_URL` / `AUTH_SECRET` / `CREDENTIALS_ENCRYPTION_KEY` missing | Process env `SANDBOX_URL` + `SANDBOX_TOKEN` (BYO only — no host vercel backend switch) |
| **Tenancy on** | All three set | **DB-resolved** sandbox for the signed-in user (`resolveAgentSandbox`): branch on row `backend`; **byo** decrypts `token_ciphertext`; **vercel** uses host Sandbox control plane + row `image`. Env `SANDBOX_*` still used for **seed** / local daemon |

When tenancy is on and the user has no usable grant / multiple usable grants without a Settings preference / ambiguous membership / invalid backend:

```http
HTTP/1.1 403
Content-Type: application/json

{ "error": "Sandbox access denied." }
```

Unauthenticated API calls when tenancy is on → **401**
`{ "error": "Authentication required." }` (not a sandbox config issue).

### Exact 503 only when tenancy is off

**Tenancy off only.** When tenancy is **off** and `SANDBOX_URL` or
`SANDBOX_TOKEN` is unset, `/api/agent` returns the 503 contract above and the
host falls back to chat.

When tenancy is **on**, missing env `SANDBOX_*` does **not** produce this 503:
tools use DB grants + backend; a valid **vercel** grant works without env
`SANDBOX_*`. Failures are **403** `Sandbox access denied.` (or **401** if
unauthenticated) — see above.

---

## 3. Protocol v2 (summary)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | none | `{ ok: true, version: 2 }` |
| `POST` | `/v1/list_dir` | Bearer | List directory entries |
| `POST` | `/v1/read_file` | Bearer | Read file (max 16 MiB) |
| `POST` | `/v1/write_file` | Bearer | Write file (max 16 MiB) |
| `POST` | `/v1/str_replace` | Bearer | Exact string replace (unique match or `replace_all`) |
| `POST` | `/v1/exec` | Bearer | Run argv command (no shell); optional `stdin`/`heredoc` (v2+) |

**Backend split:** BYO daemons implement stdin/heredoc on `/v1/exec`. The Vercel Sandbox SDK has no stdin channel — the Vercel client **fails soft** (400) and the agent should `write_file` then pass a path via args. App BYO clients probe `/health` and refuse stdin when `version < 2`.

If you hit the stale-daemon error (`…need v2+…`), your running daemon is pinned
to old code — upgrade/restart it per [§7 Upgrade a live daemon deployment](#7-byo-deploy-patterns).

**Exec timeout & argv contract:** `exec` runs **argv only (no shell)** — pass
`args` as an array; a shell-style single-string `cmd` (whitespace + no `args`)
is rejected with a clear error. The client's HTTP abort for `/v1/exec` follows
the request's `timeoutMs` (5-min default / 30-min max) **plus**
`EXEC_TIMEOUT_BUFFER_MS`, not a fixed 45 s — so a command that legitimately runs
longer than 45 s completes, and the daemon's own timeout kill surfaces as
`TIMED_OUT` rather than a client 504. Non-exec calls keep the fast 45 s abort;
agent turn-cancel (Stop) still aborts immediately.

Full contract, jail rules, and exec shape: [`sandbox/README.md`](../sandbox/README.md).

---

## 4. Environment (names only)

### Next.js / Vercel (server)

| Name | Required | Purpose |
|------|----------|---------|
| `SANDBOX_URL` | for tools (tenancy **off**) | Base URL of the sandbox (no trailing slash required) |
| `SANDBOX_TOKEN` | for tools (tenancy **off**) / seed | Shared bearer secret (must match daemon); also used by seed to encrypt into DB when enabling tenancy |
| `AGENT_MAX_STEPS` | no | Optional safety ceiling (1…256). **Unset** = model-ended tool loop (no default step cap) |
| `AGENT_MODEL` | no | Optional tool-capable model override |

Also requires existing `AI_GATEWAY_API_KEY` for inference.

**Never** use `NEXT_PUBLIC_SANDBOX_URL` / `NEXT_PUBLIC_SANDBOX_TOKEN`.

### Sandbox process

| Name | Required | Default | Purpose |
|------|----------|---------|---------|
| `SANDBOX_TOKEN` | **yes** | — | Same secret as Vercel |
| `SANDBOX_WORKSPACE` | **yes** | — | Absolute jail root (must exist) |
| `SANDBOX_LISTEN` | no | `127.0.0.1:8787` | Bind address (localhost OK behind proxy) |

---

## 5. Local quick start

Terminal A — daemon:

```bash
cd invincible
npm install
export SANDBOX_TOKEN='dev-secret-change-me'
export SANDBOX_WORKSPACE="$(pwd)/.sandbox-workspace"
mkdir -p "$SANDBOX_WORKSPACE"
npm run sandbox:start
```

Smoke:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true,"version":2}
```

Terminal B — Next (`.env.local`):

```bash
# existing
AI_GATEWAY_API_KEY=…

# agent sandbox (local)
SANDBOX_URL=http://127.0.0.1:8787
SANDBOX_TOKEN=dev-secret-change-me
# optional:
# AGENT_MAX_STEPS=32   # safety ceiling only; omit for model-ended loop
# AGENT_MODEL=provider/model-with-tools

npm run dev
# open http://localhost:3000/harness
```

Harness smoke with tools (example prompt):

> Create `hello.txt` with hello world, then print its contents.

Expect muted **system** tool lines in the canvas, then an assistant reply.

Without `SANDBOX_*` on Next: **PONG** / normal chat still works via 503 → chat.

---

## 6. Vercel / production URL

Production `SANDBOX_URL` **must be reachable from Vercel** (public HTTPS or
private networking). **Do not** set `http://127.0.0.1:…` on Vercel — serverless
cannot call the droplet loopback.

Recommended pattern:

1. Sandbox binds `127.0.0.1:8787` on the VM.  
2. Reverse proxy terminates TLS and forwards to that port.  
3. Vercel env: `SANDBOX_URL=https://<your-sandbox-host>` + matching token.  
4. Verify **off-box** (not only from the droplet):

```bash
curl -sS https://<your-sandbox-host>/health
```

---

## 7. BYO deploy patterns

| Pattern | Notes |
|---------|--------|
| **Any VM / container** | Run `node sandbox/server.mjs` with env above |
| **systemd unit** | Dedicated user; restart on failure; no GHA token in unit env |
| **Docker** | Mount workspace volume; publish only via proxy |
| **Same physical host as Zig runner** | **Allowed** as operator choice — still a **separate process/user** from the Actions runner |

Origin may run a DigitalOcean-hosted **reference** sample. Host inventory
(IPs, droplet IDs) stays in **private operator notes** — never this repo.

### Upgrade / restart a live daemon deployment

A production BYO daemon commonly runs from a **separate deployment checkout**
(e.g. a systemd unit with `WorkingDirectory` pointing at an `app-src` clone owned
by a dedicated `sandbox` user) — **not** the repo you develop in. Code changes
only reach the live daemon once that checkout is updated **and** the service is
restarted. Style these as operator notes; never leak host inventory.

```bash
# On the BYO host, as the sandbox-owning operator (root or sudo).

# 1. Enter the deployment checkout (not your dev checkout)
cd /var/lib/invincible-sandbox/app-src

# 2. If you run git as root over a checkout owned by the sandbox user, git
#    refuses with "detected dubious ownership". Whitelist that one path:
git config --global --add safe.directory /var/lib/invincible-sandbox/app-src

# 3. Update the checkout to latest main
git fetch origin
git reset --hard origin/main

# 4. Reinstall runtime deps (harmless when they did not change)
npm install --omit=dev

# 5. Restart the daemon so it serves the new code
sudo systemctl restart invincible-sandbox
```

**Verify the upgrade landed** — the daemon must report protocol **v2** (this is
what makes `exec` stdin/heredoc available through the BYO client):

```bash
curl -s http://127.0.0.1:8787/health
# expect: {"ok":true,"version":2}
```

**Why v2 matters:** BYO `exec` accepts optional `stdin` / heredoc (multi-line
input without a shell) only on health `version >= 2`. The app BYO client probes
`GET /health` once and **refuses stdin** when a stale daemon reports `version`
below `MIN_SANDBOX_PROTOCOL_STDIN` (2) — it throws `Sandbox daemon protocol v<N>
does not support exec stdin/heredoc (need v2+). Restart/upgrade the BYO daemon.`
If you see that error, the running daemon is pinned to old code and hasn't
picked up the v2 change; repeat steps 3–5 above.

**Gotchas**

- The deployment checkout is a **separate git clone** from the repo you develop
  in — pulling in your dev checkout does not update the live daemon.
- After `git reset --hard`, the daemon only serves what is on disk in `app-src`;
  the running service still serves the old module graph until restart.
- If the unit runs the code as the `sandbox` user, prefer `sudo systemctl
  restart` over a manual process kill so the unit env (token, workspace) is
  preserved. Never put a GitHub Actions token in the unit env.

---

## 8. Budgets (locked with parent #45)

| Knob | Default | Cap / notes |
|------|---------|-------------|
| Route `maxDuration` | **1800s (30m)** — Vercel Fluid extended max; 1h not offered | `app/api/agent` (long multi-tool turns) |
| `AGENT_MAX_STEPS` | unset (model-ended) | optional 1…256 safety ceiling |
| exec `timeoutMs` | 300_000 (5 min) | max 1_800_000 (30 min) |
| read/write maxBytes | 16 MiB | |
| stdout/stderr/stdin per exec | 4 MiB each | truncated / rejected |
| tool result to model | 8_192 chars | |
| toolTrace lines to Wasm | unbounded | no host product cap |
| toolTrace summary chars | 240 | host + server |

---

## 9. Model tool-calling

The agent path uses the Vercel AI SDK with tools and multi-step generation.
By default `stopWhen` is **model-ended** (`isLoopFinished`): the loop continues
while the model calls tools and stops when it returns a final answer. Optional
`AGENT_MAX_STEPS` applies `stepCountIs(n)` as a safety ceiling only.

Users can **Stop** a running turn from the harness composer (abort via host
`AbortSignal`). Wall-clock limit remains route `maxDuration` (1800s / 30m; Vercel platform max).

If the default gateway model cannot call tools, set **`AGENT_MODEL`** to a
tool-capable id on the server (tenancy off). Under tenancy on, use granted
catalog + BYOK only.

---

## 10. Security checklist

- [ ] `SANDBOX_TOKEN` only on Vercel + sandbox process — never client, Wasm, git  
- [ ] Path jail under `SANDBOX_WORKSPACE`; symlink escape rejected  
- [ ] `exec` is argv-only (no shell); timeouts kill the process group  
- [ ] Child env does not inherit sandbox token / host secrets  
- [ ] Sandbox process **≠** GHA runner process; no Actions credentials in sandbox env  
- [ ] No `pull_request` execution path for the sandbox service  
- [ ] No host IPs / droplet IDs / cloud GUIDs committed  
- [ ] Prod URL health-checked from **outside** the host  
- [ ] User GitHub PAT (if configured) is DEK ciphertext only; injected **exec-only** as `GH_TOKEN`/`GITHUB_TOKEN`; never Wasm/client/image; redacted from tool/stream output  

### User GitHub personal access token (Settings)

When tenancy is on, each user may store a **GitHub personal access token** under
**Settings → GitHub token** (ciphertext under the tenant DEK). On agent turns the
server decrypts it and injects **only** into sandbox **FS `exec`** child env as
**`GH_TOKEN`** and **`GITHUB_TOKEN`** (same value), for **both** backends
(`vercel` and `byo`):

| Path | Behavior |
|------|----------|
| Vercel Sandbox | Merged into each `runCommand` via server client options |
| BYO daemon | JSON `env` on `/v1/exec`; daemon allowlists only those two keys |

Rules:

- **Omit** both keys when the user has no token (never empty strings).
- **Not** written into dogfood/VCR images, host Next env, or Wasm/client.
- **Not** model-visible: the agent `exec` tool schema has no `env` field.
- BYO daemons reject unknown `env` keys (400). Upgrade the daemon to get inject.
- Tool/stream output redacts the plaintext when present on the turn secret list.
- Prefer a fine-grained PAT with least scopes; rotate or clear from Settings.

See also [SECURITY.md](../SECURITY.md).

---

## 11. Verify

| # | Check | Expect |
|---|--------|--------|
| 1 | `GET /health` (local or off-box prod) | `{ ok: true, version: 2 }` |
| 2 | Harness with `SANDBOX_*` set | tool system lines + assistant for a write/exec prompt |
| 3 | Harness with `SANDBOX_*` **unset** | PONG / chat still works (agent 503 → chat) |
| 4 | Wrong/missing Bearer on `/v1/*` | `401` without echoing the token |
| 5 | Review git diff | no secrets, no private inventory |

Commands:

```bash
npm test
npm run typecheck
# optional focused:
npm run test:sandbox
```

---


## Logical workspace cwd

The sandbox **jail root** (`SANDBOX_WORKSPACE` on the daemon) does not change per turn.
Agents also have a **logical cwd** owned by the agent tool layer + host session — not
`process.chdir` on the daemon.

### Why it exists

When the git repo is nested under the workspace (e.g. workspace root contains
`invincible/…`), models often invent wrong prefixes (`sandbox/x` instead of
`invincible/sandbox/x`). Logical cwd lets the agent `change_dir` once and then use
short relative paths.

### Tools

| Tool | Role |
|------|------|
| `change_dir` | Set logical cwd for subsequent tools this turn (host may persist on success) |
| `pwd` | Print current logical cwd (workspace-root-relative) |
| path tools (`list_dir`, `read_file`, `write_file`, `str_replace`, `exec`) | Resolve paths against logical cwd |

### Prefix-aware resolve

Paths resolve with **prefix-aware** join (not naive always-join):

| Argument path | Behavior |
|---------------|----------|
| Equals current cwd, or starts with `cwd/` | Treated as already workspace-root-relative — **not** re-joined under cwd |
| Relative (`sandbox/x`, `./x`, `..`) | Joined under current logical cwd |
| Host-absolute (`/…`, drive letters) | Rejected |

Tool success lines always show **workspace-root-relative** paths (and `cwd=…` when
not at root) so models can copy paths without double-prefix mistakes.

### Defaults and session

| Source | When used |
|--------|-----------|
| Host session `cwd` | Sent on each agent POST when the browser session remembers a cwd |
| Request body `cwd` | Present (non-null) → validated; invalid → **400** |
| `SANDBOX_DEFAULT_CWD` | Body **omits** `cwd` (or null) → server default (workspace-relative only) |
| `"."` | Env unset or invalid |

Invalid `SANDBOX_DEFAULT_CWD` is ignored (falls back to `"."`) with a one-time
server warning — it does not fail process boot. Set it in the **Vercel project
env** UI for Production/Preview (e.g. `invincible` for a nested checkout). Verify
with the `pwd` tool after a harness turn.

Host updates stored session cwd **only on agent success**; failure, abort, and
chat-fallback leave the prior value. Clear session omits cwd.

See also [session-model.md](session-model.md) and [agent-stream.md](agent-stream.md).

## 12. Tenancy cutover (origin / BYO)

When Production enables the tenancy triple env, agent tools move to **DB grants**
instead of process env alone. **Primary path is cloud-native** — do not treat a
personal laptop as the migrate/seed host.

1. Follow [bring-your-own.md §4a](bring-your-own.md#4a-optional-multi-tenant-auth)
   (seed via GHA `db-tenancy-bootstrap` or cloud agent while `AUTH_SECRET` is still
   omitted so tenancy stays **off**).
2. Set the remaining triple-env var(s) on Vercel Production (typically
   `AUTH_SECRET` last) → redeploy → tenancy on. Do **not** set `AUTH_SECRET`
   before migrate/seed.
3. Smoke: unauth `POST /api/agent` → **401**
   `{ "error": "Authentication required." }`; `/login` → harness; optional `/admin`.
4. Origin only: mark `DATABASE_URL` / `AUTH_SECRET` / `CREDENTIALS_ENCRYPTION_KEY`
   **Done** in [AGENTS.md](../AGENTS.md) after smoke.

GHA workflow: [`.github/workflows/db-tenancy-bootstrap.yml`](../.github/workflows/db-tenancy-bootstrap.yml).

---

## 13. Operator origin sample (async)

Maintainer-only checklist when wiring the **reference** deploy. Does **not**
block BYO success and must not publish inventory.

- [x] Sandbox unit running (private notes: host, unit file, user)  
- [x] TLS proxy; `SANDBOX_URL` reachable from off-box (simulates Vercel)  
- [x] Vercel Production: `SANDBOX_URL` + `SANDBOX_TOKEN`  
- [ ] Optional `AGENT_MODEL` if needed  
- [x] Prod `/harness` agent tool smoke  
- [x] Confirm unset/fallback path still understood for Preview/local  

Origin `SANDBOX_*` is marked **Done** in [AGENTS.md](../AGENTS.md) (2026-08-03).
Host inventory stays offline; forks still set their own env.
