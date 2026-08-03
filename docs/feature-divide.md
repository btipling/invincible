# Feature divide — DOM host vs Wasm harness (Phase 4)

**Product rule:** **Wasm is the harness.** DOM is the **host shell** only.

Phase 3 inverted this (DOM chat + optional canvas). That was a pipeline PoC, not MVP.

## One-line test

> Can a user complete a multi-turn agent session **without reading or typing in a React chat panel**?

- **Yes** → Phase 4 MVP path  
- **No** → still a PoC  

## Ownership table

| Concern | Owner | Notes |
|---------|--------|--------|
| Route `/harness`, App Router, code-split | **DOM** | Next.js |
| Site nav (Playground / Harness) | **DOM** | Shared chrome |
| Load `web.js` + `harness.wasm` | **DOM** | Instantiate, MIME, errors |
| JS ↔ Wasm bridge glue | **DOM** | `lib/harnessBridge.ts` |
| Poll pending submit | **DOM** | No custom Wasm imports |
| `POST /api/chat` | **DOM / server** | `AI_GATEWAY_API_KEY` never in Wasm |
| Fold multi-turn history into prompt | **DOM** | `lib/harnessChat.ts` |
| `SessionStore` load/save/clear | **DOM** | memory / localStorage (cloud later) |
| Thin status chips (model, lifecycle) | **DOM** (optional) | Must not replace in-canvas status |
| **Transcript (read messages)** | **Wasm** | Primary UX |
| **Composer + Send / smoke** | **Wasm** | Primary input |
| Busy / error presentation for turns | **Wasm** | EMBER for errors |
| Empty / onboarding copy for agent | **Wasm** | |
| Asteronica canvas theme | **Wasm** | `palette.zig` |
| Frame loop / WebGL | **Wasm** | dvui |

## Forbidden dual-UI patterns

| Pattern | Why forbidden |
|---------|----------------|
| Large DOM “Agent” card with bubbles + composer while canvas is secondary | Dual chat; user ignores Wasm |
| “Show Wasm” as opt-in for core path | Wasm must be default workspace |
| DOM transcript as source of truth for reading | Wasm is the product surface |
| Putting Gateway key or raw secrets in Wasm | Security invariant |

## Allowed temporary exceptions

Track any exception in the issue that introduces it:

| Exception | When OK |
|-----------|---------|
| DOM fallback composer | Only if dvui text input is blocked on a target (e.g. specific mobile bug); must be labeled temporary |
| DOM error toast for *host* load failures | Wasm never started — host must report |

## Data flow (target)

```text
User types in Wasm composer
  → inv_* pending submit (poll)
  → Host runHarnessTurn / SessionStore
  → POST /api/chat
  → Host pushes assistant/error into Wasm
  → User reads reply in Wasm transcript
```

## Related

- Plan: [phase-4-plan.md](phase-4-plan.md)  
- Epic: [#27](https://github.com/btipling/invincible/issues/27)  
- Limits: [harness-limits.md](harness-limits.md)  
