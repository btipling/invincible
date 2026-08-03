# Session model (Phase 3.8 sketch + 3.9 memory)

**Status:** MVP interface landed; full cloud backend deferred.

## Constraint

- **No local filesystem** as source of truth for sessions/files  
- No secrets (`AI_GATEWAY_API_KEY`, tokens) inside session blobs  
- Client must not use Node `fs`

## MVP (now)

| Piece | Location |
|-------|----------|
| `SessionStore` interface | [`lib/sessionStore.ts`](../lib/sessionStore.ts) |
| `MemorySessionStore` | tests / SSR fallback |
| `LocalStorageSessionStore` | browser UX (optional persistence across refresh) |
| Agent loop | [`lib/harnessChat.ts`](../lib/harnessChat.ts) `runHarnessTurn` + `/harness` DOM panel |

Multi-turn continuity: history is folded into a single `POST /api/chat` prompt (`formatPromptWithHistory`). The API remains Phase 1 single-shot.

## Later (cloud)

| Approach | Fit |
|----------|-----|
| Vercel KV / Redis / Postgres | Real multi-device sessions |
| Object storage (S3/R2) | File/workspace blobs for agent tools |
| GitHub repo as storage | “code harness” identity; needs OAuth + rate limits |

Recommended path: keep `SessionStore`, add `CloudSessionStore` that talks to a Vercel route (`/api/session`) with user auth later. Workspaces = session id + object keys, not local paths.

## Files / workspaces (future)

```text
Session
  id, owner, updatedAt
  messages[]
  workspace?
    files: { path, contentHash, size }[]   # no full content in session row
    blobStore: object storage keys
```

Wasm stays free of persistence I/O; host loads/saves session and pushes transcript via bridge.
