# invincible

Prompt playground / agent harness.

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
- Calls `POST /api/chat` with `{ prompt }` (route in 1.4)
- Colors only from `lib/palette.ts` (teal chrome, warm model chip, ember errors)

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
- [ ] 1.4 API route → AI Gateway
- [ ] 1.5 Vercel project + deploy

### Later phases (not started)

- DO Droplet as self-hosted GitHub Actions runner
- Zig + dvui Wasm harness

### Palette

UI must use tokens from `lib/palette.ts` only (same rules as Asteronica):

- **TEAL** — default chrome
- **WARM** (`#d47c2c`) — intentional amber accent
- **EMBER** (`#d4412c`) — danger / errors only

See `AGENTS.md` for full color requirements.
