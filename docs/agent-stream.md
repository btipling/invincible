# Agent stream (SSE)

`POST /api/agent` can return a **Server-Sent Events** body when the client asks for it.
Default remains a single JSON `{ text, toolTrace?, cwd? }` response for tests and simple clients.

`POST /api/turns` (production durable-turn path) uses the **same** event types as `/api/agent`. Tokens ride the Workflows durable stream (`getWritable`). Stream **write and close must run on a `'use step'` stack** — a `'use workflow'` function cannot call `getWriter` / `write` / `close`. The writer helpers (`lib/workflows/turnSseWrite.ts`) are **directive-free** and must not carry `'use step'` (nested-step ban). Live model-step writes hold **one** Workflows writer for the round (`withDefaultStreamWriter` around `generateOneRound` in `modelGenerateStep`) — do **not** call `getWritable()` per token. Loop-owned lines (`tool_result` / `done` / `error`) stay one write per `writeTurnSse` step.

## Negotiation

| Client | Server |
|--------|--------|
| Header `Accept: text/event-stream` | `Content-Type: text/event-stream; charset=utf-8` + SSE events |
| Other / missing Accept | JSON `{ text, toolTrace?, cwd? }` or `{ error }` |

Early failures (auth, grants, bad body, BYOK) always use **JSON** status responses — even if Accept requested a stream. Typical statuses are **401** (unauthenticated), **403** (no usable sandbox grant and no alternate tools / denied), and other **4xx** for bad body or bad data. There is **no** sandbox-not-configured **503** → chat fallback; host stream clients must parse the JSON error and must **not** special-case a chat-fallback string (the route never emits it).

Response hints: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.


## Request body (cwd)

| Field | Required | Notes |
|-------|----------|--------|
| `prompt` | yes | Same limits as chat |
| `modelId` | no | Gateway model id |
| `cwd` | no | Logical **workspace-root-relative** directory for this turn |

