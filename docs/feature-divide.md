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
| Cloud session list/mint/pull/push/DELETE (`/api/sessions*`) | **DOM** host + **Vercel backend** | Redis multi-session (+ **phase 0 #515 envelope + Blob transcript**), server-minted ids; hybrid async; never blocks first paint; no dual chat. **Wasm never talks to Redis or Blob** — the DOM host drives the client→Blob upload + envelope upsert |
| Session ring window + Load earlier poll | **DOM** host + **Wasm** control | Host slices ≤**2048** (`HARNESS_RING_MAX`); **Load earlier** steps by **`HISTORY_PAGE` = 512**; Wasm pending (protocol v6); no React transcript |
| Thin status chips (model, lifecycle) | **DOM** (optional) | Must not replace in-canvas status; model chip is a **mirror** of Wasm selection, not a second picker |
| Model catalog fetch (`GET /api/models`) | **DOM** | Session-gated; host pushes ids into Wasm catalog |
| Model selection UI (label + **Next** cycle) | **Wasm** | Canvas header; protocol v3 catalog (bridge overall **v12**) |
| Skill attach display (`Skill attached: <slug>`) | **Wasm** (display-only kind 7) + **Vercel** (resolve/inject) | Server resolves `/skill-name` + injects the body into system context (after the persona); the Wasm canvas shows only the skill NAME row (message kind 7, display-only) — never the body |
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
  → Host aggregates each uninterrupted tool streak into a display-only `tool_run` message (kind 6, protocol v11) + Thinking monologue + growing Assistant (protocol v8 update-last). The `tool_run` card is **painted live**: each tool event opens (or grows) exactly ONE kind-6 card immediately — `1 tool called` → `2 tools called` → … — via `update_last` while the last ring row is a tool-run, else a NEW card at `1`. A thinking/assistant/user/error row that lands last is a physical separator (forces a new card); on reload consecutive `tool_run` rows coalesce into scannable groups (plan #365)
  → Thinking rows **collapse at turn end** into a compact expandable control (in-memory; ephemeral; not SessionStore); the active Busy turn stays fully expanded
  → Tool-run rows paint as a default-collapsed `N tools called` expandable control (counts + two-level detail); see [harness-limits.md](harness-limits.md)
  → User reads the live `N tools called` increment in the Wasm transcript while Busy — the count grows per tool event on the canvas, never withheld until a boundary
  → The server parses a leading `/skill-name` (or `/unskill slug`) into an attach/detach, injects attached-skill bodies into system context (`skillsPreamble`, after the persona), emits a `skill_attached` SSE event, and the host pushes a display-only `Skill attached: <slug>` row (protocol v12, message kind 7) — never the body
```

**toolTrace display (host → Wasm tool_run):** the host aggregates each
uninterrupted tool streak into **one** display-only `tool_run` message (bridge
kind 6, protocol v11, session role `tool_run`; `lib/toolRun.ts` payload,
`native/harness/src/rich/toolrun.zig` decoder). Short human one-liners only —
``{toolName} · ✓ ok|✗ failed · {preview}``, never raw MCP/server JSON envelopes
such as `{"content":[{"type":"text",…}]}`. Tool execute results are flattened
server-side before the model and before summaries. **DOM owns aggregation** (it
sees the structured `tool_result.ok`); **Wasm owns presentation** (expandable
paint; default collapsed). `tool_run` is persisted + repainted but **not**
folded into the model prompt (display-only). Under the **#433 live-increment
lock**, the live-path grouping predicate in `lib/harnessChat.ts` is a single
`lastRingRowIsToolRun` flag (the host is the only ring writer): a tool event
grows the open card iff the last ring row is a tool-run, else it opens a NEW
card at `1` — so a thinking/assistant/user/error row that lands last (incl. a
Thinking separator) starts a fresh card; empty/whitespace-only assistant is not
a boundary. On reload/hydrate (`pushSessionToBridge`) consecutive `tool_run`
rows are coalesced via `mergeToolRunPayloads` into scannable groups (rolling at
`TOOL_RUN_ITEMS_MAX`), never across an assistant/user/error boundary.

**skill_attached display (server → host → Wasm):** the server parses leading
`/skill-name` and `/unskill slug`, resolves attached skill slugs via
`lib/tenancy/skillInject.ts`, and injects their bodies into system context as a
`skillsPreamble` appended **after the persona** (bodies stay **server-only**).
On the wire it emits a `skill_attached {slug, action, ok}` SSE event (or
`skillEvents` on the JSON path); the host pushes a display-only bridge message
kind **7** (`MessageKind.SkillAttached`, session role `skill_attached`) whose
text is just `Skill attached: <slug>` (or detached / not-attached). **Wasm owns
the row paint** (`paintSkillAttached`, protocol v12); it shows only the skill
NAME. The body is never shipped to the client and never folded into the model
prompt — attachment is session-sticky via `meta.attachedSkills` (slugs only),
re-resolved each turn.

## Key source paths

| Concern | Path |
|---------|------|
| Host shell | `app/harness/HarnessHost.tsx` |
| Bridge TS (protocol **v12**) | `lib/harnessBridge.ts` |
| Image fetch/decode | `lib/harnessImages.ts` |
| Model catalog API | `app/api/models/route.ts` |
| Admin inference keys | `app/admin/inference/*` |
| User Settings / MCP servers | `app/settings/*` · `lib/tenancy/userMcpServers.ts` · `lib/mcp/client.ts` |
| BYOK resolve | `lib/tenancy/resolveInference*.ts`, `lib/gateway/byokProviders.ts` |
| Chat turn | `lib/harnessChat.ts` |
| Session | `lib/sessionStore.ts`, `lib/sessionRepository.ts`, `lib/sessions/*` (incl. `blobStore.ts`/`blobStores.ts`), [session-model.md](session-model.md) |
| Zig UI | `native/harness/src/ui.zig` |
| Bridge Zig | `native/harness/src/bridge.zig` |
| Theme | `native/harness/src/palette.zig` ↔ `lib/palette.ts` |
| Export whitelist | `native/harness/build.zig` |

Host `HARNESS_PROTOCOL_VERSION` must equal Wasm `PROTOCOL_VERSION` (currently **12**).
Mismatch → load error; rebuild both sides. Image **bytes** enter only via bridge put; never dual DOM `<img>` product surface.

## Related

- Visitor front door: [README](../README.md)  
- Agent sandbox: [sandbox.md](sandbox.md)  
- Wasm supply / runner: [runner.md](runner.md)  
- Limits: [harness-limits.md](harness-limits.md)  
- Session restore: [session-model.md](session-model.md)  
- Agent SSE: [agent-stream.md](agent-stream.md)  
- Per-user MCP: [mcp.md](mcp.md)  
