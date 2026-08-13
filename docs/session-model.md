# Session model

How harness continuity works: **local-first** browser restore plus
**cloud multi-session** sync when the user is signed in (auth always required).

## Constraints

- **No local filesystem** as source of truth for sessions/files
- No secrets (`AI_GATEWAY_API_KEY`, sandbox tokens, MCP keys, PATs) inside session blobs
- Client must not use Node `fs`
- Persistence I/O stays on the **DOM host** — Wasm never talks to storage or `/api/sessions*`

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
**maxChars≈3.5M**). Tool evidence is **display-only** in a `tool_run` role and is
**not** folded as `Tool:` lines, so a continue-after-stop/cancel turn may re-run
or infer tools from the persisted assistant prose only. The API remains
single-shot per request; multi-turn lives in the host session + Wasm transcript.

**Reload / restore:** thinking never survives a refresh — it is ephemeral UI and
is not stored in `SessionStore`, so the durable transcript after reload is
`tool_run` + `user`/`assistant` (+ turn-end `system`/`error`). On hydrate
(`pushSessionToBridge`) the host coalesces **consecutive** `tool_run` rows into
scannable groups (`mergeToolRunPayloads`, rolling at `TOOL_RUN_ITEMS_MAX`) so a
long multi-tool session is not a wall of `N×1` cards.

