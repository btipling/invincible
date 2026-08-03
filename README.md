# invincible

In-browser agent harness — Zig/dvui Wasm workspace hosted by Next.js, inference via Vercel AI Gateway.

**License:** [MIT](LICENSE)

## Reusable product

This is **not** a one-off demo for a single deployment. The long-term goal is that
**anyone can clone this repo**, connect **their own Vercel project**, and their own
**sandbox / runner environment**, then use the harness on **their** work — **any
language or platform** on the target side.

**Start here if you are cloning or forking:**  
→ **[docs/bring-your-own.md](docs/bring-your-own.md)** — clone → env → your Vercel → secrets → Wasm paths → verify `/harness`.  
→ **[docs/sandbox.md](docs/sandbox.md)** — optional agent tools workspace (`SANDBOX_URL` + `SANDBOX_TOKEN`).

Sandbox **MVP** and **optional multi-tenant auth** (login + DB grants) are
shipped as config seams (tenancy off = legacy open APIs + env sandbox; without
sandbox env, harness falls back to chat). SSO/SCIM / MCP remain future.
Prefer config seams over hardcoding one owner’s prod. Agent rules:
[`AGENTS.md`](AGENTS.md) → **Reusable product**. BYO tenancy:
[`docs/bring-your-own.md`](docs/bring-your-own.md) §4a.

## Reference deployment (maintainer)

Sample public deploy for demos — **not required** for BYO success.

| | |
|--|--|
| **Production** | https://invincible-dun-ten.vercel.app |
| **Harness** | https://invincible-dun-ten.vercel.app/harness |
| **Root** | https://invincible-dun-ten.vercel.app/ → redirects to `/harness` |
| **Vercel** | project `invincible` (Git-linked to origin) |
| **IDs** | [`docs/project-ids.md`](docs/project-ids.md) |

### Try `/harness` (Wasm is the app)

Works on **any** host (local, your Vercel, or the reference deploy):

1. Open `/harness` — after load, the **canvas** is the workspace (not a React chat card).  
2. Type in the canvas composer → **Enter** or **Send**.  
3. **PONG** smokes the host Gateway path (reply appears in canvas).  
4. Refresh restores session into Wasm; nav **Clear** resets.  
5. DOM chrome = nav + status chips only (host shell).  
6. **Optional tools:** with sandbox env set, agent turns can write/exec in a jailed workspace ([docs/sandbox.md](docs/sandbox.md)).

Feature divide: [`docs/feature-divide.md`](docs/feature-divide.md). Full BYO checklist: [`docs/bring-your-own.md`](docs/bring-your-own.md).

### Tracking

