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
| **Is** | **Per sandbox row under a tenant**: each row chooses `backend` (`byo` \| `vercel`) and, for vercel, an optional **image** |
| **Is** | **BYO** path: any operator points URL + token at **their** daemon (seed / admin) |
| **Is not** | The Zig **GHA build runner** (`invincible-do-1` / `self-hosted` + `zig` labels) |
| **Is not** | A host-wide product env like `SANDBOX_BACKEND` — backend is **never** a deploy-global switch |
| **Is not** | A multi-sandbox picker **inside the harness canvas**. Prefer sandbox under **Settings → Sandbox** when you have multiple usable grants |
| **Is not** | Required for chat — chat-capable turns still need a signed-in session + a granted (BYOK) model; they run on `POST /api/agent` without FS tools. A tool-less empty surface (no usable grant + no MCP / builtin HTTP) → **403** `Sandbox access denied.`, not a 503→chat fallback |
| **Is not** | Builtin HTTPS fetch (`http_get`) — that is a separate **Vercel Sandbox hop B** path; see [builtin-http.md](builtin-http.md) |

Never put GHA Actions credentials in a BYO sandbox process env. Prefer a dedicated
OS user and reverse-proxy TLS in production for BYO daemons.

---

## 1b. Per-row backend and image

Operators create and edit sandboxes in **Admin → Sandboxes**
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

Each user may own **at most one Workspace** and **one HTTP/curl** Vercel Sandbox
instance (server-generated names `inv-workspace-…` / `inv-http-…`).

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

### Vercel attach resilience

The durable Workspace/HTTP attach path (`get({ name, resume: true })`) retries
**transient readiness** so a VM that is still booting or preparing its image does
not surface as a bogus user error on the first tool call:

- **Shared seam** (`lib/sandbox/resilience.ts`) used by the FS client and the
  hop-B HTTP runner. The BYO HTTP daemon backend is **not** changed.
- **Classifier**: retries bounded (exponential backoff, hard cap ~4 s) only on
  transient readiness — `image_not_ready` / `not ready` / `preparing`, HTTP
  `408/429/5xx`. Permanent config/auth/path errors and bad-image errors
  (`unoptimized`, invalid/unknown image, non-`linux/amd64`) fail **fast** with
  **zero** retries — a misconfigured sandbox never busy-loops.
- **SDK-owned resume is not re-retried**. `@vercel/sandbox` already re-resumes on
  `410` (any) and `422 sandbox_stopping/sandbox_snapshotting`; those are passed
  through so app-level retries do not amplify the platform's own recovery.
- **Readiness probe after attach**: the FS client runs a no-op command through
  the same VM path the tools use before `rootReady` becomes true, absorbing the
  boot window once at attach. hop-B has **no** separate probe — its first
  `curl`/`head` command already runs inside the same bounded retry.
- **Surfaced status**: when the retry budget is exhausted on a retryable, mapping
  yields **502** ("sandbox backend unavailable / preparing"); abort/timeout maps
  to **504**; permanent errors keep their own status (bad image stays a
  distinct 400, not merged with readiness). A blip after attach invalidates the
  handle so the next tool call re-attaches.
- **Throttled extend heartbeat**: `extendTimeout` is best-effort at attach and
  close and, additionally, as a throttled mid-turn heartbeat (every ≥
  `EXTEND_THROTTLE_MS`, default 5 min) so long multi-step turns do not idle out
  from a forgotten extend. It never fails the turn.


## 2. Architecture (product path)

```text
User types in Wasm composer
  → host polls pending submit (inflight guard)
  → runHarnessTurn
       → formatPromptWithHistory(session user/assistant only)
       → POST /api/agent { prompt }
            generateText + tools → sandbox (DB grants + backend; attach-only Workspace)
                                 + enabled per-user MCP tools (server-side; soft-fail)
            no usable grant + no alternate tools → 403 Sandbox access denied
              (no host 503 → chat fallback; the agent route never emits it)
            (sandbox Bearer + MCP header secrets; server-only)
  → host pushes ≤6 system toolTrace lines (≤240 chars) + assistant/error into Wasm
  → user reads in canvas
```

