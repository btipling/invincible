# Feature divide — where the UI lives

**Product rule:** The **product workspace** is the Wasm harness (transcript +
composer). The Next.js app is a **host shell** (load Wasm, bridge, APIs,
optional login chrome).

## One-line test

> Can a user complete a multi-turn agent session **without reading or typing in a React chat panel**?

- **Yes** → correct product path  
- **No** → dual-chat regression  

## Ownership table

| Concern | Owner | Notes |
|---------|--------|--------|
| Route `/harness`, App Router, code-split | **DOM** | Next.js |
| Site chrome | **DOM** | `AppNav` brand header; optional `AuthNavLinks` (Sign in / Admin / Harness / Logout) when tenancy is on — **not** Playground tabs |
| Load `web.js` + `harness.wasm` | **DOM** | Instantiate, MIME, errors |
| JS ↔ Wasm bridge glue | **DOM** | `lib/harnessBridge.ts` |
| Poll pending submit | **DOM** | No custom Wasm imports beyond stock dvui `web.js` |
| `POST /api/chat` | **Vercel backend** | Single-shot inference; `AI_GATEWAY_API_KEY` never in Wasm |
| `POST /api/agent` | **Vercel backend** | Multi-step tools when sandbox configured; server-only secrets |
| Fold multi-turn history into prompt | **DOM** | `lib/harnessChat.ts` (user/assistant only; system tool lines display-only) |
| `SessionStore` load/save/clear | **DOM** | memory / localStorage |
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

## Data flow

```text
User types in Wasm composer
  → inv_* pending submit (poll)
  → Host runHarnessTurn / SessionStore
  → formatPromptWithHistory (user/assistant only)
  → POST /api/agent
       if 503 + exact sandbox-not-configured → POST /api/chat
       else tools → sandbox (env SANDBOX_* when tenancy off; DB grants when on)
  → Host pushes ≤6 system toolTrace lines + assistant/error into Wasm
  → User reads reply in Wasm transcript
```

## Key source paths

| Concern | Path |
|---------|------|
| Host shell | `app/harness/HarnessHost.tsx` |
| Bridge TS (protocol **v3**) | `lib/harnessBridge.ts` |
| Chat turn | `lib/harnessChat.ts` |
| Session | `lib/sessionStore.ts` |
| Zig UI | `native/harness/src/ui.zig` |
| Bridge Zig | `native/harness/src/bridge.zig` |
| Theme | `native/harness/src/palette.zig` ↔ `lib/palette.ts` |
| Export whitelist | `native/harness/build.zig` |

Host `HARNESS_PROTOCOL_VERSION` must equal Wasm `PROTOCOL_VERSION` (currently **3**).
Mismatch → load error; rebuild both sides.

## Related

- Visitor front door: [README](../README.md)  
- Agent sandbox: [sandbox.md](sandbox.md)  
- Wasm supply / runner: [runner.md](runner.md)  
- Limits: [harness-limits.md](harness-limits.md)  
- Session restore: [session-model.md](session-model.md)  