**Omitted / null `cwd`:** server uses `"."` (workspace-root default); there is no `SANDBOX_DEFAULT_CWD` env knob.  
**Present but invalid** (host-absolute, control chars, non-string): **400** JSON error — not a stream.  
**Response `cwd`:** included on JSON success and SSE `done` only when FS tools ran this turn; always a normalized workspace-relative path. Host session should update stored cwd **only on success** (never on abort/error).  
**Response `usage` (Phase 3 #539 + #628):** a bounded, **provider-sourced** token summary `{ source: "provider", prompt?, completion?, total?, cached? }`. Emitted as a **live `usage` SSE event** mid-stream when the AI SDK reports **aggregate** usage on a `finish` stream part (`totalUsage`, or v7 `usage`), and again on the SSE `done` event / JSON result as the **conclusive reconcile**. `finish-step` is **never** a source — its per-step counts are not a turn total. Absent (no event emitted) when a finish part reports no usable token counts, and on abort/cancel (no completion). The host folds the context slot immediately on the live event; `done.usage` is the final reconcile. Default on missing usage is **hidden** — never client token math. Serialized carrier capped at `USAGE_SUMMARY_MAX_BYTES` (96 B); an oversized carrier is omitted, never a broken turn.

## Events

Each SSE block is one `data: <json>\n\n` line:

| `type` | Fields | Host use |
|--------|--------|----------|
| `tool_start` | `name`, optional `id` | **Live-paint** one display-only `tool_run` card (protocol v11 / kind 6) on this event |
| `tool_result` | `name`, `ok`, `summary`, optional `preview`, optional `changeDirCwd`, optional `activeSandboxId` | **Grow the open `tool_run` card in place** (total increments) while the last ring row is a tool-run; else open a NEW card at `1`. `preview` is a bounded, redacted level-2 detail body (`TOOL_RUN_PREVIEW_MAX_CHARS` = 100k, head+tail `… (N more lines)`) built from flattened+redacted tool output — **not** raw MCP envelopes. `changeDirCwd` is the confirmed workspace-relative cwd from a successful `change_dir` (typed field from the raw result — never the truncated summary). `activeSandboxId` is the switched-to sandbox id from a successful `meta_sandbox_switch` (Phase 2 #627 / #625) — the host applies it live mid-turn |
| `reasoning_delta` | `text` (chunk) | Grow a **Thinking** bubble (protocol v8) |
| `text_delta` | `text` (chunk) | Grow Assistant bubble(s) |
| `usage` | `usage` | **Live mid-stream** provider token summary from a `finish` part (aggregate only). `finish-step` never emits this. The host folds the context slot immediately; `done.usage` is the final reconcile. Absent when the part carried no usable counts — never a clear/flicker |
| `done` | `text`, optional `finishReason`, optional `toolTrace`, optional `cwd`, optional `usage` | Collapse open thinking; finalize session; apply `cwd` on success only; fold bounded provider `usage` (Phase 3 #628 — `done.usage` is the conclusive reconcile). **`finishReason: length` / `content-filter` / `error` is not model-finished** — the durable loop sends SSE `error` (`output truncated`) instead, and the host treats a truncated `done` the same way. Real chat end is `stop` or omitted. |
| `error` | `error`, optional `status` | Collapse open thinking; a host **retryable** failure retries the same turn up to 5 attempts (**1 attempt** if any ring row has already been painted mid-stream — re-painting would duplicate tools/bubbles) before give-up; give-up paints the Error message and the turn lands on **Error** — never consuming the operator queue |

Unknown types are ignored (forward-compatible). String fields are redacted server-side with the same secret list as JSON responses.

On the production durable path (`POST /api/turns`), `reasoning_delta` / `text_delta` / `tool_start` token-stream from inside the model step as provider parts arrive, on **one** held Workflows writer for that round. `tool_result` / `done` stay loop-owned after tool/persist steps (one `writeTurnSse` per line). Legacy `/api/agent` token-streams those same event types as they arrive from the provider.

### Level-2 preview (`tool_result.preview`)

The stream `tool_result` event carries an **optional** `preview` field: a bounded,
redacted level-2 detail body for the harness expander (phase 3 #353). It is built
from the already **flattened + redacted** tool output (never a raw MCP JSON
envelope), keeps the **real** first **40** / last **10** lines of the full output
joined by `… (M more lines)` — head/tail are taken **before** the char cap, so
the L2 "tail" is genuinely the end-of-output — and is capped at
`TOOL_RUN_PREVIEW_MAX_CHARS` (100k) per tool. Short single-line results omit
`preview`, so the host paints a static label instead of a duplicate-of-L1 blank
expander. The host feeds `preview` into the level-2 `detail` of the aggregated
`tool_run` message; because a whole `tool_run` row encodes into ONE message, a
group-level encode budget + a hard clamp to the 262 144-byte/msg cap keep a
multi-preview streak from overflowing it (never a silent mid-payload clip).

**JSON fallback** (`Accept` other than `text/event-stream`) keeps a **one-line
level-2 detail from `summary`** — documented parity for the tests/simple-clients
path, not silently diverging from the stream.

## Wasm bridge

Assistant and thinking growth use **protocol v8** `inv_update_last_message` so streaming does not create one ring message per token. Each **uninterrupted** tool streak is aggregated by the host into ONE `tool_run` message (protocol **v11** / bridge **kind 6**) that the Wasm paints as a default-collapsed expandable control — **not** System lines. The tool card is **painted live**: each `tool_start`/`tool_result` opens (or grows) that ONE kind-6 row immediately — `1 tool called` → `2…` — via `update_last`, growing iff the last ring row is a tool-run; otherwise a **new** card at `1`. A **thinking row that lands last** (and any assistant/user/error row) is a physical separator and opens a fresh card (see [harness-limits.md](harness-limits.md) — commit-once is removed). Thinking uses `MessageKind.Thinking` (muted warm chrome + **same GFM paint** as assistant). No dual DOM transcript. In-place stream growth relies on harness stick-to-bottom (content height) so the viewport follows when the user is near the bottom — not on new SSE event types.

### Thinking collapse

While a Thinking segment is **open**, the host grows the full monologue (≤ Wasm `MAX_MSG_LEN`, currently **256 KiB**). While the harness is **Busy**, every thinking row that belongs to the current turn stays **fully visible** (including the live streaming one and any segments the turn has already closed) **only while the thinking default-collapsed preference is OFF** — when it is ON (the default, Leader then **`t`**), the Busy turn's thinking **also starts collapsed** unless the operator re-expands a row (which still works mid-Busy). Once the **turn completes** (`done`, `error`, or cancel → Ready/err), every **committed** thinking row from completed turns **auto-collapses** to a compact expandable control: a `Thinking` expander + a one-click re-expand to the full markdown monologue (muted one-line preview while collapsed, Copy on the header). This collapses accumulated reasoning so scrolled-away thinking stops being laid out and repainted every frame (composing with the O(dirty) slot-keyed parse + `cache_layout` paint for the rich transcript). Expand state and the preference are **in-memory only** — thinking and the preference are ephemeral and never survive refresh; a New/Clear/session switch returns the preference to ON. There is **no** per-turn thinking-segment or live-tool line product cap — use **Stop** to cancel.

### User cancel (Stop)

While a turn is **busy**, the harness shows **Stop**. That sets a protocol **v9**
pending cancel; the host polls it, aborts the in-flight `fetch` (`AbortSignal`),
and the existing cancel path surfaces `Request cancelled.` (no new SSE event type,
no chat fallback). Stopping before the host starts the turn discards a pending
submit so no ghost request is sent.

### Session save

| Kind | SessionStore | History fold |
|------|--------------|--------------|
| User / Assistant | **Yes** | Included |
| `tool_run` (live tools, protocol v11) | **Yes** (live-paint path: open card appended / grown in place) | **Not folded** (display-only, plan #345) — continue may re-run tools |
| Error | **Yes** | Included as `Error:` (stall/cancel context) |
| Thinking | **No** (display-only) | Never |

## Reasoning / model config

| Control | Effect |
|---------|--------|
| Model id (harness picker) | Choose a reasoning-capable granted model when desired |
| `AGENT_REASONING` | Optional SDK effort: `provider-default` \| `none` \| `low` \| `medium` \| `high` |

When `AGENT_REASONING` is unset, the server enables `reasoning: provider-default` only if the model id looks reasoning-capable (`reasoning` / `thinking` in the id, but not `non-reasoning`). Other models omit the option.

## End of turn

Most harness turns paint a final line. **Detach does not** — losing the live reader (leave-site abort, or durable `/api/turns` body EOF without a producer `done` / `error`) is not “the turn ended.”

| Outcome | Line |
|---------|------|
| Model finished (SSE `done` with `stop`, omitted, or any non-truncated `finishReason`) | `Turn ended · model finished` (System) |
| Output truncated (provider `finishReason: length` / `content-filter` / `error`, or SSE `error` `output truncated`) | `Turn ended · error · output truncated` (Error). Partial assistant text stays. Envelope is terminal `completed` so refresh does not attach a dead run. |
| Step budget exhausted (256 workflow steps) | `Turn ended · error · step budget exhausted` (Error). Same envelope rule. |
| User Stop | `Turn ended · you stopped` (System) |
| Detach (leave-site abort, or durable reader-drop without `done`/`error` after the run id is folded) | **No** turn-end line. Session keeps `turnRunId` + `turnStatus: 'running'`. Lifecycle Ready. The workflow is not cancelled. |
| Error / timeout / empty | `Turn ended · error · …` / timed out / empty (Error). A retryable error retries the **same** turn up to **5 attempts** with bounded backoff before give-up (**1 attempt once a ring row has been painted mid-stream**, and **1 attempt once a durable `/api/turns` run has started** — another POST would start a second workflow); on give-up the host sets the turn lifecycle to **Error** (so a queued head is never drained) and, if the operator queue is non-empty, inserts `Continue the current turn` as the new head. Permanent failures (the `PERMANENT_TURN_STATUS` whitelist — 400/401/403/404/413/422) give up after a single attempt; **408/429/5xx and timeout/empty stay retryable before durable start** (retry the same turn up to 5 attempts). After durable SSE start, empty/EOF without `done`/`error` is **detach**, not empty-complete and not a retry. |
| Standalone chat (`/api/chat`) | `Turn ended · chat finished` (System) — kept helper only; a failed agent turn does **not** fall back here |

These markers are **not** folded as tools into the next prompt.

There is **no in-repo output-token cap**. `finishReason: length` is the **provider** default max completion (not a product `maxOutputTokens`). Folding that as “the model finished” is a lie.

## Turn-end logs (Workflows)

Durable `'use step'` bodies `console.log` one JSON line each. These show on **Observability → Workflows** for that run — **not** HTTP Runtime Logs (`/api/harness/status` is the only HTTP probe on that surface).

| `tag` | When | Fields (allowlisted; never prompt/system/tool args/bodies) |
|-------|------|--------|
| `invincible.turn.model` | each model round (success or `{ok:false}`) | `ok`, `finishReason?`, `toolCallCount?`, `textChars?`, `code?` |
| `invincible.turn.persist` | each persist (terminal or mid-turn) | `ok`, `terminal`, `status?`, `turnRunId?`, `code?` |

A truncated round logs `finishReason: "length"` on the model line, then a terminal persist, then SSE `error`. A natural chat end logs `finishReason: "stop"` (or omits it) and SSE `done`.

## Caps

Product philosophy: **no live-tool / thinking-segment UX walls** — cancel with **Stop**.

| Cap | Value | Behavior |
|-----|------:|----------|
| Live `tool_run` groups | **one per uninterrupted streak** (painted live, grows per event) | Consecutive tools paint ONE growing card; a thinking/assistant/user/error row that lands last opens a NEW card |
| Thinking **segments** | **none** | Every reasoning segment paints |
| Thinking / line chars | **256 KiB** | Wasm `MAX_MSG_LEN` only (bridge hard edge) |
| Ring slots | **2048** | Wasm `MAX_MSG`; older drop when full; Load earlier for SessionStore |
| Tool summary length | **salient ≤320** | `salientToolBits` — path/counts/status only; **not** full read_file/exec/http bodies. `read_file` status lines include `offset` / `limit` / `lines=returned/total`; L1 salient stays `path · N lines · M B`. `sandbox_info` salient is backend · cwd · env-count (or `unavailable`) — **not** the env dump |
| Tool level-2 `preview` | **≤ 100k per tool** (`TOOL_RUN_PREVIEW_MAX_CHARS`), real head 40 / tail 10 lines + `… (M more lines)` | Bounded + redacted server-side; short single-line results omit it (static label). Whole-group encoded-detail budget + hard clamp keep any multi-preview `tool_run` row ≤ 262 144 B/msg |
| `tool_run` group payload | **≤ 262 144 B** (`TOOL_RUN_MSG_HARD_MAX`) | Host clips/omits memorized previews (explicit `…` or static label) rather than overflowing the ring/cloud per-msg cap |
| JSON end-of-turn toolTrace lines | **none** | All entries shown; level-2 detail stays the one-line `summary` (parity) |

## Deferred (not in stream contract yet)

- `step` events / step status strip  
- `POST /api/chat` SSE (agent stream is the product path)

## Where to change

| Concern | Path |
|---------|------|
| Event map / tool summary | `lib/agent/agentStream.ts` |
| streamText + reasoning option (production `/api/turns`) | `lib/agent/generateOneRound.ts`, `lib/agent/reasoningConfig.ts` |
| streamText + reasoning option (legacy `/api/agent`) | `lib/agent/runAgent.ts`, `lib/agent/reasoningConfig.ts` |
| Route SSE vs JSON | `app/api/agent/route.ts` |
| Logical cwd parse / default | `lib/agent/agentBody.ts`, `lib/sandbox/config.ts`, `lib/agent/workPath.ts` |
| Host consumer + collapse/caps | `lib/harnessChat.ts`, `lib/agentApi.ts` |
| Truncated / capped fold | `lib/agent/modelFinish.ts`, `lib/workflows/turnLoop.ts` (empty tools + truncated `finishReason` → SSE `error`, not `done`; 256-step cap same) |
| Workflows step logs | `lib/workflows/turnLog.ts`, `lib/workflows/modelGenerateStep.ts`, `lib/workflows/persistStep.ts` |
| Thinking paint | `native/harness/src/ui/thinking.zig` (protocol v8 kind) |
| Feature divide | [feature-divide.md](feature-divide.md) |