- **Wasm** remains the product UI (transcript + composer). No dual React chat.
- **Gateway key**, **sandbox token**, and **MCP API keys** never enter the client or Wasm.
- Per-user MCP config lives under Settings (`/settings/mcp`) — not this sandbox daemon guide; see [mcp.md](mcp.md).
- Detection is **server-side only** — no `NEXT_PUBLIC_SANDBOX_*`.

### No 503 chat fallback (multi-tenant product path)

There is **no** 503 `SANDBOX_NOT_CONFIGURED` → chat fallback in the current
product: the agent route never emits that status/string, and basic chat runs on
`POST /api/agent` too. When the session user has no usable sandbox grant and no
alternate tools (per-user MCP / builtin HTTP), the route returns **403**:

```http
HTTP/1.1 403
Content-Type: application/json

{ "error": "Sandbox access denied." }
```

Other 4xx/5xx/network errors are shown as error lines — **no** chat fallback.
A host-side legacy code path that would fall back to `/api/chat` on the exact
old not-configured 503 string is **dead** — it is not the operator contract.

### Sandbox resolve (DB grants)

Sandbox credentials are always **DB-resolved** for the signed-in user
(`resolveAgentSandbox`): branch on row `backend`; **byo** decrypts
`token_ciphertext`; **vercel** uses the host Sandbox control plane + row
`image`. Env `SANDBOX_*` is still used for **seed** / local daemon only —
never as the product-path credential source.

When the user has no usable grant / multiple usable grants without a Settings preference / ambiguous membership / invalid backend:

```http
HTTP/1.1 403
Content-Type: application/json

{ "error": "Sandbox access denied." }
```

Unauthenticated API calls → **401**
`{ "error": "Authentication required." }` (not a sandbox config issue).

### No 503 for a missing local sandbox

Missing env `SANDBOX_*` does **not** produce any 503 contract: product tool
turns resolve sandbox from **DB grants + row backend** (a valid `vercel` grant
works without env `SANDBOX_*`). A session user with no usable grant and no
alternate tools (MCP / builtin HTTP) gets **403** `Sandbox access denied.` (or
**401** if unauthenticated) — see above. No 503 chat-fallback path exists.

---

## 3. Protocol v2 (summary)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | none | `{ ok: true, version: 2, daemonVersion: N, workspaceRoot?: "/…" }` — the per-binding jail root `R` (daemon ≥ **2**); `workspaceRoot` is **omitted** when the jail root cannot yet be resolved (liveness/version always stay 200) |
| `POST` | `/v1/list_dir` | Bearer | List directory entries |
| `POST` | `/v1/read_file` | Bearer | Read file (max 16 MiB); additive `mtimeMs` + `size` when daemon supports |
| `POST` | `/v1/write_file` | Bearer | Write file (max 16 MiB); post-write fingerprint when supported |
| `POST` | `/v1/str_replace` | Bearer | Exact string replace (unique match or `replace_all`); post-write fingerprint when supported |
| `POST` | `/v1/stat` | Bearer | Path metadata `{ path, type, size, mtimeMs? }` — path missing: **404** with path-missing body (e.g. `Path not found`); not bare `Not found` (that is unknown-route). No file content |
| `POST` | `/v1/exec` | Bearer | Run argv command (no shell); optional `stdin`/`heredoc` (v2+) |

**Backend split:** BYO daemons implement stdin/heredoc on `/v1/exec`. The Vercel Sandbox SDK has no stdin channel — the Vercel client **fails soft** (400) and the agent should `write_file` then pass a path via args. App BYO clients probe `/health` and refuse stdin when `version < 2`.

