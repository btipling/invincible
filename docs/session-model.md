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
| Host wire | `app/harness/HarnessHost.tsx` | first paint from local store; **New session** (Clear alias) resets local + bridge + mints a fresh id |
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

**Status bar reseed (protocol v13, plan #538/#541):** on hydrate/restore and
after **every** agent turn the host folds session state into the bridge
status-slot store (`lib/harnessChat.ts` `foldStatusSlots`) — sandbox from
`activeSandboxId` (`sandbox <id>` label) and `cwd` (workspace-relative). The
fold runs on **both** the success path (so the sandbox slot reflects the
**post-turn** effective bind — a `meta_sandbox_switch` target survives) and the
**fail path** (so a 403 grant-honesty clear repaints the sandbox slot away, and
a cancelled/timed-out turn that committed a `change_dir` repaints the boot cwd
the next turn uses — never a stale pre-turn value; this is the same fold-before-
persist discipline as `attachedSlugs`). **Phase 2 (#627 / #625):** folds are now
**LIVE on tool results** mid-turn — a confirmed `change_dir` or successful
`meta_sandbox_switch` repaints the sandbox/cwd slots immediately (plus git on
switch), and the host persists the patched snapshot via `onSessionPatch` before
`done`. Folded values are **host-ellipsized** to
the slot byte cap at a UTF-8 boundary before the wire; a no-bind/no-cwd session
clears the slots (never a stale leftover). The Wasm paints the pack in the
always-mounted bottom **status bar** directly below the composer — the header no
longer paints it (see [harness-limits.md](harness-limits.md)). Bridge is **v13** —
additive status exports, old exports intact.

**Git slot (Phase 2 #540):** the **git** status slot (`branch@sha[∗]`) is
server-probed, not host-folded. The DOM host polls **`GET /api/harness/status`**
on a ~10 s cadence (`lib/harnessChat.ts` `refreshGitStatusSlot`, wired in
`app/harness/HarnessHost.tsx`); the route resolves the caller's
**envelope-authoritative** active sandbox bind (`meta.activeSandboxId` wins over a
Redis-safe `?sandboxId=` carry — the same `envelope ?? body` precedence as the
agent route) and runs a **bounded, argv-only, read-only** git probe at the bind
**workspace root** (`lib/agent/statusProbe.ts`, never the caller's session cwd).
Read-only git only (`rev-parse` + `status --porcelain`); non-git / probe error →
empty (`{ git: {} }`), a 200 fail-soft that just mutes the git slot. Server-side
**per-instance best-effort** rate cap `STATUS_PROBE_MIN_INTERVAL_MS` (the host
cadence is the real throttle; see [harness-limits.md](harness-limits.md)). The
probe is **read-only — it never mutates a session or envelope** (no Production
data write). Auth = middleware matcher + `requireSessionUser`.

The **local** blob uses the opaque client snapshot shape:

```json
{
  "id": "sess_…",
  "updatedAt": 0,
  "messages": [{ "id": "m_…", "role": "user|assistant|system|error|tool_run|skill_attached", "text": "…", "at": 0 }],
  "cwd": "invincible"
}
```

| Field | Notes |
|-------|--------|
| `id` | Opaque local snapshot id (`sess_…`) |
| `updatedAt` | Epoch **ms** (safe integer) — LWW clock for cloud |
| `messages` | Full transcript for history fold + ring hydrate |
| `cwd` | **Optional** logical workspace directory (workspace-root-relative). **Session-owned** (P1/GAP-1, #452) — synced to the cloud record as `meta.logicalCwd`, so it survives a device switch. A **confirmed successful `change_dir`** is persisted even when the turn later cancels / times out / hard-errors, so `cwd` survives across turn outcomes — not just a successful turn |
| `activeSandboxId` | **Optional** server/origin sandbox id (Redis-safe opaque). **Session-owned, server-resolved** (P1/GAP-1, #452 + #330): synced as `meta.activeSandboxId` and sent on every `/api/agent` POST as the resolve **override**. The host folds it into the turn and, on success, applies the server's post-turn effective bind — `agentResult.activeSandboxId` (the `meta_sandbox_switch` target) with fallback to `sandboxId` — back as the authoritative binding (never the pre-turn `sandboxId` clobbering a switch); a hard 403 of the **grant-honesty class** (set-but-unusable: `Sandbox access denied.` / selection-required) clears the stale value so the next turn honestly re-resolves from preference / selection. A 403 `Workspace instance is not running.` (a usable grant whose instance is down / softContinue) is **kept** — never silently re-resolved to another grant |
| `selectedModel` | **Optional** selected-model id (non-secret printable-ASCII catalog string, e.g. `provider/model`). **Session-owned** (plan #616 / source #610): synced to the cloud record as `meta.selectedModel` (reserved key), so the pick survives a reload and a device-switch adopt. Restore is **by id** after the model catalog is pushed (additive protocol-**v16** host→Wasm set-by-id export, never index math); a stored id missing from the (revoked/changed) catalog → default first-granted. The host also folds a user **Next** cycle into the snapshot via the **pending-model-change** flag (`inv_has_pending_model_change` / `inv_ack_pending_model_change`) observed by the host poll, so a pick persists without waiting for a turn; submit still reads the **live** Wasm selection (`getSelectedModel()`) — the carrier is never a second source of truth on the POST body. `sanitizeModelId` (≤ `MAX_MODEL_ID_LEN` = 128 bytes, printable ASCII) drops a poisoned value to unset — never brick a record |
| `usage` | **Optional** last-completed provider token summary (`UsageSummary`, `source === 'provider'`). Rides reserved `meta.usage` as a JSON string (drop-to-unset on poison / non-provider / oversize — never `INVALID_META`). Restore on pull/adopt paints the context slot; **absent = hide**. Capture is live mid-stream (`usage` SSE events from `finish` parts) and reconciled at stream/JSON `done` (the conclusive replace — absent at `done` clears); abort keeps the prior honest in-memory value until the next persist; New/Clear wipe it |

Storage key: `invincible.harness.session.v1`.

## Cloud multi-session (signed in)

When the user has a valid Auth.js session, the host also uses an async
**`SessionRepository`** (`lib/sessionRepository.ts`) against the id-shaped
**`/api/sessions*`** surface with `credentials: 'same-origin'`. The cloud store
is **Redis** (`lib/sessions/redisSessionStore.ts`, RESP over a single
`REDIS_URL`); each session is a server-minted UUID record owned by
`{tenant, userId, sessionId}`. The host holds **many** cloud sessions; the **list and switch** live in the Wasm transcript left rail (host pushes summaries from `GET /api/sessions`; a row click hydrates via the existing host switch path). **New session**, **Persona**, and **Clear** stay in DOM `AppNav`. Starting a **New session** (the **Clear** control is now its alias) deletes
just the active one and mints a fresh one.

| Piece | Location | Notes |
|-------|----------|--------|
| Caps (client-safe) | `lib/sessionCloudCaps.ts` | shared with server validation |
| Store seam (server) | `lib/sessions/sessionStore.ts`, `lib/sessions/redisSessionStore.ts` | Redis (RESP) `ServerSessionStore` (+ phase-0 `SessionEnvelopeStore` seam); fail-closed 503 |
| Transcript object store (phase 0 #515) | `lib/sessions/blobStore.ts`, `lib/sessions/blobStores.ts` | Vercel Blob default (`BLOB_READ_WRITE_TOKEN`) / BYO S3-R2 behind the same seam; client→Blob uploads |
| List/mint/pull/push/DELETE routes | `app/api/sessions/route.ts`, `app/api/sessions/[id]/route.ts` | `/api/sessions` + `/api/sessions/:id` |
| Envelope + transcript routes (phase 0 #515) | `app/api/sessions/[id]/envelope/route.ts`, `[id]/transcript/route.ts` | small envelope upsert/read + mint upload/read-window |
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
  # Phase 0 (#515) carrier: on envelope deploys the host mints a client→Blob upload,
  # PUTs the transcript segment to Blob, then upserts the small envelope
  # (meta incl. meta.transcriptPointer) — no full-document JSON PUT on the hot path.
  # Roll-forward deploys keep the one-shot trimForCloudPut PUT below.
  schedulePush(trimForCloudPut(snapshot))   # coalesce; at most one in-flight PUT to /api/sessions/:id
                                            # cwd + activeSandboxId + selectedModel
                                            # ride the PUT as meta.{logicalCwd,activeSandboxId,selectedModel}

New session (Clear-this):
  fresh id + empty transcript (cwd/activeSandboxId reset) + optional default persona bound
  DELETE /api/sessions/:id     # removes that ONE session; others untouched
  POST /api/sessions → new server-minted UUID  # or a fresh local sess_… id when offline
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
| Session id | **Server-minted** UUID (`crypto.randomUUID()`); Redis-safe `^[A-Za-z0-9_-]{1,512}$`. Never reuse an opaque client `sess_…` as a cloud record id |
| Record key | `harness:session:{tenantId}:{userId}:{sessionId}` (keyspace) |
| Tenant + user | **Server-derived** via `loadSoleMembership` — never from client body/headers |
| Write key | The **path** `:id`; body `id` must equal the path id, else **400** |
| `createdAt` | Epoch ms at mint/backfill — immutable after create |
| `updatedAt` | Epoch ms of last accepted write. **New sessions are seeded `0`** (first host PUT with epoch-now ≥ 0 is idempotent-accept, never a spurious 409) |
| Cross-user | Other-user id / nonexistent id → **404** (no existence leak) |
| `meta` | **Schema-typed reserved**: `title`, `legacySnapshotId`, `activeSandboxId`, `logicalCwd`, `personaId`, `personaSnapshot`, `transcriptPointer`, `attachedSkills`, `selectedModel`, `usage` — opaque scalars + serialized size cap; nothing else. **Write contract (all keys):** PUT `meta` is the **full desired set** (replace). `upsertEnvelope` stores `input.meta` as-is (`meta: input.meta ?? {}`). **Absent key = clear** that field. There is no PATCH/merge on the store. Mid-turn server writers (`meta_sandbox_switch`, skill inject) **read-copy-override** the existing envelope meta so a one-key update cannot clear siblings. Host `cloudMetaFor` emits every carrier it knows; it folds `attachedSlugs` on every PUT so a rewrite cannot drop the set (omit would clear). `'[]'` is the empty-set **value** for `attachedSkills`, not a third verb. `personaId` is Redis-safe opaque; `personaSnapshot` is the locked-in persona text (≤ `PERSONA_SNAPSHOT_MAX_BYTES` = 512 KiB) and counts toward the raised whole-`meta` budget (**1 MiB**), so it replays on device switch while a mid-session persona edit never rewrites an in-flight session (injection is active — see [docs/personas.md](personas.md)). `attachedSkills` is a **JSON-encoded string** of skill slugs (≤ 32, dedupe): the server stores **slugs only** and re-resolves bodies every turn. **New session / Clear** mints a fresh session, so `attachedSkills` resets there. `transcriptPointer` is a Redis-safe opaque id of the latest **Blob transcript object**. `selectedModel` is a **non-secret** printable-ASCII model id (≤ 128 bytes); poison is **DROPPED to unset** (`sanitizeModelId`) — never a 400 brick. `usage` is a JSON-encoded last-completed provider `UsageSummary`; poison drops to unset (never 400). GET envelope overlays envelope `meta` as that last desired set: valid values win, **absent/poison clears** the transcript field |

### Caps (server + host pre-PUT trim)

| Cap | Value | Notes |
|-----|-------|--------|
| Messages per record | **no count cap** | Body cap may drop oldest if needed |
| Per-message text | **262 144** UTF-8 bytes | Aligns with bridge `MAX_MSG_LEN` |
| Function-carried full-record body | **2 MiB** (`HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES`) | `/api/sessions/:id` rollforward PUT/GET gate + host rollforward trim — must stay well under the 4.5 MiB Vercel Function payload ceiling (a raised cap never re-enables a one-shot >4.5 MB Function body) |
| Blob transcript-object body | **8 MiB** (`HARNESS_SESSION_MAX_BODY_BYTES`) | **Object** ceiling only — client→Blob upload, NOT a Function body; the envelope/Blob path passes this cap to `trimForCloudPut` |
| Record id / tenant / user | max **512**, Redis-safe `^[A-Za-z0-9_-]{1,512}$` | so `KEYS`/prefix globs can never bleed |
| Attached-skill inject | **256 KiB** total (`HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES`) | bodies folded into `skillsPreamble` greedily up to this per-turn budget (count cap alone is not a size cap); a new attach that would exceed it is rejected (`too_large` / `budget`) and never counted as attached |

Host `trimForCloudPut` folds `cwd` + `activeSandboxId` into `meta.{logicalCwd,activeSandboxId}`
and `attachedSlugs` into `meta.attachedSkills`, `selectedModel` into `meta.selectedModel`,
and last-completed `usage` into `meta.usage` (JSON string; **absent = clear**),
(shared client-safe predicates; a host-absolute cwd / non-Redis-safe id /
non-printable-ASCII model / non-provider usage is dropped to unset),
enforces count/byte/body caps (byte accounting includes `meta`), then PUT.
`parseCloudSessionSnapshot` restores those from `meta` on pull/adopt (fail-open: a poisoned
value drops to unset / [] for `attachedSkills`, never a sticky 400).
Envelope GET overlays envelope `meta` as the last desired set; **absent keys clear**
the transcript field (same replace contract as PUT).

### What is not in a cloud record

- Gateway / BYOK / sandbox / MCP / PAT secrets
- Host absolute paths (`logicalCwd` is always workspace-relative — validated + re-sanitized)
- Workspace file contents (object storage is a separate future design)
- `REDIS_URL` (embeds the Redis credential — never logged)

### Envelope + Blob transcript carrier (phase 0 #515)

The **only large surface** of a session — the transcript — lives in append-only
**objects** in Vercel Blob (S3-backed; BYO S3/R2 behind the same seam), **never in
Redis and never through a Function payload**. Redis keeps the **small, always-fetchable
envelope** (`harness:envelope:…`): ownership, `createdAt`, `updatedAt` (LWW), reserved
`meta`, and `meta.transcriptPointer` (the key of the latest transcript object).

- **Client→Blob uploads only.** The server holds the Blob credential
  (`BLOB_READ_WRITE_TOKEN`) and mints a **short-lived, scoped, credential-checked** upload
  URL via `POST /api/sessions/:id/transcript`; the client PUTs a new segment object
  **directly to Blob** (no fat body through a Function — a server upload through a
  Function still 413s against the 4.5 MiB Vercel payload limit). `GET` with `?objectId=`
  returns a server-signed read URL so the host pages from Blob.
- **Envelope upsert.** `PUT /api/sessions/:id/envelope` writes the small envelope
  (validates ownership + reserved `meta` scalar-only + pointer, enforces `updatedAt` LWW,
  `createdAt` preserved; `409` + server envelope on conflict). The envelope is the source
  of truth for ownership + LWW; the pointer addresses the transcript object.
- **Roll-forward + no backfill.** Legacy whole-blob records stay readable via the
  unchanged full-record `GET /api/sessions/:id` **while those blobs stay small** (GET is
  also a 4.5 MiB *response* limit). `readEnvelope` derives an envelope from a legacy
  record. **No Redis data backfill**.
- **Feature-divide preserved.** Wasm never talks to Blob or Redis; the DOM host drives
  the client→Blob upload + envelope upsert through `lib/sessionRepository.ts`
  (`mintUpload` / `putTranscriptObject` / `pushEnvelope`). Read paths trust-but-verify:
  identity-mismatched envelopes fail closed.
- **Config seam.** `BLOB_READ_WRITE_TOKEN` (Vercel Blob) or BYO bucket creds —
  documented-only seam, configured via the GHA/env manager, never a laptop ritual.

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

## Active sandbox binding (session-owned, server-resolved)

`activeSandboxId` is the **session-owned active binding**: it changes *where
sandbox tools run* for the current session, never the message history and never
`logicalCwd`. Mid-session switching (Settings → Sandbox → "Use for this
session") writes the id into the local `SessionStore`; it is folded into the
next `/api/agent` POST as a Redis-safe `sandboxId` override and persists across
devices via `meta.activeSandboxId`. The built-in agent tools
(`meta_sandbox_active` / `meta_sandbox_switch`, `lib/agent/metaSandboxTools.ts`)
read and **write the same value server-side**: `switch` persists
`meta.activeSandboxId` on the caller's **own** session via the phase-0 envelope
seam (`resolveSessionStore` → `isEnvelopeStore` → `readEnvelope`/`upsertEnvelope`,
`updatedAt` preserved like `attachedSkills`, never a partial write), so an
agent-driven switch survives even without a host PUT round-trip. Switching the
binding changes the per-binding jail root `R` — keep `logicalCwd`
workspace-relative (a stale absolute `<oldR>/…` from a prior bind fails
closed).

Resolve precedence (server-side): **active id → preferred → single → selection-required**.
A set-but-unusable active id fails closed with the same 403 class as today
(`Sandbox access denied.` / selection-required) — never a silent fallback and
never a 503 chat-fallback. The host clears the stale id **only on that
grant-honesty class**; a 403 `Workspace instance is not running.` is a usable
grant whose instance is simply down, so the session binding is **kept** (the
operator starts the instance) rather than being silently re-wired to another
grant. A **selection-required** resolve (multiple usable grants, no bound /
preferred id) **soft-paths** to the agent's always-present `meta_sandbox_*`
tools so the agent can `meta_sandbox_list` the usable grants and
`meta_sandbox_switch` to one (B3 reachability) — the one soft-resolve class where
meta tools are a legitimate substitute for FS/MCP/http. A **forbidden** resolve
(no usable grant at all) stays a hard 403 even with meta tools present. The
inventory + tool-surface contract is `GET
/api/sandboxes` (see [sandbox.md](sandbox.md)); the host owns the session field
and #328 status chrome renders it.

**Precedence nit — PUT, then POST.** When a request carries a `sessionId`, the
server-resolved bind **`meta.activeSandboxId` (envelope) wins over the
body-provided `sandboxId`** during resolve (`envelope ?? body`). A host/UI-side
binding change must therefore **PUT the session (persist the envelope) first,
then POST `/api/agent`** — a change made in chrome but not yet PUT is ignored by
the next agent turn until the envelope write lands. This is strictly
server-authoritative: an agent `meta_sandbox_switch` persists to the envelope,
and the host folds the returned post-turn `activeSandboxId` (not the pre-turn
`sandboxId`) so the switch survives the follow-up PUT.

## Product rule

If a feature needs “files on disk,” implement it as **workspace objects in cloud
storage**, never as `fs` in the browser or on the Next server as a multi-tenant
store. Session records hold **message transcripts** (and opaque ids / reserved
meta), not file bytes.

## New session / Continue / persona binding

Product copy uses **New session** and **Continue**, not “Clear.”

- **New session** mints a **fresh** session identity (a new local `sess_…` id and,
  when signed in, a new server-minted UUID), an **empty transcript**, resets
  `cwd` and `activeSandboxId`, and binds the chosen persona — the **default**
  from `GET /api/personas`, or **None** when there is no default. The old **Clear**
  control is an alias for “New session” (it removes the current session and starts
  a fresh one).
- **Continue** keeps the **same** session id, transcript, and persona binding
  (no re-injection). It reads the existing `meta.personaSnapshot`.

A persona is bound by id (`meta.personaId`, Redis-safe opaque) and its body is
resolved **server-side** on the first agent turn, then locked into
`meta.personaSnapshot` (≤ 512 KiB, within the 1 MiB whole-`meta` cap). Later turns
/ reload / device-switch replay that snapshot; editing a persona never rewrites an
in-flight session. The picker only ever receives persona summaries. See
[docs/personas.md](personas.md).

### Always-on skill auto-attach

Skills marked **always-on** (Settings → Skills toggle) auto-attach on **every**
new session, regardless of the chosen persona. The always-on set is:

- Re-resolved from the DB on every agent turn (same as sticky attachment).
- **Not persisted in `meta.attachedSkills`** — it is the user's global toggle,
  not session state.
- Merged into the candidate set **before** sticky slugs and the current turn's
  slash command, then de-duplicated.
- Capped at 8 skills (`USER_ALWAYS_ON_SKILLS_MAX`), subject to the same 256 KiB
  per-turn inject budget as all other attached skills.

See [docs/skills.md](skills.md) — always-on skills.
