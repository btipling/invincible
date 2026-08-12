# Agent stream (SSE)

`POST /api/agent` can return a **Server-Sent Events** body when the client asks for it.
Default remains a single JSON `{ text, toolTrace?, cwd? }` response for tests and simple clients.

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

**Omitted / null `cwd`:** server uses `SANDBOX_DEFAULT_CWD` when set and valid, else `"."`.  
**Present but invalid** (host-absolute, control chars, non-string): **400** JSON error — not a stream.  
**Response `cwd`:** included on JSON success and SSE `done` only when FS tools ran this turn; always a normalized workspace-relative path. Host session should update stored cwd **only on success** (never on abort/error).

## Events

Each SSE block is one `data: <json>\n\n` line:

| `type` | Fields | Host use |
|--------|--------|----------|
| `tool_start` | `name`, optional `id` | Aggregate into one display-only `tool_run` message (protocol v10 / kind 6) |
| `tool_result` | `name`, `ok`, `summary`, optional `preview` | Aggregate into the same `tool_run` group; paints an interactive N-tools card. `preview` is a bounded, redacted level-2 detail body (`TOOL_RUN_PREVIEW_MAX_CHARS` = 100k, head+tail `… (N more lines)`) built from flattened+redacted tool output — **not** raw MCP envelopes |
| `reasoning_delta` | `text` (chunk) | Grow a **Thinking** bubble (protocol v8) |
| `text_delta` | `text` (chunk) | Grow Assistant bubble(s) |
| `done` | `text`, optional `toolTrace`, optional `cwd` | Collapse open thinking; finalize session; apply `cwd` on success only; Ready |
| `error` | `error`, optional `status` | Collapse open thinking; Error message; Ready |

Unknown types are ignored (forward-compatible). String fields are redacted server-side with the same secret list as JSON responses.

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

Assistant and thinking growth use **protocol v8** `inv_update_last_message` so streaming does not create one ring message per token. Each **uninterrupted** tool streak is aggregated by the host into ONE `tool_run` message (protocol v10 / bridge **kind 6**) that the Wasm paints as a default-collapsed expandable control — **not** System lines. Reasoning between tools flushes the open streak to its own group (see [harness-limits.md](harness-limits.md)). Thinking uses `MessageKind.Thinking` (muted warm chrome + **same GFM paint** as assistant). No dual DOM transcript. In-place stream growth relies on harness stick-to-bottom (content height) so the viewport follows when the user is near the bottom — not on new SSE event types.

### Thinking collapse

While a Thinking segment is **open**, the host grows the full monologue (≤ Wasm `MAX_MSG_LEN`, currently **256 KiB**). While the harness is **Busy**, every thinking row that belongs to the current turn stays **fully visible** (including the live streaming one and any segments the turn has already closed). Once the **turn completes** (`done`, `error`, or cancel → Ready/err), every **committed** thinking row from completed turns **auto-collapses** to a compact expandable control: a `Thinking` expander + a one-click re-expand to the full markdown monologue (muted one-line preview while collapsed, Copy on the header). This collapses accumulated reasoning so scrolled-away thinking stops being laid out and repainted every frame (composing with the O(dirty) slot-keyed parse + `cache_layout` paint for the rich transcript). Expand state is **in-memory only** — thinking is ephemeral and never survives refresh. There is **no** per-turn thinking-segment or live-tool line product cap — use **Stop** to cancel.

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
| `tool_run` (live tools, protocol v10) | **Yes** (live path) | **Not folded** (display-only, plan #345) — continue may re-run tools |
| Error | **Yes** | Included as `Error:` (stall/cancel context) |
| Thinking | **No** (display-only) | Never |

## Reasoning / model config

| Control | Effect |
|---------|--------|
| Model id (harness picker) | Choose a reasoning-capable granted model when desired |
| `AGENT_REASONING` | Optional SDK effort: `provider-default` \| `none` \| `low` \| `medium` \| `high` |

When `AGENT_REASONING` is unset, the server enables `reasoning: provider-default` only if the model id looks reasoning-capable (`reasoning` / `thinking` in the id, but not `non-reasoning`). Other models omit the option.

## End of turn

Every harness turn paints a final line:

| Outcome | Line |
|---------|------|
| Model finished | `Turn ended · model finished` (System) |
| User Stop | `Turn ended · you stopped` (System) |
| Error / timeout / empty | `Turn ended · error · …` / timed out / empty (Error) |
| Chat fallback | `Turn ended · chat finished` (System) |

These markers are **not** folded as tools into the next prompt.

## Caps

Product philosophy: **no live-tool / thinking-segment UX walls** — cancel with **Stop**.

| Cap | Value | Behavior |
|-----|------:|----------|
| Live `tool_run` groups | **one per uninterrupted streak** | Reasoning or assistant text flushes the open streak to its own group |
| Thinking **segments** | **none** | Every reasoning segment paints |
| Thinking / line chars | **256 KiB** | Wasm `MAX_MSG_LEN` only (bridge hard edge) |
| Ring slots | **2048** | Wasm `MAX_MSG`; older drop when full; Load earlier for SessionStore |
| Tool summary length | **salient ≤160** | `salientToolBits` — path/counts/status only; **not** full read_file/exec/http bodies |
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
| streamText + reasoning option | `lib/agent/runAgent.ts`, `lib/agent/reasoningConfig.ts` |
| Route SSE vs JSON | `app/api/agent/route.ts` |
| Logical cwd parse / default env | `lib/agent/agentBody.ts`, `lib/sandbox/config.ts` (`SANDBOX_DEFAULT_CWD`), `lib/agent/workPath.ts` |
| Host consumer + collapse/caps | `lib/harnessChat.ts`, `lib/agentApi.ts` |
| Thinking paint | `native/harness/src/ui.zig` (protocol v8 kind) |
| Feature divide | [feature-divide.md](feature-divide.md) |
