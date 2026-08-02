# invincible

Prompt playground / agent harness.

## Tracking

- **Runner ops:** [`docs/runner.md`](docs/runner.md)

- **Project board:** [Invincible (projects/1)](https://github.com/users/btipling/projects/1/views/1)
- **Milestone (done):** [Phase 1 — Prompt MVP](https://github.com/btipling/invincible/milestone/1)
- **Milestone (done):** [Phase 2 — Build runner (DO)](https://github.com/btipling/invincible/milestone/2)
- **Milestone (active):** [Phase 3 — Zig/dvui Wasm harness](https://github.com/btipling/invincible/milestone/3)
- **Phase 3 plan (handoff):** [`docs/phase-3-plan.md`](docs/phase-3-plan.md)
- **Phase 2 plan:** [`docs/phase-2-plan.md`](docs/phase-2-plan.md)
- **Issues:** https://github.com/btipling/invincible/issues

## Live

**Production:** https://invincible-dun-ten.vercel.app  
**Harness (Wasm UI):** https://invincible-dun-ten.vercel.app/harness  
**Vercel project:** [invincible](https://vercel.com/bjorns-projects-65588ed4/invincible) (team Bjorn's projects)  
**IDs:** see [`docs/project-ids.md`](docs/project-ids.md)

### Required for Send to work

In Vercel → invincible → **Settings → Environment Variables**:

1. `AI_GATEWAY_API_KEY` = your Gateway key (Production + Preview)
2. Redeploy production

Until that env is set, the UI loads but Send returns an error asking for the key.

### Harness Wasm assets (Phase 3.4 option B)

| Variable | Where |
|----------|--------|
| `HARNESS_ARTIFACT_TOKEN` | Vercel env — fine-grained PAT, **Actions: Read** on this repo |

`npm run prebuild` downloads Actions artifact `harness-wasm` into `public/harness/` (gitignored binaries).

JS ↔ Wasm protocol: [`native/harness/README.md`](native/harness/README.md) · glue [`lib/harnessBridge.ts`](lib/harnessBridge.ts) · chat host [`lib/harnessChat.ts`](lib/harnessChat.ts).

## Phase 1 — Prompt → response MVP

Minimal Next.js app: type a prompt, get a model reply via [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

No tools, no Wasm, no agent loop yet.

### Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 15 (App Router) + React 19 |
| Inference | Vercel AI Gateway (`ai` SDK) |
| Palette | Asteronica TEAL / WARM / EMBER (`lib/palette.ts`) |
| Tests | Vitest |

Structure mirrors [webgpu-game](https://github.com/btipling/webgpu-game): `app/` shell, `lib/` logic.

### Env

| Variable | Where |
|----------|--------|
| `AI_GATEWAY_API_KEY` | `.env.local` (local) and Vercel project env (prod/preview) |

See `.env.example`.

### Prompt UI (Phase 1.3)

- Textarea + **Send** (also ⌘/Ctrl+Enter)
- Response panel + ember error banner
- Calls `POST /api/chat` with `{ prompt }`
- Colors only from `lib/palette.ts` (teal chrome, warm model chip, ember errors)

### Chat API (Phase 1.4)

```http
POST /api/chat
Content-Type: application/json

{ "prompt": "hello" }
```

```json
{ "text": "…" }
```

Errors: `{ "error": "…" }` with 4xx/5xx.

Uses Vercel AI Gateway + AI SDK `generateText`. Model default: `xai/grok-4.1-fast-non-reasoning` (override with `DEFAULT_MODEL`).

### Phase checklist

- [x] 1.1 Scaffold
- [x] 1.2 Palette
- [x] 1.3 Prompt UI
- [x] 1.4 API route → AI Gateway
- [x] 1.5 Vercel project + deploy

### Later phases

- [x] Phase 2: DO self-hosted runner (`invincible-do-1`)
- Phase 3: Zig + dvui Wasm harness — **3.1–3.7 done** (bridge + `/api/chat` from harness); next **#24 MVP UX** or **#23 session** — see [`docs/phase-3-plan.md`](docs/phase-3-plan.md)

### Palette

UI must use tokens from `lib/palette.ts` only (same rules as Asteronica):

- **TEAL** — default chrome
- **WARM** (`#d47c2c`) — intentional amber accent
- **EMBER** (`#d4412c`) — danger / errors only
