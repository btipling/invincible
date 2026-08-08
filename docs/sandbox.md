# Agent sandbox (BYO)

What tools the agent gets when a sandbox is configured: a remote path-jailed
workspace with `list_dir` / `read_file` / `write_file` / `exec` during a
harness turn.

Related: [bring-your-own.md](bring-your-own.md) · [feature-divide.md](feature-divide.md) ·
[mcp.md](mcp.md) · [builtin-http.md](builtin-http.md) · [SECURITY.md](../SECURITY.md) · [runner.md](runner.md) · package detail
[`sandbox/README.md`](../sandbox/README.md)

---

## 1. What it is / is not

| | |
|--|--|
| **Is** | A **separate HTTP daemon** (protocol v1) with a workspace root jail + four tools |
| **Is** | **BYO** — any operator points `SANDBOX_URL` + `SANDBOX_TOKEN` at **their** process |
| **Is not** | The Zig **GHA build runner** (`invincible-do-1` / `self-hosted` + `zig` labels) |
| **Is not** | Multi-tenant **fleet** isolation (still future). **Per-user MCP** is separate and **shipped** — [mcp.md](mcp.md). Optional **login tenancy** — [bring-your-own.md §4a](bring-your-own.md#4a-optional-multi-tenant-auth); optional **OIDC/SCIM** — [§4b](bring-your-own.md#4b-optional-sso-oidc--scim) |
| **Is not** | Required for basic chat — without env, harness falls back to `POST /api/chat` |
| **Is not** | Builtin HTTPS fetch (`http_get`) — that is **Vercel Sandbox** hop B; see [builtin-http.md](builtin-http.md) |

Never put GHA Actions credentials in the sandbox process env. Prefer a dedicated
OS user and reverse-proxy TLS in production.

---

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
              generateText + tools → sandbox (env SANDBOX_* / DB grants)
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

### Tenancy on vs legacy env (parent #54)

| Mode | When | Sandbox credentials |
|------|------|---------------------|
| **Legacy (tenancy off)** | Any of `DATABASE_URL` / `AUTH_SECRET` / `CREDENTIALS_ENCRYPTION_KEY` missing | Process env `SANDBOX_URL` + `SANDBOX_TOKEN` (this guide’s original path) |
| **Tenancy on** | All three set | **DB-resolved** sandbox for the signed-in user (`resolveAgentSandbox`): decrypt `token_ciphertext` server-side; enforce `sandbox_grants` R/W. Env `SANDBOX_*` still used for **seed** / local daemon, not as the sole Production path once tenancy is on. |

When tenancy is on and the user has no usable grant / ambiguous membership:

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
tools use DB grants; failures are **403** `Sandbox access denied.` (or **401**
if unauthenticated) — see above.

---

## 3. Protocol v1 (summary)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/health` | none | `{ ok: true, version: 1 }` |
| `POST` | `/v1/list_dir` | Bearer | List directory entries |
| `POST` | `/v1/read_file` | Bearer | Read file (max 16 MiB) |
| `POST` | `/v1/write_file` | Bearer | Write file (max 16 MiB) |
| `POST` | `/v1/exec` | Bearer | Run argv command (no shell) |

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
# {"ok":true,"version":1}
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

---

## 8. Budgets (locked with parent #45)

| Knob | Default | Cap / notes |
|------|---------|-------------|
| Route `maxDuration` | **1800s (30m)** — Vercel Fluid extended max; 1h not offered | `app/api/agent` (long multi-tool turns) |
| `AGENT_MAX_STEPS` | unset (model-ended) | optional 1…256 safety ceiling |
| exec `timeoutMs` | 10_000 | max 1_800_000 |
| read/write maxBytes | 16 MiB | |
| stdout/stderr per exec | 4 MiB each | truncated |
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

See also [SECURITY.md](../SECURITY.md).

---

## 11. Verify

| # | Check | Expect |
|---|--------|--------|
| 1 | `GET /health` (local or off-box prod) | `{ ok: true, version: 1 }` |
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
   **Done** in [AGENTS.md](../AGENTS.md) after smoke (phase 3 / #70).

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
