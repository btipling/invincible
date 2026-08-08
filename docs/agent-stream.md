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
| `text_delta` | `text` (chunk) | Grow a single Assistant bubble |
| `done` | `text`, optional `toolTrace` | Finalize session; Ready |
| `error` | `error`, optional `status` | Error message; Ready |

Unknown types are ignored (forward-compatible). String fields are redacted server-side with the same secret list as JSON responses.

## Wasm bridge

Assistant growth uses **protocol v7** `inv_update_last_message` so streaming does not create one ring message per token. Tool lines use ordinary System `pushMessage`. No dual DOM transcript.

## Caps

- Live tool System lines: **32** per turn, then one overflow notice  
- Summary line length: ≤ **240** characters  
