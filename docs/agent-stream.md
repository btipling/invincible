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
| `tool_result` | `name`, `ok`, `summary` | System line (summary already formatted) |
| `reasoning_delta` | `text` (chunk) | Grow a **Thinking** bubble (protocol v8) |
| `text_delta` | `text` (chunk) | Grow Assistant bubble(s) |
| `done` | `text`, optional `toolTrace` | Finalize session; Ready |
| `error` | `error`, optional `status` | Error message; Ready |

Unknown types are ignored (forward-compatible). String fields are redacted server-side with the same secret list as JSON responses.

## Wasm bridge

Assistant and thinking growth use **protocol v8** `inv_update_last_message` so streaming does not create one ring message per token. Tool lines use System `pushMessage`. Thinking uses `MessageKind.Thinking` (muted warm chrome). No dual DOM transcript.

Thinking is **display-only** for the current turn (not folded into multi-turn history; not required in SessionStore).

## Reasoning / model config

| Control | Effect |
|---------|--------|
| Model id (harness picker / `AGENT_MODEL`) | Choose a reasoning-capable Gateway model when desired |
| `AGENT_REASONING` | Optional SDK effort: `provider-default` \| `none` \| `low` \| `medium` \| `high` |

When `AGENT_REASONING` is unset, the server enables `reasoning: provider-default` only if the model id looks reasoning-capable (`reasoning` / `thinking` in the id, but not `non-reasoning`). Other models omit the option.

## Caps

- Live tool System lines: **32** per turn, then one overflow notice  
- Summary line length: ≤ **240** characters  
- Thinking bubble length: ≤ **4096** characters (Wasm `MAX_MSG_LEN`)  
