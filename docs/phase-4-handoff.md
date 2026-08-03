# Phase 4 operator handoff — Wasm-primary harness MVP

**Audience:** a new agent or human who must maintain or extend the **product** harness without Phase 3 dual-UI habits.

| | |
|--|--|
| **Repo** | https://github.com/btipling/invincible (private) |
| **Prod** | https://invincible-dun-ten.vercel.app |
| **Harness** | https://invincible-dun-ten.vercel.app/harness |
| **Epic** | [#27](https://github.com/btipling/invincible/issues/27) |
| **Plan** | [phase-4-plan.md](phase-4-plan.md) |
| **Feature divide** | [feature-divide.md](feature-divide.md) |
| **Agents** | [AGENTS.md](../AGENTS.md) |

---

## Product rule

1. **Wasm is the harness** — transcript, composer, Send/PONG, busy/error chrome live in Zig/dvui.  
2. **DOM is the host shell** — nav, load/error, bridge, `POST /api/chat`, SessionStore, thin status chips, Clear.  
3. **No dual chat** — do not rebuild a React agent panel as product UI.  
4. **Secrets** — `AI_GATEWAY_API_KEY` only on Vercel server; never in client or Wasm.

Phase 3 was a **pipeline PoC** (DOM chat + optional canvas). Do not restore that model.

---

## What Phase 4 shipped

| Surface | Behavior |
|---------|----------|
| `/harness` | Full-bleed **Wasm** workspace under site nav |
| DOM host | Load `web.js` + `harness.wasm`, poll submit, Gateway, session hydrate |
| Protocol | **v2** — hydrate batch, `getLifecycle`, `messageCount` |
| Chat loop | Canvas Enter/Send → pending submit → host → `/api/chat` → assistant in Wasm |
| Session | Host localStorage/memory; batched restore into Wasm on load |
| Palette | TEAL / WARM / EMBER on DOM + dvui |
| Build | Zig 0.16.0 on `invincible-do-1` → artifact `harness-wasm` → Vercel prebuild |

---

## Verify prod (user path)

1. Open https://invincible-dun-ten.vercel.app/harness  
2. After ready: **canvas** is the main surface (no large React chat card)  
3. Type in canvas → **Enter** or **Send**  
4. **PONG** smoke → assistant line in canvas  
5. Refresh → history rehydrates in canvas  
6. **Clear** (nav) → empty + system line  

Console: clean happy path (dvui WebGL noise OK).

---

## Rebuild path (unchanged option B)

```text
edit native/harness/**
  → push main
  → build-harness.yml on invincible-do-1
  → artifact harness-wasm
  → Vercel prebuild: scripts/fetch-harness-artifact.mjs
       (waits for commit-matched CI when racing Git deploy)
  → CDN /harness/*
```

```bash
gh workflow run build-harness.yml --repo btipling/invincible
export HARNESS_ARTIFACT_TOKEN=…   # local
npm run fetch-harness && npm run dev
```

Details: [runner.md](runner.md) · [harness-deploy-race.md](harness-deploy-race.md) · [phase-3-handoff.md](phase-3-handoff.md) (pipeline only).

**Protocol:** host `HARNESS_PROTOCOL_VERSION` must equal Wasm `PROTOCOL_VERSION` (currently **2**). Mismatch → load error; rebuild both sides.

---

## Key paths

| Concern | Path |
|---------|------|
| Host shell | `app/harness/HarnessHost.tsx` |
| Bridge TS | `lib/harnessBridge.ts` (v2 hydrate) |
| Chat turn | `lib/harnessChat.ts` |
| Session | `lib/sessionStore.ts` |
| Zig UI | `native/harness/src/ui.zig` |
| Bridge Zig | `native/harness/src/bridge.zig` |
| Theme | `native/harness/src/palette.zig` |
| Export whitelist | `native/harness/build.zig` |

---

## Secrets (already configured — do not nag)

| Secret | Where |
|--------|--------|
| `AI_GATEWAY_API_KEY` | Vercel |
| `HARNESS_ARTIFACT_TOKEN` | Vercel |
| `VERCEL_DEPLOY_HOOK_URL` | GitHub Actions |

---

## Suggested first message (post–Phase 4)

> Continue Invincible from `docs/phase-4-handoff.md` and `AGENTS.md`. Phase 4 Wasm-primary harness MVP complete. Repo: btipling/invincible. Prod: https://invincible-dun-ten.vercel.app. Do not re-do Phase 1–4 or restore DOM dual-chat.