If you hit the stale-daemon error (`…need v2+…`), your running daemon is pinned
to old code — upgrade/restart it per [§7 Upgrade a live daemon deployment](#7-byo-deploy-patterns).

### Daemon version → out-of-date gate

`health.version` is the **protocol**; `health.daemonVersion` is a separate
**monotonic daemon revision** (starts at **1** → **2** adds `workspaceRoot`;
older daemons without the field report running `0`). The Next backend ships a
matching expected revision
(`lib/sandbox/daemonVersion.ts` `EXPECTED_SANDBOX_DAEMON_VERSION`) and refuses
**any** FS tool call on a long-lived BYO daemon that is behind it — otherwise
deployed Next would send tools (e.g. `str_replace`) a long-lived unit does not
serve yet.

**Per-binding workspace root (`R`) on `/health`:** since daemon **2**, `GET
/health` includes `workspaceRoot` — the **resolved** BYO jail root
(`resolveWorkspaceRoot(SANDBOX_WORKSPACE)`: `realpath`, so even a relative or
symlinked env string yields the absolute root the daemon actually enforces). It
is returned **unauth** (like `version`/`daemonVersion`, on the token-private
daemon port); all FS mutation stays `/v1/*` token-gated. The client parses it
**fail-closed** — only an absolute, control-char-free **canonical** path (not bare
`/`, no `..` segment, no `//` or trailing slash) is accepted; relative / drive /
fake / stale bodies degrade `workspaceRoot` to `null`. Liveness/version
discovery is **not** coupled to `realpath`: if the jail root cannot be resolved
(missing / not-yet-mounted `SANDBOX_WORKSPACE`, boot race) `/health` **still**
returns **200 + `version`/`daemonVersion`** with `workspaceRoot` **omitted** —
the client parse sees `null` and a chat/MCP-only turn (which only needs the
version gate) is not killed; only the first FS tool against the broken root
fails. `R` is a per-binding property of the resolved sandbox
(`ResolvedAgentSandbox.workspaceRoot`, both BYO and Vercel via one
`SandboxClient.workspaceRoot()` accessor in `lib/sandbox/client.ts`), and host
path canonicalization is workspace-relative-keyed via
`lib/agent/workPath.ts` (`canonicalizePath(R, p)` / `workspaceAbsToRel`), so a
model passing `<R>/src/foo.ts` maps to the same ledger key as `src/foo.ts`
(extra separators after `R`, e.g. `<R>//src/foo.ts`, collapse to the same key)
while any host-absolute **outside** that binding's root is rejected. `R` is
**not** a global/session constant — never reuse one binding's root for another.
A down/pre-v2 BYO daemon degrades `workspaceRoot` to `null` (it never 403s a
turn); FS turns still gate 426/502 at `runAgent` preflight. Resolve probes
`workspaceRoot` **after** the DB connection is released and honors the request
abort signal + a bounded health timeout (10s), so a blackholed daemon never pins
a pooler slot while discovering `R`.

Out-of-date behavior:

- Client sends `X-Invincible-Expected-Daemon-Version: <expected>` on every
  `/v1/*` request and probes `GET /health` **once per client instance**.
- A daemon behind the expected revision (or one that predates `daemonVersion`)
  is rejected **before** the tool runs with HTTP **426** and
  `code: "SANDBOX_DAEMON_OUT_OF_DATE"`:

  ```json
  { "error": "Sandbox daemon out of date (running 0, expected N). Update and restart the sandbox process.",
    "code": "SANDBOX_DAEMON_OUT_OF_DATE", "running": 0, "expected": N }
  ```

- Tools soft-fail as `ERROR <tool>: Sandbox daemon out of date (…)`, and the
  agent preflight fails the turn before the first tool call. It is NOT mapped to
  `Sandbox access denied.` 403 (different status + string).
- Health-unreachable stays a normal network error (502/504) — it is **not** an
  out-of-date signal.
- Missing **protocol** version is a hard 502 (`restart the daemon`); missing or
  low **daemonVersion** is a **426** out-of-date (treat running as `0`).

**Bump policy:** increment `INVINCIBLE_SANDBOX_DAEMON_VERSION`
(`sandbox/constants.mjs`) **and** `EXPECTED_SANDBOX_DAEMON_VERSION`
(`lib/sandbox/daemonVersion.ts`) in the **same PR** whenever the daemon tool
surface / jail / budgets change in a way deployed Next depends on. A parity
unit test fails the merge if they diverge. Protocol bumps only for
wire-incompatible HTTP JSON.

#### Optional auto-update + self-restart

Opt-in so static/binary/BYO installs never require git. When enabled the daemon
runs `git status --porcelain`, then (only when **clean** and ff-able) `git fetch`
+ **ff-only** merges its checkout and exits `0` so a supervisor with
`Restart=always` reloads the new code. Fails closed: a **dirty** working tree,
divergent local work, or a git error leaves the daemon up and serving 426
(operator-visible), never a crash loop. Updates are **single-flight** — a
background timer and a request-triggered restart never run concurrent `git`
operations in parallel.

| Env (sandbox process, **not** Vercel) | Required | Default | Purpose |
|------|----------|---------|---------|
| `SANDBOX_AUTO_UPDATE` | no | off | `1`/`true` enables git self-update |
| `SANDBOX_GIT_DIR` | **yes** if auto-update on | — | Absolute path to the repo-root checkout (contains `sandbox/`) |
| `SANDBOX_GIT_REF` | no | `origin/main` | ff-only merge target after `git fetch`; passed to git after `--` so a dash-prefixed ref is never a git option |
| `SANDBOX_UPDATE_CHECK_MS` | no | `60000` | Background check interval; `0` disables the timer (header-triggered only); negative / non-numeric fail closed to `60000` |

systemd auto-update example (no secrets in the unit):

```ini
[Service]
Restart=always
RestartSec=2
WorkingDirectory=/path/to/invincible/checkout
Environment=SANDBOX_AUTO_UPDATE=1
Environment=SANDBOX_GIT_DIR=/path/to/invincible/checkout
```

Public repo clones need no token; private forks use a **read-only** deploy key
configured in that checkout's git config (operator-managed). Never put GitHub
Actions write credentials in the sandbox unit env. See
[`sandbox/README.md`](../sandbox/README.md) for package-level detail.

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
| `SANDBOX_URL` | seed / local daemon | Base URL of the sandbox (no trailing slash required) |
| `SANDBOX_TOKEN` | seed / local daemon | Shared bearer secret (must match daemon); also used by seed to encrypt into DB |
| `AGENT_MAX_STEPS` | no | Optional safety ceiling (1…256). **Unset** = model-ended tool loop (no default step cap) |

Also requires existing `AI_GATEWAY_API_KEY` for inference.

**Never** use `NEXT_PUBLIC_SANDBOX_URL` / `NEXT_PUBLIC_SANDBOX_TOKEN`.

### Sandbox process

| Name | Required | Default | Purpose |
|------|----------|---------|---------|
| `SANDBOX_TOKEN` | **yes** | — | Same secret as Vercel |
| `SANDBOX_WORKSPACE` | **yes** | — | Absolute jail root (must exist) |
| `SANDBOX_LISTEN` | no | `127.0.0.1:8787` | Bind address (localhost OK behind proxy) |
| `SANDBOX_AUTO_UPDATE` | no | off | Opt-in git self-update (`1`/`true`); see §3 daemon-version gate |
| `SANDBOX_GIT_DIR` | yes if auto-update on | — | Repo-root checkout path (contains `sandbox/`) |
| `SANDBOX_GIT_REF` | no | `origin/main` | ff-only merge target; passed after `--` (dash-prefixed refs never become flags) |
| `SANDBOX_UPDATE_CHECK_MS` | no | `60000` | Background update interval; `0` disables timer; negative/non-num fail closed to `60000` |

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
# {"ok":true,"version":2,"daemonVersion":2,"workspaceRoot":"/path/to/.sandbox-workspace"}
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

npm run dev
# open http://localhost:3000/harness
```

Harness smoke with tools (example prompt):

> Create `hello.txt` with hello world, then print its contents.

Expect muted **system** tool lines in the canvas, then an assistant reply.

Without a usable sandbox grant on Next: agent turns return **403** `Sandbox
access denied.` (there is no 503 → chat fallback). With a **vercel** grant you
do **not** need env `SANDBOX_*`; `SANDBOX_URL`/`SANDBOX_TOKEN` here are for
seed/local daemon only.

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
# expect: {"ok":true,"version":2,"daemonVersion":2,"workspaceRoot":"/…"}
```

**Version gate after upgrade:** once deployed Next sends an expected
`daemonVersion`, the long-lived unit must report `daemonVersion >=` that expected
revision or every tool call returns **426 out-of-date**. Options to get a unit
current: follow steps 1–5 once, **or** enable `SANDBOX_AUTO_UPDATE=1` +
`SANDBOX_GIT_DIR` on the unit as a one-time (or ongoing) path — the daemon ff-only
pulls and exits `0` so `Restart=always` loads the new code. See §3 daemon-version
gate for the env table and systemd example.

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

Use a granted model id from the catalog that is tool-capable. The agent always
uses the granted catalog + BYOK; there is no host env-model override.

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

Each user may store a **GitHub personal access token** under
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
| 1 | `GET /health` (local or off-box prod) | `{ ok: true, version: 2, daemonVersion: 2, workspaceRoot: "/…" }` |
| 2 | Harness with a usable sandbox grant | tool system lines + assistant for a write/exec prompt |
| 3 | No usable sandbox grant + no alternate tools (MCP / builtin HTTP) | **403** `Sandbox access denied.` (no 503 → chat fallback) |
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


## Read-before-edit (agent tools)

Agent filesystem tools enforce **read-before-edit** on the shared sandbox jail:

| Rule | Behavior |
|------|----------|
| Edit existing file | A successful full **`read_file`** of that path is required **in this agent run** before **`str_replace`** or overwriting with **`write_file`** |
| Create new file | **`write_file`** to a path that does not exist yet does **not** require a prior read. Existence is decided only when **`stat` reports true path-missing** (e.g. ENOENT / daemon `Path not found`) — not on bare HTTP 404 or generic `Not found` from a missing route |
| Truncated read | Does **not** authorize edit — read the full file first |
| Concurrent change | Before each mutate, tools **re-stat** the path. If mtime/size changed since the last observation (another browser tab, device, agent run, **`exec`**, or human on the same workspace), the tool soft-fails and the model must **`read_file` again** |
| Soft fail | Tools return `ERROR write_file:` / `ERROR str_replace:` strings — they do not throw |
| Unknown existence | If pre-mutate **`stat` fails** for a reason other than path-missing (including a daemon that does not implement **`POST /v1/stat`** yet), tools **fail closed** — they do **not** treat the path as create-new and do **not** overwrite |

**What is not a cache:** file observations live only for one agent HTTP run. They are **not** stored in harness SessionStore or multi-device session blobs. Tabs and devices that share a sandbox share **disk only** — safety is the re-stat, not session sync.

**Fingerprints:** BYO daemon responses include additive `mtimeMs` + `size` on read/write/str_replace and **`POST /v1/stat`**. When a backend omits mtime, tools still require a prior read (gate 1) but cannot detect same-size silent rewrites (gate 2 degrades). Prefer a daemon that ships fingerprints. Restart/upgrade a long-lived BYO unit if `stat` is missing so create-vs-edit stays accurate.

## Logical workspace cwd

The sandbox **jail root** (`SANDBOX_WORKSPACE` on the daemon) does not change per turn.
Agents also have a **logical cwd** owned by the agent tool layer + host session — not
`process.chdir` on the daemon.

The host now learns the jail root `R` per binding (`ResolvedAgentSandbox.workspaceRoot`)
and canonicalizes ledger paths with `lib/agent/workPath.ts` — an absolute `<R>/file`
and the relative `file` are the **same** freshness key, while any host-absolute
outside that binding's `R` is rejected. Tool arguments accept **in-jail absolute
paths** on every FS tool + `change_dir` + `exec` cwd (via `resolvePathForTool` /
`resolveExecCwdForTool` in `lib/agent/workPath.ts`, plumbed from the route →
`RunAgentParams.workspaceRoot` → `createAgentTools`), so a model that copies
`exec pwd`/stack/find output back requires **no conversion**: `exec` output is
canonicalized to the same workspace-relative form by `rewriteExecRootToRel`
(again in `lib/agent/workPath.ts`). A model that copies
`pwd`/stack/find output can pass `<R>/src/foo.ts` and land on the same file and
ledger key as `src/foo.ts`; both BYO and Vercel share this one host seam. When `R`
is unavailable (BYO daemon down/pre-v2/probe fault → `workspaceRoot === null`),
absolute args **fail closed** with “Sandbox workspace root unavailable — use a
workspace-relative path” while relative + logical cwd keep working.
`SANDBOX_DEFAULT_CWD` remains a per-deploy *default logical cwd*
(workspace-relative), distinct from the jail root.

### Why it exists

When the git repo is nested under the workspace (e.g. workspace root contains
`invincible/…`), models often invent wrong prefixes (`sandbox/x` instead of
`invincible/sandbox/x`). Logical cwd lets the agent `change_dir` once and then use
short relative paths.

### Tools

| Tool | Role |
|------|------|
| `change_dir` | Set logical cwd for subsequent tools this turn (host persists a confirmed `change_dir` even if the turn later cancels / times out / hard-errors) |
| `pwd` | Print current logical cwd (workspace-root-relative) |
| path tools (`list_dir`, `read_file`, `write_file`, `str_replace`, `exec`) | Resolve paths against logical cwd |

Every path-accepting tool (`list_dir`, `read_file`, `write_file`, `str_replace`,
`change_dir`, and `exec cwd`) accepts **relative**, **workspace-root-relative**,
and **slash-rooted in-jail absolute** (`<R>/…`) arguments — the in-jail absolute
form resolves to the same file and freshness ledger key as its relative form.
Host-absolute paths **outside** the active binding's root `R` still fail closed.
See the Prefix-aware resolve table.

### Prefix-aware resolve

Paths resolve with **prefix-aware** join (not naive always-join):

| Argument path | Behavior |
|---------------|----------|
| **`.`** (workspace root, default) | The default session/cwd start from `SANDBOX_DEFAULT_CWD`. Argument `.` resolves to the **current** logical cwd (stay); the `.` *value* is the workspace-root default when no other cwd is set |
| **`..` (walk up)** | Collapses within the workspace root — `change_dir ..` from `cwd=invincible/docs` → `invincible`. It errors ("Path escapes workspace root") only when it would climb **above** the jail root |
| Equals current cwd, or starts with `cwd/` | Treated as already workspace-root-relative — **not** re-joined under cwd |
| **Exact ancestor of cwd** | Re-roots to the workspace root instead of blind-joining: `change_dir invincible` from `cwd=invincible/docs` → `invincible`, **not** the phantom `invincible/docs/invincible`. A sibling that only shares a name prefix (`foo` from `cwd=foobar/x`) stays relative — no false re-root |
| Relative (`sandbox/x`, `./x`) | Joined under current logical cwd |
| **In-jail absolute** (`<R>/src/foo.ts`) | **Accepted** on all FS tools + `change_dir` + `exec` cwd — canonicalized to the **same workspace-relative key** as its relative form (`src/foo.ts`); identical freshness ledger, BYO + Vercel parity. `R` is the **active binding's** jail root (BYO daemon root or Vercel `/vercel/workspace`), resolved per turn — never a fixed host string |
| Host-absolute outside R / `..` escape (`/etc/…`, another binding's root) | **Fail closed** — “Path escapes workspace root” |
| Host-absolute when R is unresolvable (BYO daemon down/pre-v2) | **Fail closed** — “Sandbox workspace root unavailable — use a workspace-relative path”; relative + cwd still work |
| Windows drive `C:\…` | Rejected (fail closed) |

**Re-rooting:** the model can re-root toward the workspace root **either** by walking
up with `..` **or** by naming an exact ancestor of the current cwd (`change_dir
invincible` from `cwd=invincible/docs`). An **exact ancestor** re-roots cleanly
instead of producing a phantom nested path; a sibling that merely shares a name
prefix is never mistakenly re-rooted (guarded by tests).

Tool success lines always show **workspace-root-relative** paths (and `cwd=…` when
not at root) so models can copy paths without double-prefix mistakes. `exec`
stdout/stderr are **also** canonicalized: any absolute path under the active jail
root `R` is printed **workspace-relative** (`rewriteExecRootToRel` in
`lib/agent/workPath.ts`, applied to `result.stdout` and `result.stderr`
separately), so `exec pwd` ≡ `pwd` and `find` / `realpath` / `git rev-parse
--show-toplevel` / absolute error traces all surface in the one coordinate
system. Out-of-jail absolute text (`/etc/…`, another binding's root) is left
untouched, and when `R` is unresolvable the exec output passes through
byte-for-byte (fail-open — a degraded BYO turn looks unchanged). Rewrites are
capped and never throw. Because `:` is a token boundary (kept for `file:line`
grep), a colon-separated value that opens an under-`R` absolute is rewritten
too — e.g. `PATH=…:/vercel/workspace/node_modules/.bin` surfaces as
`PATH=…:node_modules/.bin`. Not a jail escape, but it mutates non-path
structured data; that tradeoff is locked by a `workPath` regression test.

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

Host updates the stored session cwd from the turn's **logical cwd**: success
prefers the authoritative `agentResult.cwd`, and a **confirmed successful
`change_dir`** is persisted even when the turn later cancels / times out /
hard-errors — so the next turn boots where the model actually worked. Persistence
never re-parses the display `summary`: the confirmed target travels as the **typed
`changeDirCwd`** on the stream `tool_result` event (or `ToolTraceEntry.cwd` on the
JSON path) — the **raw** value parsed from the `change_dir <rel>: ok cwd=<rel>`
success line, so long/deep targets survive the summary char budget without `…`
corruption. Only a confirmed `change_dir` (tool result `ok`, typed value present)
is persisted on a failed/aborted turn; a `change_dir` that errored, or a turn with
no `change_dir`, keeps the prior value. Clear session omits cwd. (There is no 503
chat-fallback path in the current product.)

See also [session-model.md](session-model.md) and [agent-stream.md](agent-stream.md).

## 12. Tenancy bootstrap (origin / BYO)

Agent tools resolve to **DB grants** for the signed-in user (never raw process
env for product turns). **Primary path is cloud-native** — do not treat a
personal laptop as the migrate/seed host.

1. Follow [bring-your-own.md §4a](bring-your-own.md#4a-multi-tenant-auth)
   (seed via GHA `db-tenancy-bootstrap` or a cloud agent; keep Production set in a
   safe order so tenancy does not activate against an unprepared DB).
2. Set the remaining triple-env var(s) on Vercel Production (typically
   `AUTH_SECRET` last) → redeploy. Do **not** set `AUTH_SECRET` before
   migrate/seed.
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
- [x] Prod `/harness` agent tool smoke  
- [x] Confirm no-grant → **403** path (no chat fallback) still understood for Preview/local  

Origin `SANDBOX_*` is marked **Done** in [AGENTS.md](../AGENTS.md) (2026-08-03).
Host inventory stays offline; forks still set their own env.
