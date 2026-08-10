# Layer placement guide (DOM · harness · Vercel)

Companion to `create-plan`. Use when filling **Layer placement** and
**Architectural decisions**.

## Decision tree

```text
Does the user need to see or type it as part of the agent session?
  YES → harness (Wasm / dvui), unless it is pure host chrome (nav, load error)
  NO  → continue

Is it loading Wasm, bridging JS↔Wasm, folding session, or calling inference?
  YES → DOM host (`app/harness/*`, `lib/harness*.ts`, `lib/sessionStore.ts`)
        and/or Vercel backend for the network hop

Is it a secret, model call, or server validation?
  YES → Vercel backend only (`app/api/**`, server-only lib)

Is it multi-tenant config / bring-your-own project?
  YES → backend + env seams; document for reusability; do not hardcode one deploy
```

## DOM host shell

**Put here:**

- Next.js routes, layouts, code-splitting for `/harness`
- Shared site nav
- Instantiating `web.js` + `harness.wasm`, MIME/load errors
- `lib/harnessBridge.ts` protocol glue (poll pending submit, push messages)
- `lib/harnessChat.ts` history fold into prompt
- `lib/sessionStore.ts` memory / localStorage (until cloud session exists)
- Optional thin status chips (model name, lifecycle) that do **not** replace canvas status

**Do not put here:**

- Primary message transcript UI
- Primary composer as product path
- A second “Agent” React chat card competing with Wasm

## Harness (Wasm)

**Put here:**

- Transcript rendering and scroll/read UX
- Composer, Send
- In-canvas busy / error (EMBER for errors)
- Onboarding / empty states for the agent workspace
- Theme via `palette.zig` (synced with `lib/palette.ts`)

**Do not put here:**

- `AI_GATEWAY_API_KEY` or any secret
- Direct `fetch` to inference providers
- Assumptions that only one global Vercel project exists (prefer host-provided config later)

**Build note:** Zig compiles only on the labeled self-hosted runner. Plans that
change `native/harness/**` must include the artifact → Vercel path in DoD.

## Vercel backend

**Put here:**

- `POST /api/chat` and future server routes
- AI Gateway / model selection server-side
- Auth, rate limits, multi-tenant project binding (when designed)
- Anything that must not ship to the browser or Wasm

**Do not put here:**

- UI rendering
- Long-running agent loops that belong in a future sandbox runner (call out as
  future work; do not pretend the serverless route is a full sandbox)

## Reusability checklist (every multi-layer plan)

- [ ] Env vars named generically (not one person’s prod host baked into code)
- [ ] Project/runner IDs documented in `docs/project-ids.md` style, not hardcoded
      in harness logic
- [ ] Feature works conceptually for “clone + your Vercel + your keys”
- [ ] If not yet true, **Risks** names the gap and avoids deepening the bind
