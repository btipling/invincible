# invincible

Prompt playground / agent harness (Next.js + Zig/dvui Wasm).

**License:** [MIT](LICENSE)

## Live

| | |
|--|--|
| **Production** | https://invincible-dun-ten.vercel.app |
| **Harness** | https://invincible-dun-ten.vercel.app/harness |
| **Root** | https://invincible-dun-ten.vercel.app/ → redirects to `/harness` |
| **Vercel** | project `invincible` (Git-linked) |
| **IDs** | [`docs/project-ids.md`](docs/project-ids.md) |

### Try `/harness` (Wasm is the app)

1. Open the harness URL — after load, the **canvas** is the workspace (not a React chat card).  
2. Type in the canvas composer → **Enter** or **Send**.  
3. **PONG** smokes the host Gateway path (reply appears in canvas).  
4. Refresh restores session into Wasm; nav **Clear** resets.  
5. DOM chrome = nav + status chips only (host shell).

Feature divide: [`docs/feature-divide.md`](docs/feature-divide.md).

### Tracking

- **Phase 4 handoff (start here):** [`docs/phase-4-handoff.md`](docs/phase-4-handoff.md)
- **Phase 4 plan:** [`docs/phase-4-plan.md`](docs/phase-4-plan.md)
- **Phase 3 handoff (pipeline only):** [`docs/phase-3-handoff.md`](docs/phase-3-handoff.md)
- **Runner ops:** [`docs/runner.md`](docs/runner.md)
- **Board:** [projects/1](https://github.com/users/btipling/projects/1/views/1)
- **Milestones:** Phase 1–4 **done**
- **Agents:** [`AGENTS.md`](AGENTS.md)

## Secrets (server only)

| Variable | Where | Purpose |
|----------|--------|---------|
| `AI_GATEWAY_API_KEY` | Vercel | Inference via AI Gateway — **never** in client/Wasm |
| `HARNESS_ARTIFACT_TOKEN` | Vercel | Download Actions artifact `harness-wasm` at build |
| `DEFAULT_MODEL` | Vercel (optional) | default `xai/grok-4.1-fast-non-reasoning` |

GitHub Actions secret `VERCEL_DEPLOY_HOOK_URL` is already configured. See AGENTS.md — do not treat as a setup todo.

Local: copy `.env.example` → `.env.local` for the Gateway key only.

## Rebuild harness Wasm

Zig compiles **only** on self-hosted runner `invincible-do-1` (labels `invincible`, `zig`).

```bash
# after editing native/harness/**
git push origin main
# → build-harness.yml → artifact harness-wasm → Vercel prebuild fetches it
# race-safe wait: scripts/fetch-harness-artifact.mjs (docs/harness-deploy-race.md)

gh workflow run build-harness.yml

export HARNESS_ARTIFACT_TOKEN=…   # local
npm run fetch-harness && npm run dev
```

Details: [phase-4-handoff.md](docs/phase-4-handoff.md) · [native/harness/README.md](native/harness/README.md).

**Do not** commit `public/harness/*.wasm` / `web.js`.

## Stack

| Layer | Tech |
|-------|------|
| App | Next.js 15 (App Router) + React 19 |
| Inference | Vercel AI Gateway (`ai` SDK) · `POST /api/chat` |
| Harness UI | Zig 0.16 + dvui Wasm (**primary**); DOM host shell |
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

## Local dev

```bash
npm install
# optional: HARNESS_ARTIFACT_TOKEN=… npm run fetch-harness
npm run dev
npm test && npm run typecheck
```

## Docs index

| Doc | Topic |
|-----|--------|
| [phase-4-handoff.md](docs/phase-4-handoff.md) | **Start here** — Wasm-primary operator path |
| [feature-divide.md](docs/feature-divide.md) | DOM shell vs Wasm harness |
| [phase-4-plan.md](docs/phase-4-plan.md) | Phase 4 issue map (complete) |
| [harness-limits.md](docs/harness-limits.md) | Browser / mobile / density limits |
| [phase-3-handoff.md](docs/phase-3-handoff.md) | Pipeline rebuild (option B) |
| [runner.md](docs/runner.md) | DO runner + workflows |
| [session-model.md](docs/session-model.md) | SessionStore |
| [harness-deploy-race.md](docs/harness-deploy-race.md) | Artifact vs Vercel race |
| [project-ids.md](docs/project-ids.md) | Public URLs / env names |
| [SECURITY.md](SECURITY.md) | Secrets + self-hosted public policy |