- **BYO / clone setup:** [`docs/bring-your-own.md`](docs/bring-your-own.md)
- **Agent sandbox:** [`docs/sandbox.md`](docs/sandbox.md)
- **Phase 4 handoff (product):** [`docs/phase-4-handoff.md`](docs/phase-4-handoff.md)
- **Phase 4 plan:** [`docs/phase-4-plan.md`](docs/phase-4-plan.md)
- **Phase 3 handoff (pipeline only):** [`docs/phase-3-handoff.md`](docs/phase-3-handoff.md)
- **Runner ops:** [`docs/runner.md`](docs/runner.md)
- **Board:** [projects/1](https://github.com/users/btipling/projects/1/views/1)
- **Milestones:** Phase 1–4 **done**
- **Agents:** [`AGENTS.md`](AGENTS.md)
- **Project skills:** [`.grok/skills/README.md`](.grok/skills/README.md) — **create-plan** (plans as GitHub issues), **plan-review**

## Agent skills (planning)

| Skill | When | Where |
|-------|------|--------|
| **create-plan** | “use the create-plan skill to add …” | [`.grok/skills/create-plan/SKILL.md`](.grok/skills/create-plan/SKILL.md) |
| **plan-review** | Review a plan issue before coding | [`.grok/skills/plan-review/SKILL.md`](.grok/skills/plan-review/SKILL.md) |
| **adversarial-review** | Hostile PR review before merge | [`.grok/skills/adversarial-review/SKILL.md`](.grok/skills/adversarial-review/SKILL.md) |

Plans are filed as **GitHub issues** (parent issue + optional phase issues that
link back). PR merge gates use **adversarial-review**. Requires authenticated
`gh`; do not use GitHub MCP for these flows.

## Secrets (server only)

Names only — never commit values. Full BYO steps: [docs/bring-your-own.md](docs/bring-your-own.md).

| Variable | Where | Purpose |
|----------|--------|---------|
| `AI_GATEWAY_API_KEY` | Vercel / local `.env.local` | Inference via AI Gateway — **never** in client/Wasm |
| `HARNESS_ARTIFACT_TOKEN` | Vercel (and local fetch) | Download Actions artifact `harness-wasm` at build / `npm run fetch-harness` |
| `DEFAULT_MODEL` | Vercel (optional) | default `xai/grok-4.1-fast-non-reasoning` |
| `HARNESS_OWNER` / `HARNESS_REPO` | Vercel / local (optional) | Override artifact source; else Vercel Git / `GITHUB_REPOSITORY` |
| `VERCEL_DEPLOY_HOOK_URL` | GitHub Actions **secret** (optional) | `build-harness` may ping after artifact upload |
| `SANDBOX_URL` / `SANDBOX_TOKEN` | Vercel / local server (optional) | Agent sandbox when tenancy **off** — server only; prod URL must reach from Vercel |
| `AGENT_MAX_STEPS` / `AGENT_MODEL` | Vercel (optional) | Tool-loop steps / tool-capable model override |
| `DATABASE_URL` | Vercel / GHA (optional tenancy) | Pooled Postgres — required with the two rows below for tenancy **on** |
| `AUTH_SECRET` | Vercel (optional tenancy) | Auth.js session secret — set **after** migrate/seed |
| `CREDENTIALS_ENCRYPTION_KEY` | Vercel / GHA (optional tenancy) | Base64 32-byte AES-GCM KEK for sandbox tokens at rest |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | GHA / agent seed only | Bootstrap admin — never commit; re-seed resets password hash |
| `SEED_SANDBOX_URL` / `SEED_SANDBOX_TOKEN` | GHA / agent seed only | Optional; else `SANDBOX_*` used at seed time |

**BYO:** set the table above on **your** Vercel project (and optional Actions secrets on **your** repo). Tenancy cutover: [docs/bring-your-own.md](docs/bring-your-own.md) §4a (GHA primary).  
**Origin maintainer (`btipling/invincible`):** Gateway / harness / deploy-hook / **sandbox** (`SANDBOX_*`) rows are **Done** on Production — agents must not re-nag those unless a build log or harness smoke proves a regression ([AGENTS.md](AGENTS.md)). **Tenancy triple env is Not Done** until cutover smoke (unauth 401 + login). Optional `AGENT_*` remains operator preference. Do not invent a host URL ([docs/sandbox.md](docs/sandbox.md)).

Local / agent workspace: copy [`.env.example`](.env.example) → session env (Gateway key + optional `HARNESS_*` / `SANDBOX_*` / tenancy triple). Prefer GHA for Production migrate/seed.

## Rebuild harness Wasm

Zig compiles on a **self-hosted** GitHub Actions runner (default labels
`self-hosted`, `invincible`, `zig`). Clones: attach **your** runner, set Actions
variable `SELF_HOSTED_BUILDS=true` (optional `RUNNER_LABELS` JSON). Origin keeps a
grandfather path without the variable. See [docs/runner.md](docs/runner.md) and
[docs/bring-your-own.md](docs/bring-your-own.md) path **A**.

Maintainer sample runner name: `invincible-do-1`.

```bash
# after editing native/harness/**
git push origin main
# → build-harness.yml → artifact harness-wasm → Vercel prebuild fetches it
# race-safe wait: scripts/fetch-harness-artifact.mjs (docs/harness-deploy-race.md)

gh workflow run build-harness.yml --repo <owner>/<repo>

export HARNESS_ARTIFACT_TOKEN=…   # local
npm run fetch-harness && npm run dev
```

Details: [docs/bring-your-own.md](docs/bring-your-own.md) · [docs/phase-4-handoff.md](docs/phase-4-handoff.md) · [native/harness/README.md](native/harness/README.md).

**Do not** commit `public/harness/*.wasm` / `web.js`.

## Stack

| Layer | Tech |
|-------|------|
| App (DOM host) | Next.js 15 (App Router) + React 19 — shell only |
| Inference (Vercel backend) | Vercel AI Gateway (`ai` SDK) · `POST /api/chat` · `POST /api/agent` |
| Agent sandbox (optional) | Protocol v1 daemon (`sandbox/`) — [docs/sandbox.md](docs/sandbox.md) |
| Harness UI | Zig 0.16 + dvui Wasm (**primary** product surface) |
| Palette | Asteronica TEAL / WARM / EMBER (`lib/palette.ts` + `palette.zig`) |
| Session | `lib/sessionStore.ts` (memory + localStorage) |
| Bridge | Protocol **v2** (`lib/harnessBridge.ts`) |
| Tests | Vitest |

## Phase status

| Phase | Status |
|-------|--------|
| 1 Prompt MVP | **Done** — Gateway API (UI entry is harness) |
| 2 Build runner (DO) | **Done** — `invincible-do-1`, Zig 0.16.0 |
| 3 Wasm pipeline | **Done** — PoC; product model superseded by Phase 4 |
| 4 Wasm-first MVP | **Done** — [phase-4-handoff.md](docs/phase-4-handoff.md) |

### Palette

- **TEAL** — default chrome  
- **WARM** (`#d47c2c`) — intentional amber accent  
- **EMBER** (`#d4412c`) — danger / errors only  

### Chat API

```http
POST /api/chat
Content-Type: application/json

{ "prompt": "hello" }
```

```json
{ "text": "…" }
```

Errors: `{ "error": "…" }` with 4xx/5xx. Key never leaves the server.

### Agent API (optional sandbox)

```http
POST /api/agent
Content-Type: application/json

{ "prompt": "list files and summarize" }
```

```json
{ "text": "…", "toolTrace": [{ "name": "list_dir", "ok": true, "summary": "…" }] }
```

When sandbox env is unset: **503** with exact
`Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.` — host falls back
to `/api/chat`. Details: [docs/sandbox.md](docs/sandbox.md).

## Local dev

```bash
npm install
cp .env.example .env.local   # set AI_GATEWAY_API_KEY
# optional: HARNESS_ARTIFACT_TOKEN=… npm run fetch-harness
# or: HARNESS_SKIP_FETCH=1 if public/harness already populated
npm run dev
npm test && npm run typecheck
```

Clone / production BYO: [docs/bring-your-own.md](docs/bring-your-own.md).

## Docs index

| Doc | Topic |
|-----|--------|
| [bring-your-own.md](docs/bring-your-own.md) | **Clones / BYO** — your Vercel + keys + Wasm paths |
| [sandbox.md](docs/sandbox.md) | **Agent sandbox** — tools workspace, env, verify |
| [phase-4-handoff.md](docs/phase-4-handoff.md) | Wasm-primary operator path (reference deploy samples) |
| [feature-divide.md](docs/feature-divide.md) | DOM shell vs Wasm harness |
| [phase-4-plan.md](docs/phase-4-plan.md) | Phase 4 issue map (complete) |
| [harness-limits.md](docs/harness-limits.md) | Browser / mobile / density limits |
| [phase-3-handoff.md](docs/phase-3-handoff.md) | Pipeline rebuild (option B) |
| [runner.md](docs/runner.md) | DO runner + workflows |
| [session-model.md](docs/session-model.md) | SessionStore |
| [harness-deploy-race.md](docs/harness-deploy-race.md) | Artifact vs Vercel race |
| [project-ids.md](docs/project-ids.md) | Public URLs / env names |
| [SECURITY.md](SECURITY.md) | Secrets + self-hosted public policy |
| [AGENTS.md](AGENTS.md) | Agent rules, reusability, skills |
| [.grok/skills/README.md](.grok/skills/README.md) | create-plan / plan-review / adversarial-review |
