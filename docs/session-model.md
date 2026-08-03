# Session model (Phase 3.8)

**Status:** Acceptance met for Phase 3. Cloud backends are optional follow-ups.

## Constraint

- **No local filesystem** as source of truth for sessions/files  
- No secrets (`AI_GATEWAY_API_KEY`, tokens) inside session blobs  
- Client must not use Node `fs`

## Acceptance

| Requirement | Status |
|-------------|--------|
| `SessionStore` interface + one implementation | **Done** — interface + `MemorySessionStore` + `LocalStorageSessionStore` in [`lib/sessionStore.ts`](../lib/sessionStore.ts) |
| Design note: files/workspaces later | **This doc** |
| No Node `fs` in client; no secrets in blobs | **Done** — browser storage / memory only; Gateway key stays on server |

## Implementations (now)

| Piece | Location | Notes |
|-------|----------|--------|
| `SessionStore` | `lib/sessionStore.ts` | sync `load` / `save` / `clear` |
| `MemorySessionStore` | same | tests / SSR fallback |
| `LocalStorageSessionStore` | same | default in browser via `createDefaultSessionStore()` |
| Agent loop | `lib/harnessChat.ts` `runHarnessTurn` | multi-turn via folded history |

Multi-turn continuity: history is folded into a single `POST /api/chat` prompt (`formatPromptWithHistory`). The API remains Phase 1 single-shot.

Blob shape (messages only — never env secrets):

```json
{
  "id": "sess_…",
  "updatedAt": 0,
  "messages": [{ "id": "m_…", "role": "user|assistant|system|error", "text": "…", "at": 0 }]
}
```

## Cloud backends (later — not required for Phase 3 close)

| Approach | Fit | Notes |
|----------|-----|--------|
| Vercel KV / Redis / Postgres | Real multi-device | Add `HttpSessionStore` + `GET/PUT /api/session` |
| Object storage (S3/R2) | File/workspace blobs | Keys only in session row |
| GitHub repo as storage | “code harness” identity | OAuth + rate limits |

Recommended path:

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

Wasm stays free of persistence I/O; host loads/saves session and pushes transcript via bridge.

## Product rule

If a feature needs “files on disk,” implement it as **workspace objects in cloud storage**, never as `fs` in the browser or on the Next server as a multi-tenant store.
