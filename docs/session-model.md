# Session model

How harness continuity works: **local-first** browser restore plus
**cloud multi-device** sync when the user is signed in (auth always required).

## Constraints

- **No local filesystem** as source of truth for sessions/files
- No secrets (`AI_GATEWAY_API_KEY`, sandbox tokens, MCP keys, PATs) inside session blobs
- Client must not use Node `fs`
- Persistence I/O stays on the **DOM host** — Wasm never talks to storage or `/api/session`

## Local session (always)

| Piece | Location | Notes |
|-------|----------|--------|
| `SessionStore` | `lib/sessionStore.ts` | sync `load` / `save` / `clear` |
| `MemorySessionStore` | same | tests / SSR fallback |
| `LocalStorageSessionStore` | same | default in browser via `createDefaultSessionStore()` |
| Host wire | `app/harness/HarnessHost.tsx` | first paint from local store; Clear resets local + bridge |
| Agent loop | `lib/harnessChat.ts` `runHarnessTurn` | multi-turn via folded history |

Multi-turn continuity: history is folded into a single `POST /api/chat` (or
`/api/agent`) prompt (`formatPromptWithHistory`, default **maxMessages=400** /
**maxChars≈3.5M**). Tool evidence is **display-only** in a `tool_run` role (plan
#345) and is **not** folded as `Tool:` lines, so a continue-after-stop/cancel
turn may re-run or infer tools from the persisted assistant prose only. The API
remains single-shot per request; multi-turn lives in the host session + Wasm
transcript.

**Reload / restore:** thinking never survives a refresh — it is ephemeral UI and
is not stored in `SessionStore`, so the durable transcript after reload is
`tool_run` + `user`/`assistant` (+ turn-end `system`/`error`). On hydrate
(`pushSessionToBridge`) the host coalesces **consecutive** `tool_run` rows into
scannable groups (`mergeToolRunPayloads`, rolling at `TOOL_RUN_ITEMS_MAX`) so a
long multi-tool session is not a wall of `N×1` cards; rows separated by an
assistant/user/error line stay distinct (never merged across a real boundary).

Blob shape (never env secrets / sandbox tokens):

```json
{
  "id": "sess_…",
  "updatedAt": 0,
  "messages": [{ "id": "m_…", "role": "user|assistant|system|error|tool_run", "text": "…", "at": 0 }],
  "cwd": "invincible"
}
```

| Field | Notes |
|-------|--------|
| `id` | Opaque client snapshot id (`sess_…`); **not** required to be a UUID |
| `updatedAt` | Epoch **ms** (safe integer) — LWW clock for cloud |
| `messages` | Full transcript for history fold + ring hydrate |
| `cwd` | **Optional** logical workspace directory (workspace-root-relative). Omitted = no remembered cwd (host omits request field → server default / `SANDBOX_DEFAULT_CWD` / `"."`). **Local only** — not written to the cloud row |

### Logical cwd rules

| Event | Behavior |
|-------|----------|
| Successful agent turn with FS tools | Host may set `cwd` from JSON / SSE `done.cwd` |
| Failed / aborted turn | **Keep** prior `cwd` |
| Chat fallback (sandbox not configured) | **Keep** prior `cwd` |
| Clear / `createEmptySession` | **Omit** `cwd` |
| Load from localStorage | Keep only safe workspace-relative strings (`sanitizeSessionCwd`); drop non-string, empty, host-absolute, control characters |
| Cloud adopt | Server body has **no** `cwd` — local `cwd` is dropped/unset on adopt |

Storage key: `invincible.harness.session.v1`.

## Cloud multi-device (signed in)

When the user has a valid Auth.js session, the host also uses an async
**`SessionRepository`** (`lib/sessionRepository.ts`) against **`/api/session`**
with `credentials: 'same-origin'`. `/api/session` always requires auth — there
is no disabled path from the route.

| Piece | Location | Notes |
|-------|----------|--------|
| Caps (client-safe) | `lib/sessionCloudCaps.ts` | shared with server validation |
| HTTP repository | `lib/sessionRepository.ts` | pull / coalesce PUT / DELETE; no Node/db imports |
| Server CRUD | `lib/tenancy/harnessSessions.ts` | one Postgres row per `user_id` |
| Route | `app/api/session/route.ts` | GET / PUT / DELETE |
| Middleware | `middleware.ts` | `/api/session` protected like chat/agent/models |

### Hybrid behavior

```text
mount:
  local SessionStore.load → first paint (hydrate ring or welcome)
  void cloud pull          → never blocks Ready / first paint

after each turn persist:
  local save (sync)
  schedulePush(trimForCloudPut(snapshot))   # coalesce; at most one in-flight PUT

Clear:
  local empty + bridge clear
  DELETE /api/session only   # never PUT empty
```

| HTTP | Meaning | Client |
|------|---------|--------|
| **200** GET/PUT | Snapshot body `{ id, updatedAt, messages }` | Pull: adopt if server newer or local empty-of-dialogue; PUT ok |
| **204** DELETE | Idempotent remove | Clear path |
| **401** | Not signed in | Disable cloud repo for this page load (local continues) |
| **404** + `NOT_FOUND` | No row yet | Keep local; first PUT creates |
| **409** | Server has newer `updatedAt` | Adopt server body + latest ring window |
| **413** | Body too large | Host pre-trims; treat as error, keep local |
| **503** / network | Unavailable | Keep local SoT; no dual-chat error panel |

**Empty-of-dialogue:** no `user` / `assistant` messages (system-only welcome counts
as empty for adopt). **Equal `updatedAt` on pull:** keep local. Server PUT treats
equal as idempotent overwrite.

Cloud errors stay **silent on the product surface** (local remains source of truth
for the open tab). Do not add a React chat panel or competing transcript for sync
status.

### Identity and row key

| Concept | Value |
|---------|--------|
| Postgres row key | Auth user id (`user_id`) — one active harness session per user |
| Client `SessionSnapshot.id` | Opaque `sess_…` string (max 128, no control chars) stored as `snapshot_id` |
| Ownership | Always from session user id — never from client-supplied user fields |

### Caps (server + host pre-PUT trim)

| Cap | Value | Notes |
|-----|-------|--------|
| Messages per row | **no count cap** | Body ~2 MiB may drop oldest if needed |
| Per-message text | **262 144** UTF-8 bytes | Aligns with bridge `MAX_MSG_LEN` |
| Raw PUT body | **~2 MiB** | Reject oversize; host trims before PUT |
| Snapshot id | max **128** chars | Opaque printable |

Host `trimForCloudPut` omits `cwd`, enforces count/byte/body caps, then PUT.

### What is not in the cloud row

- Gateway / BYOK / sandbox / MCP / PAT secrets  
- Host absolute paths  
- `cwd` (local-only)  
- Workspace file contents (object storage is a separate future design)

## Ring window vs full session

The Wasm transcript ring holds at most **2048** messages (`MAX_MSG` /
`HARNESS_RING_MAX`). The host `SessionStore` and cloud row may
differ in length (body trim can shorten cloud vs local). On restore the host hydrates the **latest** window into the
ring. After a turn on the latest window, new lines push incrementally; the host
updates `ringWindowStart` / `can_load_earlier` without a full re-hydrate.

When the session is longer than the ring window, the canvas shows **Load earlier**
(protocol **v6**). The host steps back by **`HISTORY_PAGE` = 512** messages,
still capping hydrate at the ring max. A new send **snaps** the ring to the
latest window.

| Piece | Location |
|-------|----------|
| Window math | `lib/sessionWindow.ts` |
| Hydrate | `lib/harnessChat.ts` `pushSessionToBridge` |
| Host state + poll | `app/harness/HarnessHost.tsx` |
| Load earlier control | `native/harness/src/ui.zig` |
| Bridge pending | `inv_set_can_load_earlier` / `inv_has_pending_load_earlier` / `inv_ack_pending_load_earlier` |

Cloud sync stores **messages** (trimmed), not the current ring window index.

## Operator: enable multi-device on a deploy

1. Tenancy configured (triple env: `DATABASE_URL`, `AUTH_SECRET`,
   `CREDENTIALS_ENCRYPTION_KEY`) — see [bring-your-own.md](bring-your-own.md) §4a.  
2. Schema: GitHub Actions → **`db-migrate`** → `confirm=migrate` (includes
   `harness_sessions`). Do **not** use `db-tenancy-bootstrap` / seed solely for
   this table. Workflow: [`.github/workflows/db-migrate.yml`](../.github/workflows/db-migrate.yml).  
3. Redeploy the app if env/schema just changed.  
4. **Smoke (product UI):** same signed-in user in two browsers — turn on A, refresh
   B sees messages; Clear on A removes cloud row (B refresh no longer restores that
   dialogue from server).

Primary path is **Actions + browser**. Cloud agent workspaces may run the same
scripts the workflow runs; personal-laptop npm is not the documented Production path.

## Product rule

If a feature needs “files on disk,” implement it as **workspace objects in cloud
storage**, never as `fs` in the browser or on the Next server as a multi-tenant
store. Session rows hold **message transcripts** (and opaque ids), not file bytes.
