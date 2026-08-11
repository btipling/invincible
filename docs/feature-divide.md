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
| Site chrome | **DOM** | `AppNav` brand header; optional `AuthNavLinks` (Sign in / Admin / Settings / Harness / Logout) — **not** Playground tabs |
| Load `web.js` + `harness.wasm` | **DOM** | Instantiate, MIME, errors |
| JS ↔ Wasm bridge glue | **DOM** | `lib/harnessBridge.ts` |
| Poll pending submit | **DOM** | No custom Wasm imports beyond stock dvui `web.js` |
| `POST /api/chat` | **Vercel backend** | Single-shot inference; `AI_GATEWAY_API_KEY` never in Wasm |
| `POST /api/agent` | **Vercel backend** | Multi-step tools (sandbox + per-user MCP when configured); server-only secrets |
| Fold multi-turn history into prompt | **DOM** | `lib/harnessChat.ts` (user/assistant only; system tool lines display-only) |
| `SessionStore` load/save/clear | **DOM** | memory / localStorage (first paint) |
| Cloud session pull/push/DELETE (`/api/session`) | **DOM** host + **Vercel backend** | Hybrid async; never blocks first paint; no dual chat |
| Session ring window + Load earlier poll | **DOM** host + **Wasm** control | Host slices ≤**2048** (`HARNESS_RING_MAX`); **Load earlier** steps by **`HISTORY_PAGE` = 512**; Wasm pending (protocol v6); no React transcript |
| Thin status chips (model, lifecycle) | **DOM** (optional) | Must not replace in-canvas status; model chip is a **mirror** of Wasm selection, not a second picker |
| Model catalog fetch (`GET /api/models`) | **DOM** | Session-gated; host pushes ids into Wasm catalog |
| Model selection UI (label + **Next** cycle) | **Wasm** | Canvas header; protocol v3 catalog (bridge overall **v10**) |
| Selected `modelId` on inference | **DOM host** → **Vercel backend** | Host reads bridge; POST body; server re-authorizes grants + BYOK |
| Provider secrets / BYOK resolve | **Vercel backend** | DEK ciphertext; never Wasm/client |
| Per-user MCP config UI | **DOM** | `/settings`, `/settings/mcp` — not dual chat; not Admin |
| Per-user MCP tools (connect + execute) | **Vercel backend** | `lib/mcp/*`; keys under tenant DEK; never Wasm/client |
| Builtin HTTPS fetch (`http_get`) | **Vercel backend** | Env `BUILTIN_HTTP_FETCH`; attach-only durable HTTP instance (Settings Create HTTP instance); see [builtin-http.md](builtin-http.md) |
| **Transcript (read messages)** | **Wasm** | Primary UX; rich MD + images + math + diff/patch fence paint in-canvas (`rich/*`) — no DOM markdown |
| Image bytes (fetch/decode) | **DOM host** | Browser fetch → RGBA → `inv_image_cache_put`; paint stays Wasm |
| Math pixels (TeX raster) | **DOM host** | Host MathJax SVG → RGBA → `inv_math_cache_put`; paint stays Wasm |
| **Composer + Send** | **Wasm** | Primary input |
| **Stop / cancel turn** | **Wasm** control + **DOM** abort | Canvas **Stop** while busy → pending cancel (protocol v9); host aborts `AbortController` |
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
       server requires the session user: request-scoped BYOK for the authorized modelId
       tools → sandbox (DB grants + Settings Workspace attach)
              + optional builtin http_get (attach-only durable HTTPS instance; env BUILTIN_HTTP_FETCH)
              + enabled per-user MCP tools (server-side only; soft-fail dead servers)
       SSE: tool_start / tool_result / reasoning_delta / text_delta / done (see docs/agent-stream.md)
       JSON fallback when Accept is not event-stream (tests / simple clients)
  → Host aggregates each uninterrupted tool streak into ONE display-only `tool_run` message (kind 6, protocol v10) + Thinking monologue + growing Assistant (protocol v8 update-last); the `tool_run` row is **commit-once** — pushed to the bridge only at a true boundary (assistant text, turn end, or group-full roll), never live under Busy; on reload consecutive `tool_run` rows coalesce into scannable groups (plan #365)
  → Thinking rows **collapse** when tools/text supersede them (short ring residue; not SessionStore)
  → Tool-run rows paint as a default-collapsed `N tools called` expandable control (counts + two-level detail); see [harness-limits.md](harness-limits.md)
  → User reads thinking + reply in the Wasm transcript while Busy; the `N tools called` card commits on the first boundary (reply start or turn end), one group per streak
```

**toolTrace display (host → Wasm tool_run):** the host aggregates each
uninterrupted tool streak into **one** display-only `tool_run` message (bridge
kind 6, protocol v10, session role `tool_run`; `lib/toolRun.ts` payload,
`native/harness/src/rich/toolrun.zig` decoder). Short human one-liners only —
``{toolName} · ✓ ok|✗ failed · {preview}``, never raw MCP/server JSON envelopes
such as `{"content":[{"type":"text",…}]}`. Tool execute results are flattened
server-side before the model and before summaries. **DOM owns aggregation** (it
sees the structured `tool_result.ok`); **Wasm owns presentation** (expandable
paint; default collapsed). `tool_run` is persisted + repainted but **not**
folded into the model prompt (display-only). Grouping is driven by the single `lastUiKind` predicate in `lib/harnessChat.ts` (thinking keeps a streak; real assistant/user/error split; empty/whitespace-only assistant is not a boundary). On reload/hydrate (`pushSessionToBridge`) consecutive `tool_run` rows are coalesced via `mergeToolRunPayloads` into scannable groups (rolling at `TOOL_RUN_ITEMS_MAX`), never across an assistant/user/error boundary.

## Key source paths

| Concern | Path |
|---------|------|
| Host shell | `app/harness/HarnessHost.tsx` |
| Bridge TS (protocol **v10**) | `lib/harnessBridge.ts` |
| Image fetch/decode | `lib/harnessImages.ts` |
| Model catalog API | `app/api/models/route.ts` |
| Admin inference keys | `app/admin/inference/*` |
| User Settings / MCP servers | `app/settings/*` · `lib/tenancy/userMcpServers.ts` · `lib/mcp/client.ts` |
| BYOK resolve | `lib/tenancy/resolveInference*.ts`, `lib/gateway/byokProviders.ts` |
| Chat turn | `lib/harnessChat.ts` |
| Session | `lib/sessionStore.ts`, `lib/sessionRepository.ts`, [session-model.md](session-model.md) |
| Zig UI | `native/harness/src/ui.zig` |
| Bridge Zig | `native/harness/src/bridge.zig` |
| Theme | `native/harness/src/palette.zig` ↔ `lib/palette.ts` |
| Export whitelist | `native/harness/build.zig` |

Host `HARNESS_PROTOCOL_VERSION` must equal Wasm `PROTOCOL_VERSION` (currently **9**).
Mismatch → load error; rebuild both sides. Image **bytes** enter only via bridge put; never dual DOM `<img>` product surface.

## Related

- Visitor front door: [README](../README.md)  
- Agent sandbox: [sandbox.md](sandbox.md)  
- Wasm supply / runner: [runner.md](runner.md)  
- Limits: [harness-limits.md](harness-limits.md)  
- Session restore: [session-model.md](session-model.md)  
- Agent SSE: [agent-stream.md](agent-stream.md)  
- Per-user MCP: [mcp.md](mcp.md)  