The **local** blob uses the opaque client snapshot shape:

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
| `id` | Opaque local snapshot id (`sess_…`) |
| `updatedAt` | Epoch **ms** (safe integer) — LWW clock for cloud |
| `messages` | Full transcript for history fold + ring hydrate |
| `cwd` | **Optional** logical workspace directory (workspace-root-relative). **Session-owned** (P1/GAP-1, #452) — synced to the cloud record as `meta.logicalCwd`, so it survives a device switch. A **confirmed successful `change_dir`** is persisted even when the turn later cancels / times out / hard-errors, so `cwd` survives across turn outcomes — not just a successful turn |
| `activeSandboxId` | **Optional** server/origin sandbox id (Redis-safe opaque). **Carried-but-not-resolved** (P1/GAP-1, #452) — synced as `meta.activeSandboxId`; the agent still resolves from the user's preferred sandbox until P2/#330 |

Storage key: `invincible.harness.session.v1`.

## Cloud multi-session (signed in)

When the user has a valid Auth.js session, the host also uses an async
**`SessionRepository`** (`lib/sessionRepository.ts`) against the id-shaped
**`/api/sessions*`** surface with `credentials: 'same-origin'`. The cloud store
is **Redis** (`lib/sessions/redisSessionStore.ts`, RESP over a single
`REDIS_URL`); each session is a server-minted UUID record owned by
`{tenant, userId, sessionId}`. The host can hold **many** cloud sessions
(`app/components/SessionPicker.tsx`) and switch between them; `Clear` deletes
just the active one.

| Piece | Location | Notes |
|-------|----------|--------|
| Caps (client-safe) | `lib/sessionCloudCaps.ts` | shared with server validation |
| Store seam (server) | `lib/sessions/sessionStore.ts`, `lib/sessions/redisSessionStore.ts` | Redis (RESP) `ServerSessionStore`; fail-closed 503 |
| List/mint/pull/push/DELETE routes | `app/api/sessions/route.ts`, `app/api/sessions/[id]/route.ts` | `/api/sessions` + `/api/sessions/:id` |
| Route→store seam | `lib/tenancy/harnessSessionsRedis.ts` | `loadSoleMembership` tenant derivation; test override |
| Composition root | `lib/di/index.ts` | `createSessionStore` registers the responsive store factory; single `REDIS_URL`/`SESSION_REDIS_TTL_MS` read |
| HTTP repository | `lib/sessionRepository.ts` | list / mint / pull / coalesce PUT / DELETE; no Node/db imports |
| Postgres archive | `db/schema.ts` `harness_sessions` | **read-only archive** after the one-shot backfill |
| Middleware | `middleware.ts` | `/api/sessions` + `/api/sessions/:path*` protected like chat/agent/models |

### Hybrid behavior

```text
mount:
  local SessionStore.load → first paint (hydrate ring or welcome)
  void cloud pull          → never blocks Ready / first paint

mount with a pinned ?s=… cloud id:
  mint-on-first / adopt the pinned session when it exists

create (picker "New"):
  POST /api/sessions → server-minted UUID id (updatedAt:0, createdAt now)
  host binds the minted id and pushes the local dialogue into it

after each turn persist:
  local save (sync)
  schedulePush(trimForCloudPut(snapshot))   # coalesce; at most one in-flight PUT to /api/sessions/:id
                                            # cwd + activeSandboxId ride the PUT as meta.{logicalCwd,activeSandboxId}

Clear (Clear-this):
  local empty + bridge clear
  DELETE /api/sessions/:id   # removes that ONE session; others untouched
```

| HTTP | Meaning | Client |
|------|---------|--------|
| **200** GET/POST/PUT | Record `{ id, tenantId, userId, createdAt, updatedAt, messages, meta }` | Pull: adopt if server newer or local empty-of-dialogue; mint / PUT ok |
| **204** DELETE | Idempotent remove of one session | Clear-this path |
| **401** | Not signed in | Disable cloud repo for this page load (local continues) |
| **404** `NOT_FOUND` | No row for that id (or other-user id — no existence leak) | Keep local; first PUT to a minted id creates |
| **409** | Server has newer `updatedAt` | Adopt server record + latest ring window |
| **413** | Body too large | Host pre-trims; treat as error, keep local |
| **503** `SESSION_STORE_UNAVAILABLE` | Redis unreachable / unconfigured | Keep local SoT; no dual-chat error panel |

**Empty-of-dialogue:** no `user` / `assistant` messages (system-only welcome counts
as empty for adopt). **Equal `updatedAt` on pull:** keep local. Server PUT treats
equal as idempotent overwrite.

Cloud errors stay **silent on the product surface** (local remains source of truth
for the open tab).

### Identity, ownership, and the write key

| Concept | Value |
|---------|--------|
| Session id | **Server-minted** UUID (`crypto.randomUUID()`); Redis-safe `^[A-Za-z0-9_-]{1,128}$`. Never reuse an opaque client `sess_…` as a cloud record id |
| Record key | `harness:session:{tenantId}:{userId}:{sessionId}` (keyspace) |
| Tenant + user | **Server-derived** via `loadSoleMembership` — never from client body/headers |
| Write key | The **path** `:id`; body `id` must equal the path id, else **400** |
| `createdAt` | Epoch ms at mint/backfill — immutable after create |
| `updatedAt` | Epoch ms of last accepted write. **New sessions are seeded `0`** (first host PUT with epoch-now ≥ 0 is idempotent-accept, never a spurious 409) |
| Cross-user | Other-user id / nonexistent id → **404** (no existence leak) |
| `meta` | **Schema-typed reserved**: `title`, `legacySnapshotId`, `activeSandboxId`, `logicalCwd` — opaque scalars + serialized size cap; nothing else |

### Caps (server + host pre-PUT trim)

| Cap | Value | Notes |
|-----|-------|--------|
| Messages per record | **no count cap** | Body ~2 MiB may drop oldest if needed |
| Per-message text | **262 144** UTF-8 bytes | Aligns with bridge `MAX_MSG_LEN` |
| Raw PUT body | **~2 MiB** | Reject oversize; host trims before PUT |
| Record id / tenant / user | max **128**, Redis-safe `^[A-Za-z0-9_-]{1,128}$` | so `KEYS`/prefix globs can never bleed |

Host `trimForCloudPut` folds `cwd` + `activeSandboxId` into `meta.{logicalCwd,activeSandboxId}`
(shared client-safe predicates; a host-absolute cwd / non-Redis-safe id is dropped to unset),
enforces count/byte/body caps (byte accounting includes `meta`), then PUT.
`parseCloudSessionSnapshot` restores both from `meta` on pull/adopt (fail-open: a poisoned
value drops to unset, never a sticky 400).

### What is not in a cloud record

- Gateway / BYOK / sandbox / MCP / PAT secrets
- Host absolute paths (`logicalCwd` is always workspace-relative — validated + re-sanitized)
- Workspace file contents (object storage is a separate future design)
- `REDIS_URL` (embeds the Redis credential — never logged)

## Postgres → archive

Before multi-session, the cloud row lived in Postgres `harness_sessions`
(**one row per user**). Phase 4 migrates each row to a Redis session and leaves
`harness_sessions` as a **read-only durable archive**. The legacy
`/api/session` write route was removed; the host uses only `/api/sessions*`.
`lib/tenancy/harnessSessions.ts` keeps the archive read + the shared
`validateSessionSnapshot` / caps exports the Redis store reuses.

## Ring window vs full session

The Wasm transcript ring holds at most **2048** messages (`MAX_MSG` /
`HARNESS_RING_MAX`). The host `SessionStore` and a cloud record may
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

## Operator: turn on Redis multi-session on a deploy

1. Tenancy configured (triple env: `DATABASE_URL`, `AUTH_SECRET`,
   `CREDENTIALS_ENCRYPTION_KEY`) — see [bring-your-own.md](bring-your-own.md) §4a.
2. Provision a Redis (`REDIS_URL` RESP `redis://`/`rediss://`, a.k.a. a
   Vercel/Upstash Redis integration) and set `REDIS_URL` in Vercel env — the
   store fails closed (**503 `SESSION_STORE_UNAVAILABLE`**) until it is set.
3. One-shot Postgres→Redis backfill: GitHub Actions →
   **`sessions-redis-backfill`** → `confirm=backfill` (optional `dry_run` first).
   Idempotent per-`{tenant,user}` marker; then `harness_sessions` is a read-only
   archive. **Never** use `db-migrate` or the app's first-run sign-up for this
   (that is not a backfill).
4. Redeploy the app if env just changed.
5. **Smoke (product UI):** same signed-in user in two browsers — turn on A,
   refresh B sees it; `New` creates a second session; picker switches; Clear on A
   removes only that session (B's other sessions untouched).

Primary path is **Actions + browser**. Cloud agent workspaces may run the same
scripts the workflow runs; personal-laptop npm is not the documented Production path.

## Product rule

If a feature needs “files on disk,” implement it as **workspace objects in cloud
storage**, never as `fs` in the browser or on the Next server as a multi-tenant
store. Session records hold **message transcripts** (and opaque ids / reserved
meta), not file bytes.
