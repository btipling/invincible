# invincible

Prompt playground / agent harness (Next.js + Zig/dvui Wasm).

## Live

| | |
|--|--|
| **Production** | https://invincible-dun-ten.vercel.app |
| **Harness** | https://invincible-dun-ten.vercel.app/harness |
| **Playground** | https://invincible-dun-ten.vercel.app/ |
| **Vercel** | [invincible](https://vercel.com/bjorns-projects-65588ed4/invincible) |
| **IDs** | [`docs/project-ids.md`](docs/project-ids.md) |

### Try `/harness`

1. Open the harness URL (agent panel is primary UX).  
2. Type a prompt → **Send** or **⌘/Ctrl+Enter**.  
3. **Smoke: PONG** for a one-shot model check.  
4. **Show Wasm** for the Zig/dvui companion (Asteronica theme).  
5. Session restores from `localStorage` on refresh (Clear resets).

### Tracking

- **Phase 4 plan (active):** [`docs/phase-4-plan.md`](docs/phase-4-plan.md)
- **Phase 3 handoff (pipeline):** [`docs/phase-3-handoff.md`](docs/phase-3-handoff.md)
- **Runner ops:** [`docs/runner.md`](docs/runner.md)
- **Board:** [projects/1](https://github.com/users/btipling/projects/1/views/1)
- **Milestones:** Phase 1–3 **done** · Phase 4 **active** ([plan](docs/phase-4-plan.md))
- **Agents:** [`AGENTS.md`](AGENTS.md)

## Secrets (server only)

| Variable | Where | Purpose |
|----------|--------|---------|
| `AI_GATEWAY_API_KEY` | Vercel | Inference via AI Gateway — **never** in client/Wasm |
| `HARNESS_ARTIFACT_TOKEN` | Vercel | Download Actions artifact `harness-wasm` at build |
| `DEFAULT_MODEL` | Vercel (optional) | default `xai/grok-4.1-fast-non-reasoning` |

GitHub Actions secret `VERCEL_DEPLOY_HOOK_URL` is already configured (post–artifact redeploy). See AGENTS.md — do not treat as a setup todo.

Local: copy `.env.example` → `.env.local` for the Gateway key only.

## Rebuild harness Wasm

Zig compiles **only** on self-hosted runner `invincible-do-1` (labels `invincible`, `zig`).

```bash
# after editing native/harness/**
git push origin main
# → build-harness.yml → artifact harness-wasm → Vercel prebuild fetches it
# race-safe wait: scripts/fetch-harness-artifact.mjs (docs/harness-deploy-race.md)

# force CI
gh workflow run build-harness.yml

# local app with existing artifact
export HARNESS_ARTIFACT_TOKEN=…   # or gh auth
npm run fetch-harness && npm run dev
```

Details: [phase-3-handoff.md](docs/phase-3-handoff.md) · [native/harness/README.md](native/harness/README.md).

**Do not** commit `public/harness/*.wasm` / `web.js`.

## Stack

| Layer | Tech |
|-------|------|
| App | Next.js 15 (App Router) + React 19 |
| Inference | Vercel AI Gateway (`ai` SDK) · `POST /api/chat` |
| Harness UI | DOM agent panel + Zig 0.16 + dvui Wasm |
| Palette | Asteronica TEAL / WARM / EMBER (`lib/palette.ts` + `palette.zig`) |
| Session | `lib/sessionStore.ts` (memory + localStorage) |
| Tests | Vitest |

## Phase status

| Phase | Status |
|-------|--------|
| 1 Prompt MVP | **Done** — playground + Gateway |
| 2 Build runner (DO) | **Done** — `invincible-do-1`, Zig 0.16.0 |
| 3 Wasm harness | **Done** — pipeline PoC (DOM chat + bridge); not product MVP |
| 4 Wasm-first MVP | **Active** — [`docs/phase-4-plan.md`](docs/phase-4-plan.md) · epic [#27](https://github.com/btipling/invincible/issues/27) |

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

Errors: `{ "error": "…" }` with 4xx/5xx.

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
| [phase-3-handoff.md](docs/phase-3-handoff.md) | Fresh-session operator path |
| [phase-3-plan.md](docs/phase-3-plan.md) | Issue map + DoD |
| [runner.md](docs/runner.md) | DO runner + workflows |
| [harness-limits.md](docs/harness-limits.md) | Product / browser limits |
| [session-model.md](docs/session-model.md) | SessionStore + future cloud |
| [harness-deploy-race.md](docs/harness-deploy-race.md) | Artifact vs Vercel race |
| [project-ids.md](docs/project-ids.md) | IDs and configured env |
