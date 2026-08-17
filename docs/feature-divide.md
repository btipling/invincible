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
| Site chrome | **DOM** | `AppNav` brand header (flat when idle; while the host `busy` flag is true — active harness agent turn — the wordmark keeps `teal.text` fill, a TEAL outline, a neon bloom (tight inner + soft outer halo), a slow sine pulse of the glow, and a visible TEAL mote wash; `prefers-reduced-motion: reduce` keeps a static outline+bloom and drops the sine and motes; settings/admin headers never glow); optional `AuthNavLinks` (server role-gates via `soleMembership`+`canAccessAdmin`; signed-in renders the shared client `NavMenu` hamburger dropdown holding Admin/Settings/Harness + the `LogoutButton` footer; unauth keeps an inline `Sign in` link; client holds no role gate logic) — **not** Playground tabs |
| Load `web.js` + `harness.wasm` | **DOM** | Instantiate, MIME, errors |
| JS ↔ Wasm bridge glue | **DOM** | `lib/harnessBridge.ts` |
| Poll pending submit | **DOM** | No custom Wasm imports beyond stock dvui `web.js` |
| `POST /api/chat` | **Vercel backend** | Single-shot inference; `AI_GATEWAY_API_KEY` never in Wasm |
| `POST /api/agent` | **Vercel backend** | Multi-step tools (sandbox + per-user MCP when configured); server-only secrets |
| Fold multi-turn history into prompt | **DOM** | `lib/harnessChat.ts` (user/assistant only; system tool lines display-only) |
| `SessionStore` load/save/clear | **DOM** | memory / localStorage (first paint) |
| Cloud session list/mint/pull/push/DELETE (`/api/sessions*`) | **DOM** host + **Vercel backend** | Redis multi-session (+ **phase 0 #515 envelope + Blob transcript**), server-minted ids; hybrid async; never blocks first paint; no dual chat. **Wasm never talks to Redis or Blob** — the DOM host drives the client→Blob upload + envelope upsert |
| Session ring window + Load earlier poll | **DOM** host + **Wasm** control | Host slices ≤**2048** (`HARNESS_RING_MAX`); **Load earlier** steps by **`HISTORY_PAGE` = 512**; Wasm pending (protocol v6); no React transcript |
| Thin status chips (model, lifecycle) | **Removed** (plan #567) | The DOM top-bar diagnostic chips (model · `h:{build}` · store-kind+loadMs badge · `ready`/`thinking`+clock) were removed — the canvas is the single source (model selector, build-id header, ready/busy). No DOM mirror, no second picker |
| Model catalog fetch (`GET /api/models`) | **DOM** | Session-gated; host pushes ids into Wasm catalog |
| **Workspace status bar** (sandbox · cwd · git · context) | **Wasm-primary** (two-line bottom status bar under the composer, protocol v13) | Product truth is in-canvas: a **two-line 64 px always-present full-width status bar directly below the composer** from bridge state (plan #555 → #554, header merged by plan #570). **Line 1** = identity (lifecycle · `h:{build-id}` · model menu), **line 2** = right-aligned status-slot pack (sandbox · cwd · git · context). The top header band is removed entirely. The **DOM host mirrors only** (never a competing status panel). Host folds session state — sandbox (`activeSandboxId`) + `cwd` — into the bridge status-slot store after hydrate/restore, after **every** agent turn (success **and** fail: a 403-clear or a committed `change_dir` on a cancelled/timed-out turn repaints the pack — PR #543; host-ellipsized to the byte cap before the wire), and **live mid-turn** (Phase 2 #627 / #625) on confirmed `change_dir` / successful `meta_sandbox_switch` tool results. The **git** slot (Phase 2 #540) is filled by the DOM host polling the read-only **`GET /api/harness/status`** server probe on a ~10 s cadence (`refreshGitStatusSlot`), plus on-demand mid-turn after a successful `exec` or `meta_sandbox_switch`; the server probes the bind workspace root with bounded argv-only read-only git (`statusProbe.ts`) and rate-limits per instance. The **context/usage** slot (Phase 3 #539) is **host-folded provider token usage** captured at the final completion (JSON result / stream `done` / chat result), painted absolute-tokens-only and **hidden by default** on missing usage — never a client estimate; abort/cancel keeps the prior honest value. Capture lives in the **Vercel backend** (`runAgent`/`agentStream`/`chatServer`-side `usageSummary.ts`); parsing + fold live in **DOM** (`agentApi.ts`, `chatApi.ts`, `harnessChat.ts` `foldStatusSlots`) |
| Model selection UI (status-bar menu) | **Wasm** | Status bar line 1; protocol v3 catalog + stock dvui dropdown menu (#617). The selected **model id** rides the session-carrier `meta.selectedModel` (DOM fold + backend reserved key — plan #616 / source #610): the DOM host folds the live Wasm selection into `SessionSnapshot.selectedModel` (folding a user menu pick or **Next** cycle via the additive **v16** `inv_has_pending_model_change` / `inv_ack_pending_model_change`, and at `runPrompt`), persists it via the reserved `meta.selectedModel`, and restores **by id** after the catalog push via the additive **v16** `inv_set_selected_model`. Restore-by-id never sets the pending flag; a revoked/absent stored id falls back to the default first-granted. The picker UI stays **Wasm**; submit still reads the live `getSelectedModel()` (no second POST-body truth) |
| Skill attach display (`Skill attached: <slug>`) | **Wasm** (display-only kind 7) + **Vercel** (resolve/inject) | Server resolves `/skill-name` + injects the body into system context (after the persona); the Wasm canvas shows only the skill NAME row (message kind 7, display-only) — never the body |
| Selected `modelId` on inference | **DOM host** → **Vercel backend** | Host reads the live Wasm bridge `getSelectedModel()` at submit (never a second source of truth); POST body; server re-authorizes grants + BYOK. The persisted `SessionSnapshot.selectedModel` / `meta.selectedModel` is a **restore + continuity** carrier only — it is applied to the Wasm selection by id at boot/adopt/switch so the next submit reads the same live value it would have after any reopen |
| Provider secrets / BYOK resolve | **Vercel backend** | DEK ciphertext; never Wasm/client |
| Per-user MCP config UI | **DOM** | `/settings`, `/settings/mcp` — not dual chat; not Admin |
| Per-user MCP tools (connect + execute) | **Vercel backend** | `lib/mcp/*`; keys under tenant DEK; never Wasm/client |
| Builtin HTTPS fetch (`http_get`) | **Vercel backend** | Always-available when a running HTTP instance exists; attach-only (Settings Create HTTP instance); see [builtin-http.md](builtin-http.md) |
| **Transcript (read messages)** | **Wasm** | Primary UX; rich MD + images + math + diff/patch fence paint in-canvas (`rich/*`) — no DOM markdown |
| Transcript left rail (empty, collapsible) | **Wasm** | Inside the transcript band only (canvas top → composer). Default closed: 40 px icon strip. Open: 220 px empty TEAL column. Session list stays DOM `SessionPicker` in AppNav until a later move. No host CSS sidebar, no protocol |
| Image bytes (fetch/decode) | **DOM host** | Browser fetch → RGBA → `inv_image_cache_put`; paint stays Wasm |
| Math pixels (TeX raster) | **DOM host** | Host MathJax SVG → RGBA → `inv_math_cache_put`; paint stays Wasm |
| **Composer + Send** | **Wasm** | Primary input; dynamic absolute-rect from previous-frame measured height: idle hugs one line (~44 px), grows up to cap (124 px), scrolls internally past 120 px content; glyphs inset 5 px from the field border; Send/Stop icon bottom-pinned (`gravity_y = 1.0`) stays on field baseline at all heights (plan #579) |
| **Stop / cancel turn** | **Wasm** control + **DOM** abort | Canvas **Stop** (icon-only ■, plan #457) while busy → pending cancel (protocol v9); host aborts `AbortController` |
| Busy / error presentation for turns | **Wasm** | EMBER for errors |
| Whole-turn `mm:ss` clock (Busy) | **Wasm** (busy row) fed by the **DOM** host | The host owns the only reliable wall-clock (no WASI clock in Wasm) and ticks it ~1 Hz, pushing the elapsed seconds into the Wasm busy row via protocol **v14** `inv_set_turn_elapsed` (plan #567). The canvas appends `Waiting for model… · 0:42` in-canvas while a turn runs; reset to 0 on Ready/Stop/error so no `0:00` lingers. Composer/Stop stay **Wasm** |
| 2×4 busy spinner (plan #574) | **Wasm paint** fed by the **DOM** host | **Wasm** paints a 2×4 WARM rectangle grid left of `Waiting for model…` (clockwise pulse; pure LUT `busy_spinner.zig`, zero I/O/alloc in the frame path). **DOM host** drives the pulse phase on the same Busy ticker at **`HARNESS_BUSY_TICK_HZ` = 10 Hz** (`HarnessBridge.setBusyTick` → additive `inv_set_busy_tick`; the v14 `mm:ss` clock is fed every 10th tick ≈ 1 Hz). **Reduced motion** (read fresh at each busy start): the host skips only the per-tick pulse push, grid static at phase 0 — the `mm:ss` **clock keeps ticking** (no reduced-motion clock regression). Idle/Stop/error clears both to 0. Old host + new Wasm degrades to a static grid (busy_tick stays 0) |
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
User picks a model in the Wasm status bar — model selection truth stays in-canvas
(optional) User configures personal MCP on /settings/mcp (keys → tenant DEK ciphertext)
User types in Wasm composer
  → inv_* pending submit (poll)
  → Host runHarnessTurn / SessionStore
  → formatPromptWithHistory (user/assistant only)
  → POST /api/agent { prompt, modelId? } with Accept: text/event-stream (default host)
       server requires the session user: request-scoped BYOK for the authorized modelId
       tools → sandbox (DB grants + Settings Workspace attach)
              + optional builtin http_get (attach-only durable HTTPS instance)
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
| Bridge TS (protocol **v16**) | `lib/harnessBridge.ts` |
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

Host `HARNESS_PROTOCOL_VERSION` must equal Wasm `PROTOCOL_VERSION` (currently **16** — 13 added the additive status-slot store; 14 the scalar turn-clock feed `inv_set_turn_elapsed`; 15 added the busy-tick `inv_set_busy_tick`; **16** (plan #616) adds model-selection persistence `inv_set_selected_model` + `inv_has_pending_model_change` / `inv_ack_pending_model_change`).
Mismatch → load error; rebuild both sides. Image **bytes** enter only via bridge put; never dual DOM `<img>` product surface.

## Related

- Visitor front door: [README](../README.md)  
- Agent sandbox: [sandbox.md](sandbox.md)  
- Wasm supply / runner: [runner.md](runner.md)  
- Limits: [harness-limits.md](harness-limits.md)  
- Session restore: [session-model.md](session-model.md)  
- Agent SSE: [agent-stream.md](agent-stream.md)  
- Per-user MCP: [mcp.md](mcp.md)  
