# invincible

Prompt playground / agent harness.

## Phase 1 — Prompt → response MVP

Minimal Next.js app: type a prompt, get a model reply via [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

No tools, no Wasm, no agent loop yet.

### Env

| Variable | Where |
|----------|--------|
| `AI_GATEWAY_API_KEY` | `.env.local` (local) and Vercel project env (prod/preview) |

See `.env.example`.

### Status

- [x] 1.1 GitHub repo
- [ ] 1.2 Next.js scaffold + AI SDK
- [ ] 1.3 Prompt UI
- [ ] 1.4 API route → AI Gateway
- [ ] 1.5 Vercel project + deploy

### Later phases (not started)

- DO Droplet as self-hosted GitHub Actions runner
- Zig + dvui Wasm harness
