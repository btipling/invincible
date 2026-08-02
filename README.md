# invincible

Prompt playground / agent harness.

## Tracking

- **Project board:** [Invincible (projects/1)](https://github.com/users/btipling/projects/1/views/1)
- **Milestone (done):** [Phase 1 — Prompt MVP](https://github.com/btipling/invincible/milestone/1)
- **Milestone (next):** [Phase 2 — Build runner (DO)](https://github.com/btipling/invincible/milestone/2)
- **Phase 2 plan:** [`docs/phase-2-plan.md`](docs/phase-2-plan.md) · issues under milestone 2
- **Issues:** https://github.com/btipling/invincible/issues

## Live

**Production:** https://invincible-dun-ten.vercel.app  
**Vercel project:** [invincible](https://vercel.com/bjorns-projects-65588ed4/invincible) (team Bjorn's projects)  
**IDs:** see [`docs/project-ids.md`](docs/project-ids.md)

### Required for Send to work

In Vercel → invincible → **Settings → Environment Variables**:

1. `AI_GATEWAY_API_KEY` = your Gateway key (Production + Preview)
2. Redeploy production

Until that env is set, the UI loads but Send returns an error asking for the key.

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

### Local

```bash
npm install
npm run dev      # http://localhost:3000
npm test
npm run build
```

### Status

- [x] 1.1 GitHub repo
- [x] 1.2 Next.js scaffold + AI SDK + palette
- [x] 1.3 Prompt UI
- [x] 1.4 API route → AI Gateway
- [x] 1.5 Vercel project + deploy

### Later phases (not started)

- DO Droplet as self-hosted GitHub Actions runner
- Zig + dvui Wasm harness

### Palette

UI must use tokens from `lib/palette.ts` only (same rules as Asteronica):

- **TEAL** — default chrome
- **WARM** (`#d47c2c`) — intentional amber accent
- **EMBER** (`#d4412c`) — danger / errors only

See `AGENTS.md` for full color requirements.
