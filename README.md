# invincible

In-browser agent harness — a Zig/dvui Wasm workspace hosted by Next.js, with inference via Vercel AI Gateway.

**License:** [MIT](LICENSE)

## What it is

Invincible is a **browser-based agent workspace**. You open `/harness`, and the
**canvas** is the product: type prompts, run multi-turn chat, smoke the Gateway
path, and (when configured) drive a jailed sandbox for agent tools.

The Next.js host is a thin shell — load the Wasm module, bridge messages, and
keep server-only secrets off the client. Clone it, point it at **your** Vercel
project and keys, and run the same harness on **your** work.

## Features

| | Feature | Notes |
|---|---------|--------|
| **Core** | Wasm harness chat | Transcript, composer, and turn UX live in the canvas (`/harness`) |
| **Core** | AI Gateway inference | `POST /api/chat` — `AI_GATEWAY_API_KEY` stays on the server |
| **Required** | Multi-tenant login + admin | Always on: credentials auth, grants, `/login` + `/admin` on every deploy (see [docs/bring-your-own.md](docs/bring-your-own.md)) |
| **Optional** | Agent tools + sandbox | `POST /api/agent` — DB grants + per-row `backend` (`byo`|`vercel`) and image; **Settings → Sandbox** durable Workspace (attach-only) — [docs/sandbox.md](docs/sandbox.md); origin dogfood: [dev/README.md](dev/README.md) |
| **Optional** | Builtin HTTPS fetch | `http_get` via a durable HTTP instance a user creates under **Settings → Sandbox** when `BUILTIN_HTTP_FETCH=sandbox` — [docs/builtin-http.md](docs/builtin-http.md) |
| **Optional** | Tenant BYOK inference | Admin **Inference keys** (`/admin/inference`), harness model cycle (canvas **Next**), request-scoped Gateway BYOK |
| **Optional** | Per-user MCP tools | Settings → MCP servers; tools on agent turns ([docs/mcp.md](docs/mcp.md)) |
| **Optional** | User GitHub PAT | Settings → GitHub token; sandbox **exec** injects `GH_TOKEN`/`GITHUB_TOKEN` ([docs/sandbox.md](docs/sandbox.md)) |
| **Optional** | Preferred sandbox + instances | Settings → Sandbox (catalog preference + Workspace/HTTP instance lifecycle) ([docs/sandbox.md](docs/sandbox.md)) |
| **Optional** | OIDC SSO + SCIM | Code on `main`; enable with env ([docs/bring-your-own.md §4b](docs/bring-your-own.md#4b-optional-sso-oidc--scim)) |
| **Optional** | Agent personas | Per-user `AGENTS.md`-style standing orders bound to a session and injected server-side ([docs/personas.md](docs/personas.md)) |

## Try it

### Local (best for new visitors)

For a full product path, configure the tenancy triple in `.env.local`
(`DATABASE_URL`, `AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`) and sign in. See
[Run locally](#run-locally) and [docs/bring-your-own.md](docs/bring-your-own.md)
for the required setup.

1. Set `AI_GATEWAY_API_KEY` (see [Run locally](#run-locally)).
2. `npm run dev` → open [http://localhost:3000/harness](http://localhost:3000/harness).
3. Type in the **canvas** composer → **Enter** or **Send**.
4. **Send** a short prompt to smoke the host Gateway path (reply appears in the canvas).
5. Refresh restores session into Wasm (and cloud when signed in); nav **Clear** resets local + cloud row.

### Reference deploy

Maintainer sample (not required for BYO success):

| | |
|--|--|
| **Production** | https://invincible-dun-ten.vercel.app |
| **Harness** | https://invincible-dun-ten.vercel.app/harness |

That host runs multi-tenant-only. Unauthenticated visits to
`/harness` redirect to **`/login`**. Use an account **you** control on that
deploy — this README does **not** publish seed passwords. A fresh fork or
`npm run dev` without the tenancy triple shows the login wall and fails closed
until tenancy is configured ([docs/bring-your-own.md](docs/bring-your-own.md)).

IDs and pointers: [`docs/project-ids.md`](docs/project-ids.md).

## Run locally

```bash
npm install
cp .env.example .env.local   # set AI_GATEWAY_API_KEY
# optional: HARNESS_ARTIFACT_TOKEN=… npm run fetch-harness
# or: HARNESS_SKIP_FETCH=1 if public/harness is already populated
npm run dev
```

Everything is multi-tenant-only: configure the tenancy triple (`DATABASE_URL`,
`AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`), migrate + seed, and sign in with a
user that has an **inference grant** and (for tool turns) a **sandbox grant** —
otherwise requests fail closed (401/403) and `/harness` redirects to `/login`.
Tool paths: [docs/sandbox.md](docs/sandbox.md) · [Builtin HTTP](docs/builtin-http.md).

```bash
npm test && npm run typecheck
```

## Deploy your own

→ **[docs/bring-your-own.md](docs/bring-your-own.md)** — clone → env → your Vercel →
secrets → Wasm supply → verify `/harness`.

| Topic | Doc |
|-------|-----|
| Agent tools workspace | [docs/sandbox.md](docs/sandbox.md) |
| Multi-tenant setup | [docs/bring-your-own.md §4a](docs/bring-your-own.md#4a-multi-tenant-auth) |
| Tenant BYOK inference | [docs/bring-your-own.md §4a Inference keys](docs/bring-your-own.md#inference-keys-byok) |
| OIDC + SCIM | [docs/bring-your-own.md §4b](docs/bring-your-own.md#4b-optional-sso-oidc--scim) |
| Per-user MCP | [docs/mcp.md](docs/mcp.md) |
| User GitHub PAT (Settings) | [docs/sandbox.md](docs/sandbox.md) (GitHub token section) |
| Self-hosted Zig runner | [docs/runner.md](docs/runner.md) |

Anyone can connect this repo to **their** Vercel project and keys — no single-host
hardcoding required.

## Architecture

- **Wasm harness** — primary product surface: transcript, composer, busy/error UI.
- **DOM host** — Next.js shell: route `/harness`, load `web.js` + `harness.wasm`,
  bridge poll/submit, thin nav/status chips (not a second chat).
- **Vercel backend** — `POST /api/chat` and `POST /api/agent`; Gateway key and
  sandbox tokens never enter the client or Wasm.
- **Session** — local-first `SessionStore` (memory + localStorage) restored into Wasm; optional **cloud multi-device** sync (id-shaped `/api/sessions*`, Redis-backed, server-minted ids) when the user is signed in.

Full ownership table: [`docs/feature-divide.md`](docs/feature-divide.md).

## Stack

| Layer | Tech |
|-------|------|
| App (DOM host) | Next.js 15 (App Router) + React 19 — shell only |
| Inference | Vercel AI Gateway (`ai` SDK) · `POST /api/chat` · `POST /api/agent` |
| Agent sandbox (optional) | Protocol v1 daemon (`sandbox/`) |
| Harness UI | Zig 0.16 + dvui Wasm (**primary** product surface) |
| Auth (optional) | Auth.js credentials + optional OIDC; SCIM Users API |
| Palette | Asteronica TEAL / WARM / EMBER |
| Session | `lib/sessionStore.ts` + `lib/sessionRepository.ts` (cloud hybrid) |
| Bridge | Protocol **v9** (`lib/harnessBridge.ts`) |
| Tests | Vitest |

## Docs

Living guides only (process / phase history lives in closed GitHub issues).

| Doc | Audience |
|-----|----------|
| [bring-your-own.md](docs/bring-your-own.md) | Operator — your Vercel + keys + Wasm paths |
| [sandbox.md](docs/sandbox.md) | Operator — agent tools workspace |
| [dev/README.md](dev/README.md) | Dogfood sandbox image (`dev/Dockerfile` + GHA→VCR) |
| [builtin-http.md](docs/builtin-http.md) | Operator — builtin HTTPS fetch (`http_get`) |
| [mcp.md](docs/mcp.md) | Operator — per-user MCP servers + Exa smoke |
| [feature-divide.md](docs/feature-divide.md) | Product — DOM shell vs Wasm harness |
| [agent-stream.md](docs/agent-stream.md) | Product — agent SSE events, thinking collapse, caps |
| [runner.md](docs/runner.md) | Operator — self-hosted Zig runner + workflows |
| [session-model.md](docs/session-model.md) | Product — session restore behavior |
| [personas.md](docs/personas.md) | Product — agent personas + how New session binds/injects |
| [harness-limits.md](docs/harness-limits.md) | Product — browser / mobile / density limits |
| [harness-deploy-race.md](docs/harness-deploy-race.md) | Operator — artifact vs Vercel race |
| [project-ids.md](docs/project-ids.md) | Maintainer sample IDs / URLs |
| [SECURITY.md](SECURITY.md) | Secrets + self-hosted public policy |
| [AGENTS.md](AGENTS.md) | Agent / contributor operating rules |

## Secrets

Server-only names — **never** commit values or put them in client/Wasm.

Set what you need via [`.env.example`](.env.example) locally and your Vercel
project env in production. Full cutover tables and order-of-operations:
[docs/bring-your-own.md](docs/bring-your-own.md). Policy: [SECURITY.md](SECURITY.md).

Minimum to chat: a signed-in user with an **inference grant** (BYOK), plus the
host `AI_GATEWAY_API_KEY`. Tool turns additionally need a **sandbox grant**.
Optional: harness artifact token, tenancy triple, OIDC/SCIM tokens — see
`.env.example` for names only.
