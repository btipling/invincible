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
| Site chrome | **DOM** | `AppNav` brand header; optional `AuthNavLinks` (Sign in / Admin / Settings / Harness / Logout) when tenancy is on — **not** Playground tabs |
| Load `web.js` + `harness.wasm` | **DOM** | Instantiate, MIME, errors |
| JS ↔ Wasm bridge glue | **DOM** | `lib/harnessBridge.ts` |
| Poll pending submit | **DOM** | No custom Wasm imports beyond stock dvui `web.js` |
| `POST /api/chat` | **Vercel backend** | Single-shot inference; `AI_GATEWAY_API_KEY` never in Wasm |
| `POST /api/agent` | **Vercel backend** | Multi-step tools (sandbox + per-user MCP when configured); server-only secrets |
| Fold multi-turn history into prompt | **DOM** | `lib/harnessChat.ts` (user/assistant only; system tool lines display-only) |
| `SessionStore` load/save/clear | **DOM** | memory / localStorage |
| Session ring window + Load earlier poll | **DOM** host + **Wasm** control | Host slices ≤48; Wasm `Load earlier` pending (protocol v6); no React transcript |
| Thin status chips (model, lifecycle) | **DOM** (optional) | Must not replace in-canvas status; model chip is a **mirror** of Wasm selection, not a second picker |
| Model catalog fetch (`GET /api/models`) | **DOM** | Session-gated; host pushes ids into Wasm catalog |
| Model selection UI (label + **Next** cycle) | **Wasm** | Canvas header; protocol v3 catalog (bridge overall **v8**) |
| Selected `modelId` on inference | **DOM host** → **Vercel backend** | Host reads bridge; POST body; server re-authorizes grants + BYOK |
| Provider secrets / BYOK resolve | **Vercel backend** | DEK ciphertext; never Wasm/client |
| Per-user MCP config UI | **DOM** | `/settings`, `/settings/mcp` — not dual chat; not Admin |
| Per-user MCP tools (connect + execute) | **Vercel backend** | `lib/mcp/*`; keys under tenant DEK; never Wasm/client |
| Builtin HTTPS fetch (`http_get`) | **Vercel backend** | Env `BUILTIN_HTTP_FETCH`; Vercel Sandbox egress; see [builtin-http.md](builtin-http.md) |
| **Transcript (read messages)** | **Wasm** | Primary UX; rich MD + images + math + diff/patch fence paint in-canvas (`rich/*`) — no DOM markdown |
| Image bytes (fetch/decode) | **DOM host** | Browser fetch → RGBA → `inv_image_cache_put`; paint stays Wasm |
| Math pixels (TeX raster) | **DOM host** | Host MathJax SVG → RGBA → `inv_math_cache_put`; paint stays Wasm |
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
Host loads Wasm → GET /api/models → push catalog into bridge (protocol v6; catalog APIs from v3)
User cycles model in Wasm header (optional Next) — host chip mirrors selection
(optional) User configures personal MCP on /settings/mcp (keys → tenant DEK ciphertext)
User types in Wasm composer
  → inv_* pending submit (poll)
  → Host runHarnessTurn / SessionStore
  → formatPromptWithHistory (user/assistant only)
  → POST /api/agent { prompt, modelId? } with Accept: text/event-stream (default host)
       if 503 + exact sandbox-not-configured → POST /api/chat { prompt, modelId? }
       tenancy on: server attaches request-scoped BYOK for authorized modelId
       tools → sandbox (env SANDBOX_* when tenancy off; DB grants when on)
              + optional builtin http_get (Vercel Sandbox egress; env BUILTIN_HTTP_FETCH)
              + enabled per-user MCP tools (server-side only; soft-fail dead servers)
       SSE: tool_start / tool_result / reasoning_delta / text_delta / done (see docs/agent-stream.md)
       JSON fallback when Accept is not event-stream (tests / simple clients)
  → Host pushes live System tool lines + Thinking monologue + growing Assistant (protocol v8 update-last)
  → User reads thinking + tools + reply in Wasm transcript while Busy
```

**toolTrace display (host → Wasm system lines):** short human lines only —
``{toolName} · ok|failed · {preview}`` (≤6 lines, ≤240 chars). Not raw MCP/server
JSON envelopes such as `{"content":[{"type":"text",…}]}`. Tool execute results
are flattened server-side before the model and before summaries.

## Key source paths

| Concern | Path |
|---------|------|
| Host shell | `app/harness/HarnessHost.tsx` |
| Bridge TS (protocol **v8**) | `lib/harnessBridge.ts` |
| Image fetch/decode | `lib/harnessImages.ts` |
| Model catalog API | `app/api/models/route.ts` |
| Admin inference keys | `app/admin/inference/*` |
| User Settings / MCP servers | `app/settings/*` · `lib/tenancy/userMcpServers.ts` · `lib/mcp/client.ts` |
| BYOK resolve | `lib/tenancy/resolveInference*.ts`, `lib/gateway/byokProviders.ts` |
| Chat turn | `lib/harnessChat.ts` |
| Session | `lib/sessionStore.ts` |
| Zig UI | `native/harness/src/ui.zig` |
| Bridge Zig | `native/harness/src/bridge.zig` |
| Theme | `native/harness/src/palette.zig` ↔ `lib/palette.ts` |
| Export whitelist | `native/harness/build.zig` |

Host `HARNESS_PROTOCOL_VERSION` must equal Wasm `PROTOCOL_VERSION` (currently **8**).
Mismatch → load error; rebuild both sides. Image **bytes** enter only via bridge put; never dual DOM `<img>` product surface.

## Related

- Visitor front door: [README](../README.md)  
- Agent sandbox: [sandbox.md](sandbox.md)  
- Wasm supply / runner: [runner.md](runner.md)  
- Limits: [harness-limits.md](harness-limits.md)  
- Session restore: [session-model.md](session-model.md)  
- Agent SSE: [agent-stream.md](agent-stream.md)  
- Per-user MCP: [mcp.md](mcp.md)  
