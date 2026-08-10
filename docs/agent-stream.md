# Agent stream (SSE)

`POST /api/agent` can return a **Server-Sent Events** body when the client asks for it.
Default remains a single JSON `{ text, toolTrace?, cwd? }` response for tests and simple clients.

## Negotiation

| Client | Server |
|--------|--------|
| Header `Accept: text/event-stream` | `Content-Type: text/event-stream; charset=utf-8` + SSE events |
| Other / missing Accept | JSON `{ text, toolTrace?, cwd? }` or `{ error }` |

Early failures (auth, missing sandbox, bad body, BYOK) always use **JSON** status responses — even if Accept requested a stream. Host stream clients must parse JSON errors (including the exact sandbox-not-configured **503** string for chat fallback).

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
| `tool_result` | `name`, `ok`, `summary` | Aggregate into the same `tool_run` group; paints an interactive N-tools card |
| `reasoning_delta` | `text` (chunk) | Grow a **Thinking** bubble (protocol v8) |
| `text_delta` | `text` (chunk) | Grow Assistant bubble(s) |
| `done` | `text`, optional `toolTrace`, optional `cwd` | Collapse open thinking; finalize session; apply `cwd` on success only; Ready |
| `error` | `error`, optional `status` | Collapse open thinking; Error message; Ready |

Unknown types are ignored (forward-compatible). String fields are redacted server-side with the same secret list as JSON responses.

## Wasm bridge

Assistant and thinking growth use **protocol v8** `inv_update_last_message` so streaming does not create one ring message per token. Each **uninterrupted** tool streak is aggregated by the host into ONE `tool_run` message (protocol v10 / bridge **kind 6**) that the Wasm paints as a default-collapsed expandable control — **not** System lines. Reasoning between tools flushes the open streak to its own group (see [harness-limits.md](harness-limits.md)). Thinking uses `MessageKind.Thinking` (muted warm chrome + **same GFM paint** as assistant). No dual DOM transcript. In-place stream growth relies on harness stick-to-bottom (content height) so the viewport follows when the user is near the bottom — not on new SSE event types.

### Thinking collapse

While a Thinking segment is **open**, the host grows the full monologue (≤ Wasm `MAX_MSG_LEN`, currently 64 KiB). When the segment **closes** (tool line, assistant text, `done`, or `error`), the monologue **stays fully visible** (no one-liner collapse). Multi-step turns may leave several Thinking rows in the ring. There is **no** per-turn thinking-segment or live-tool line product cap — use **Stop** to cancel.

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
| Model id (harness picker / `AGENT_MODEL`) | Choose a reasoning-capable Gateway model when desired |
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
| JSON end-of-turn toolTrace lines | **none** | All entries shown |

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
