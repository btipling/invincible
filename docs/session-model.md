# Session model

How browser session restore works for the harness (memory + `localStorage`).

## Constraints

- **No local filesystem** as source of truth for sessions/files  
- No secrets (`AI_GATEWAY_API_KEY`, tokens) inside session blobs  
- Client must not use Node `fs`

## What ships today

| Piece | Location | Notes |
|-------|----------|--------|
| `SessionStore` | `lib/sessionStore.ts` | sync `load` / `save` / `clear` |
| `MemorySessionStore` | same | tests / SSR fallback |
| `LocalStorageSessionStore` | same | default in browser via `createDefaultSessionStore()` |
| Agent loop | `lib/harnessChat.ts` `runHarnessTurn` | multi-turn via folded history |

Multi-turn continuity: history is folded into a single `POST /api/chat` (or
`/api/agent`) prompt (`formatPromptWithHistory`). The API remains single-shot
per request; multi-turn lives in the host session + Wasm transcript.

Blob shape (messages only — never env secrets):

```json
{
  "id": "sess_…",
  "updatedAt": 0,
  "messages": [{ "id": "m_…", "role": "user|assistant|system|error", "text": "…", "at": 0 }]
}
```

Wasm stays free of persistence I/O; the host loads/saves session and pushes
transcript via the bridge on load / Clear.

## Cloud backends (optional follow-ups)

| Approach | Fit | Notes |
|----------|-----|--------|
| Vercel KV / Redis / Postgres | Real multi-device | Add `HttpSessionStore` + `GET/PUT /api/session` |
| Object storage (S3/R2) | File/workspace blobs | Keys only in session row |
| GitHub repo as storage | “code harness” identity | OAuth + rate limits |

Recommended path if multi-device is needed later:

1. Keep sync `SessionStore` for local UX.  
2. Add async `SessionRepository` for network (don’t block first paint).  
3. `CloudSessionStore` → Vercel route with user auth; workspaces = session id + object keys, **not** local paths.

```text
Session
  id, owner?, updatedAt
  messages[]
  workspace?
    files: { path, contentHash, size }[]   # no full content in session row
    blobStore: object storage keys
```

## Product rule

If a feature needs “files on disk,” implement it as **workspace objects in cloud storage**, never as `fs` in the browser or on the Next server as a multi-tenant store.
