# Agent stream (SSE)

`POST /api/agent` can return a **Server-Sent Events** body when the client asks for it.
Default remains a single JSON `{ text, toolTrace? }` response for tests and simple clients.

## Negotiation

| Client | Server |
|--------|--------|
| Header `Accept: text/event-stream` | `Content-Type: text/event-stream; charset=utf-8` + SSE events |
| Other / missing Accept | JSON `{ text, toolTrace? }` or `{ error }` |

Early failures (auth, missing sandbox, bad body, BYOK) always use **JSON** status responses — even if Accept requested a stream. Host stream clients must parse JSON errors (including the exact sandbox-not-configured **503** string for chat fallback).

Response hints: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.

## Events

Each SSE block is one `data: <json>\n\n` line:

| `type` | Fields | Host use |
|--------|--------|----------|
| `tool_start` | `name`, optional `id` | System line `{name} · running…` |
| `tool_result` | `name`, `ok`, `summary` | System line (summary already formatted; `✓ ok` / `✗ failed`) |
| `reasoning_delta` | `text` (chunk) | Grow a **Thinking** bubble (protocol v8) |
| `text_delta` | `text` (chunk) | Grow Assistant bubble(s) |
| `done` | `text`, optional `toolTrace` | Collapse open thinking; finalize session; Ready |
| `error` | `error`, optional `status` | Collapse open thinking; Error message; Ready |

Unknown types are ignored (forward-compatible). String fields are redacted server-side with the same secret list as JSON responses.

## Wasm bridge

Assistant and thinking growth use **protocol v8** `inv_update_last_message` so streaming does not create one ring message per token. Tool lines use System `pushMessage`. Thinking uses `MessageKind.Thinking` (muted warm chrome). No dual DOM transcript. In-place stream growth relies on harness stick-to-bottom (content height) so the viewport follows when the user is near the bottom — not on new SSE event types.

### Thinking collapse

While a Thinking segment is **open**, the host grows the full monologue (≤4096). When the segment **closes** (tool line, assistant text, `done`, or `error`), the host rewrites the last Thinking row to a **collapsed** one-liner (≤160 chars + ellipsis) via `updateLastMessage`. After the stream promise settles, the host also collapses any still-open segment (abort / network drop without a terminal SSE event). Multi-step turns may leave several short Thinking rows in the ring.

### User cancel (Stop)

While a turn is **busy**, the harness shows **Stop**. That sets a protocol **v9**
pending cancel; the host polls it, aborts the in-flight `fetch` (`AbortSignal`),
and the existing cancel path surfaces `Request cancelled.` (no new SSE event type,
no chat fallback). Stopping before the host starts the turn discards a pending
submit so no ghost request is sent.

### Session save

| Kind | SessionStore | History fold |
|------|--------------|--------------|
| User / Assistant | **Yes** | user + assistant only |
| System (live tools) | **Yes** (live path) | **Excluded** from next-turn fold |
| Thinking | **No** (display-only) | Never |

## Reasoning / model config

| Control | Effect |
|---------|--------|
| Model id (harness picker / `AGENT_MODEL`) | Choose a reasoning-capable Gateway model when desired |
| `AGENT_REASONING` | Optional SDK effort: `provider-default` \| `none` \| `low` \| `medium` \| `high` |

When `AGENT_REASONING` is unset, the server enables `reasoning: provider-default` only if the model id looks reasoning-capable (`reasoning` / `thinking` in the id, but not `non-reasoning`). Other models omit the option.

## Caps

| Cap | Value | Behavior |
|-----|------:|----------|
| Live tool System lines | **128** / turn | Then one `+ more tools (live cap 128)` notice |
| Thinking **segments** | **32** / turn | Then one `+ more thinking (live cap 32)`; further monologue ignored |
| Thinking chars (live segment) | **4096** | Wasm `MAX_MSG_LEN` |
| Collapsed thinking | **≤160** + ellipsis | After segment close |
| Tool summary length | **≤240** | `summarizeToolLine` / toolTrace |
| JSON end-of-turn toolTrace lines | **128** | Non-stream / finalize path only |

## Deferred (not in stream contract yet)

- `step` events / step status strip  
- `POST /api/chat` SSE (agent stream is the product path)

## Where to change

| Concern | Path |
|---------|------|
| Event map / tool summary | `lib/agent/agentStream.ts` |
| streamText + reasoning option | `lib/agent/runAgent.ts`, `lib/agent/reasoningConfig.ts` |
| Route SSE vs JSON | `app/api/agent/route.ts` |
| Host consumer + collapse/caps | `lib/harnessChat.ts`, `lib/agentApi.ts` |
| Thinking paint | `native/harness/src/ui.zig` (protocol v8 kind) |
| Feature divide | [feature-divide.md](feature-divide.md) |
