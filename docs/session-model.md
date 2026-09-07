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
| Agent loop | `lib/harnessChat.ts` `runHarnessTurn` | production durable turns seed history server-side from `meta.modelMessagesPointer`; host fold is the one-shot roll-forward sidecar |

Multi-turn continuity on production `/api/turns`: the server seeds the orchestrator from the persisted **model-messages projection** (`meta.modelMessagesPointer` → a session-bound Blob of typed `user` / `assistant`(+`tool-call`) / truncated `tool-result` rows). The host sends the **raw** prompt. `formatPromptWithHistory` rides only as a `promptHistory` sidecar while the session has no observed pointer (legacy roll-forward); once the host observes the pointer (envelope GET overlay, envelope PUT 200 copy-forward, or a later `persist()` that copy-forwards the already-observed id) the sidecar stops. Legacy `/api/chat` and `/api/agent` still fold history into a single prompt (`formatPromptWithHistory`, plan #944: the fold budget is the model **window − reserve** in estimated tokens — the published `/api/models` `contextWindow` or the conservative 200k default, reserve `max(16384, 15% × window)`; the former 400-message cap is retired to a generous row rail and `maxChars≈3.5M` is a transport backstop only). The durable `/api/turns` seed is trimmed to the same budget at the route boundary (`trimModelMessagesToBudget` — drop oldest, re-pair; the current ask always survives and history may trim to empty to fit it). Tool evidence is **display-only** in a `tool_run` role and is **not** folded as `Tool:` lines, so a continue-after-stop/cancel turn on those legacy paths may re-run or infer tools from the persisted assistant prose only. The API remains single-shot per request; multi-turn lives in the host session + Wasm transcript + (durable path) the server-side projection.

**Reload / restore:** thinking never survives a refresh — it is ephemeral UI and
is not stored in `SessionStore`, so the durable transcript after reload is
`tool_run` + `user`/`assistant` (+ turn-end `system`/`error`). On hydrate
(`pushSessionToBridge`) the host coalesces **consecutive** `tool_run` rows into
scannable groups (`mergeToolRunPayloads`, rolling at `TOOL_RUN_ITEMS_MAX`) so a
long multi-tool session is not a wall of `N×1` cards. Envelope liveness is
independent of that transcript LWW: when the Blob object is unreadable (or
missing) but the Redis envelope is still `running` with a `turnRunId`, boot
overlays those three turn carriers onto the kept local snapshot, keeps `?s=`
pinned, and cold-attaches. Messages stay the local (or LWW-winning) transcript
until attach SSE catches up. The Blob object at `transcriptPointer` is the
**latest** transcript chunk (`id`, `updatedAt`, `messages`, optional `queue`,
optional `prev`, optional `depth`). `queue` is the F21 persisted submit-queue
mirror (host-known prompts not yet durably started; sanitized on read; omitted
= no queue). It is first-class transcript-body state, not `meta`, and must be
copy-forwarded onto worker this-run chunks (minus this-run's user prompt) and
folded by host `trimForCloudPut`. Same-id adopt field-merges it with local
(`mergeAdoptedUsage`) so a newer worker clock cannot drop a `queueAppend` that
lost the coalesced-PUT race, and a stale-long server queue cannot re-arm an
in-flight drain. Mid-turn worker persist writes **this-run messages** plus `prev` pointing at the previous
object and `depth` (1-based length of the chain ending at that object). The **terminal** persist
reconstructs that chain, suffix-merges this-run, and writes a **flatten root** (`prev` / `depth`
omitted) so GET does not walk. Persist
is head-only: it will not append when `depth` is already **256**. Legacy / host-flattened
objects omit `prev` and `depth` and are a one-node chain.
Reconstruct walks `prev` (max **256** objects, each id bound to this session)
and suffix-merges oldest→newest. Host terminal PUT may **flatten** to a full
trimmed snapshot with `prev` omitted (new root). Unknown extra keys besides
`queue` are ignored. The
worker writes a chunk after the first model delta of a turn that still has tools
to run, after each successful tool **batch**, and when a model round has no tools
(the turn is finished). Mid-turn
writes keep the envelope `running`; the finished write marks `completed`. Tokens
that arrive between those writes are attach-only until the next persist. Reconstruct
suffix-merges this-run
checkpoint rows onto prior chunks / the host flatten root so a later turn cannot
replace the accumulated transcript (`tool_run` matches by role; one host live-paint
card covers a run of checkpoint tools, including tools separated by per-round
checkpoint assistants — the turn loop emits an assistant delta every model round;
host-only `skill_attached` / `system` /
`error` rows in that window are kept and do not duplicate this-run). Per-round
checkpoint `assistant` rows that the host has not stored yet (live paint is
bridge-only until concatenated `done.text`) are skipped so they cannot zero
overlap against a host tool card; when that prior suffix still ends on the
tool card (no covering assistant), those skipped this-run assistant texts are
folded into the appended tail as one row (`+=` of per-round `delta.text`, the
same concatenation host `done.text` uses), including when the last checkpoint
round is empty-text so the incoming prefix fully matches and there is no
trailing remainder. Fold requires the winning match to have **skipped** an
incoming assistant against a prior `tool_run` (mid-turn host card). A worker
1:1 prior that already is this run (persist retry, including empty last-round)
does not skip and stays no-append. Persist retry onto a successful mid-turn fold
(reconstructed prior already ends with `+=` of this-run assistant texts) also stays no-append
when incoming ends on `tool_run` (empty last-round dropped); the leftover covering
assistant is this run, not a new reply — only when the incoming prefix is the
entire this-run. A short prefix whose fold text is a suffix of leftover
(`OK` vs `All tests passed. OK`) is a new same-user tool-turn and appends. A trailing host assistant covers remaining
this-run assistant rows only when its text equals the checkpoint assistant or
ends with it (concatenated `done.text` vs last-round text), not the reverse and
not by role alone — two tool-turns that share a user prompt keep both replies,
including a longer new reply that happens to end with a previous short ack. After
skip-preamble against a host tool card, that trailing cover is against `+=` of
**all** this-run assistant texts (the same `done.text` string), not last-round
alone: a new same-user tool-turn whose last-round is a short ack of leftover
(`OK` / `Done`) still appends when the skipped preamble differs. After a 1:1
assistant match (worker preamble before tools, or interleaved mid-round equal
text), trailing leftover cover is equal-only — a longer previous last-round that
happens to end with the new last-round (`All tests passed. OK` vs `OK`) is a new
turn and appends. Host concat with no pre-tool assistant row still covers by
`endsWith` last-round. A leftover `{ deltas }`-only object
fails parse and is not merged; restore keeps the local transcript and overlays live envelope
carriers until a later persist overwrites the pointer. A bound pointer whose object
is missing or not JSON fails persist (pointer unchanged) rather than publishing
this-run-only under a newer clock. An envelope read that throws fails persist the
same way (pointer unchanged); a missing envelope (`null`) is first persist and
starts from this run only. An empty envelope with no live turn and no blob
still 404-mints as before.

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
| `reasoningEffort` | **Optional** selected reasoning-effort token (Gateway value, e.g. `low` / `high` / `xhigh`). **Session-owned** (plan #898): synced as reserved `meta.reasoningEffort`. Restore-by-value after the host pushes this model's Gateway list (protocol **v23**). Stored `max` restores as `xhigh` when listed. Poison / not-in-list / unset → `defaultEffortFromOptions` (never auto `max` / `xhigh`). `sanitizeReasoningEffort` (`^[a-z0-9_-]{1,32}$`) drops poison to unset — never 400. Submit reads live `getSelectedReasoning()` |
| `usage` | **Optional** last-completed provider token summary (`UsageSummary`, `source === 'provider'`). Rides reserved `meta.usage` as a JSON string (drop-to-unset on poison / non-provider / oversize — never `INVALID_META`). Restore on pull/adopt paints the context slot; **absent = hide**. Capture is live mid-stream (`usage` SSE events from `finish` parts) and reconciled at stream/JSON `done` (the conclusive replace — absent at `done` clears); abort keeps the prior honest in-memory value until the next persist; New/Clear wipe it |
| `resolvedProvider` | **Optional** Gateway-resolved inference provider **slug** (e.g. `togetherai`, `fireworks`). Worker-owned reserved `meta.resolvedProvider` (same overlay as `usage`); host snapshot mirrors it. `sanitizeResolvedProvider` canonicalizes (`"Together AI"` → `togetherai`) and drops URLs / catalog model ids / oversize — never 400. Restore paints a short label on status bar line 1 (protocol **v24**); **absent = hide**. Live SSE `provider` at Busy (BYOK pin first; generation metadata overlays). `done.resolvedProvider` replaces when present; absent at `done` does not wipe a pin already shown this turn. New/Clear hide. Distinct from the catalog model id. |

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
| `meta` | **Schema-typed reserved**: `title`, `legacySnapshotId`, `activeSandboxId`, `logicalCwd`, `personaId`, `personaSnapshot`, `transcriptPointer`, `checkpointPointer`, `modelMessagesPointer`, `compactionPointer`, `freshnessReminderPointer`, `attachedSkills`, `selectedModel`, `reasoningEffort`, `resolvedProvider`, `usage`, `turnRunId`, `turnStatus`, `turnStreamCursor`, `workingNotes` — opaque scalars + serialized size cap; nothing else. **Write contract (all keys):** PUT `meta` is the **full desired set** (replace). **Absent key = clear** that field. Exception: `modelMessagesPointer`, `compactionPointer`, `freshnessReminderPointer`, and `workingNotes` are worker-authored — Host `cloudMetaFor` **never emits** them, and `upsertEnvelope` **copy-forwards** the stored value when incoming omits the key (omit is not a clear). `modelMessagesPointer` / `freshnessReminderPointer` Clear is DELETE. `workingNotes` worker-clear is a present empty string (not a PUT-omit). There is no PATCH/merge on the store. Mid-turn server writers (`meta_sandbox_switch`, skill inject, `working_notes_*`) **read-copy-override** the existing envelope meta so a one-key update cannot clear siblings. Host `cloudMetaFor` emits every *other* carrier it knows; it folds `attachedSlugs` on every PUT so a rewrite cannot drop the set (omit would clear). `'[]'` is the empty-set **value** for `attachedSkills`, not a third verb. `personaId` is Redis-safe opaque; `personaSnapshot` is the locked-in persona text (≤ `PERSONA_SNAPSHOT_MAX_BYTES` = 512 KiB) and counts toward the raised whole-`meta` budget (**1 MiB**), so it replays on device switch while a mid-session persona edit never rewrites an in-flight session (injection is active — see [docs/personas.md](personas.md)). `attachedSkills` is a **JSON-encoded string** of skill slugs (≤ 32, dedupe): the server stores **slugs only** and re-resolves bodies every turn. **New session / Clear** mints a fresh session, so `attachedSkills` resets there. `transcriptPointer` is a Redis-safe opaque id of the latest **Blob transcript object**. `selectedModel` is a **non-secret** printable-ASCII model id (≤ 128 bytes); poison is **DROPPED to unset** (`sanitizeModelId`) — never a 400 brick. `reasoningEffort` is a Gateway effort token (`^[a-z0-9_-]{1,32}$`); poison drops to unset (`sanitizeReasoningEffort`) — never 400. `usage` is a JSON-encoded last-completed provider `UsageSummary`; poison drops to unset (never 400). `workingNotes` is the session's agent-authored working-notes block (≤ `WORKING_NOTES_MAX_BYTES` = 32 KiB — see the key table below); poison drops to unset. `freshnessReminderPointer` is the volatile per-turn freshness-reminder pointer (see the key table below); poison drops to unset. GET envelope overlays envelope `meta` as that last desired set: valid values win, **absent/poison clears** the transcript field |

The four **durable-turn carriers** (below) are the live-turn state the envelope
holds so a viewport can attach to / re-resolve a run that survives tab close.
All four are **non-critical UX carriers**: a poisoned value **drops to unset**
(omitted), never a 400 brick — the same drop-to-unset decision as
`selectedModel` / `usage`. Full definitions:
[agent-stream.md](agent-stream.md) (durable wire) and
[architecture.md](architecture.md) (system map).

| Reserved key | Shape | Sanitizer / cap | Notes |
|--------------|-------|-----------------|-------|
| `turnRunId` | Redis-safe opaque string (≤ `TURN_RUN_ID_MAX` = `REDIS_SAFE_OPAQUE_ID_MAX` = 512) | `sanitizeTurnRunId` | The **Workflow run id** of the live durable turn — never the session id. Present while a turn is `running`/`cancelling`; cleared (or left with terminal `completed`) when the turn ends so the next prompt is allowed. The live-only 409 gate on `POST /api/turns` keys off `turnStatus`, not mere `turnRunId` presence. |
| `turnStatus` | Exact enum string: `idle` \| `running` \| `cancelling` \| `completed` (≤ `TURN_STATUS_MAX_BYTES` = 64) | `sanitizeTurnStatus` / `TURN_STATUS_VALUES` | The turn lifecycle. `running`/`cancelling` are **live** (409 blocks a duplicate start); `completed` is a first-class terminal member that re-allows the next prompt. Poison (unknown / case-folded / padded / oversize) drops to unset. |
| `turnStreamCursor` | Non-negative integer (≤ `TURN_STREAM_CURSOR_MAX` = 1 000 000 000) | `sanitizeTurnStreamCursor` | The monotonic **attach/replay offset** for `GET /api/turns/:runId/stream?startIndex=C`. A distinct reserved key — never folded into `turnRunId`. Poison (negative / `NaN` / non-integer / over-cap / non-number) drops to unset. |
| `checkpointPointer` | Redis-safe opaque string (≤ `REDIS_SAFE_OPAQUE_ID_MAX` = 512) | `isRedisSafeOpaqueId` | The object id of the **message-checkpoint Blob** (the bounded `{role, content}[]` replay projection). A **sibling** reserved key to `transcriptPointer` — the checkpoint body is its **own Blob object** (row/byte-capped at `TURN_MSG_CHECKPOINT_MAX_ROWS` = 4096 / `TURN_MSG_CHECKPOINT_MAX_BYTES` = 8 MiB), **never the 1 MiB `meta` body**. Only the object id rides in `meta`. Poison drops to unset. |
| `modelMessagesPointer` | Redis-safe opaque string (≤ `REDIS_SAFE_OPAQUE_ID_MAX` = 512) | `isRedisSafeOpaqueId` | The object id of the **model-messages Blob** — the model-facing message array (user / assistant(+tool-calls) / truncated tool-result rows) the next durable turn seeds its orchestrator from. A **sibling** reserved key to `checkpointPointer` — the projection body is its **own Blob object** (row/byte-capped at `MODEL_MSG_CHECKPOINT_MAX_ROWS` = 4096 / `MODEL_MSG_CHECKPOINT_MAX_BYTES` = 8 MiB, drop oldest / keep newest then re-pair; per-result excerpt `MODEL_MSG_TOOL_RESULT_MAX_CHARS` = 2000), **never the 1 MiB `meta` body**. Only the object id rides in `meta`. Poison drops to unset. Worker-owned (written by the terminal persist). Host `cloudMetaFor` **never emits** this key (GET overlay is local sidecar-stop only — a stale snapshot id would LWW-stomp the worker's latest). Envelope PUT **copy-forwards** the stored pointer when the host omits it so a flatten PUT cannot delete or roll back the next-turn seed (adversarial-review #937). Host `persist()` / model-pick writes **locally** copy-forward the already-observed id when the in-flight snapshot omits it (`keepObservedModelMessagesPointer`) so a later persistTurn cannot clobber `onEnvelopeAck` and re-open the sidecar; Clear writes the empty snapshot **without** that helper (same id). The host never fetches the Blob (feature-divide). Clear is DELETE, not a PUT-omit. |
| `compactionPointer` | Redis-safe opaque string (≤ `REDIS_SAFE_OPAQUE_ID_MAX` = 512) | `isRedisSafeOpaqueId` | The object id of the **compaction-checkpoint Blob** (`{summary, filesTouched, retainedTail}` — see **Compaction** below). A **sibling** reserved key to `checkpointPointer` — the checkpoint body is its **own Blob object** (byte-capped at `COMPACTION_CHECKPOINT_MAX_BYTES` = 2.25 MiB), **never the 1 MiB `meta` body**. Only the object id rides in `meta`. Poison drops to unset. Worker-owned (written by the terminal persist seam after a successful compaction). Host `cloudMetaFor` **never emits** this key; envelope PUT **copy-forwards** the stored pointer when the host omits it so a host flatten cannot clear the compressed prefix. A new successful compaction advances it; it is **durable** — there is no per-turn volatility rewrite (unlike the freshness reminder). Clear is DELETE, not a PUT-omit. |
| `workingNotes` | Freeform text string (≤ `WORKING_NOTES_MAX_BYTES` = **32 KiB** UTF-8 — length-only, NO charset restriction) | `sanitizeWorkingNotes` (plan #938) | The session's **agent-authored working-notes block** (source #550 — durable memory across turns, identity-not-one-shot). Written ONLY by the always-on `working_notes_update` / `working_notes_clear` tools (`lib/agent/workingNotesTools.ts`) via the worker-owned copy-forward envelope PATCH at tool-execute (clock = `max(stored, wall) + 1`, one bounded LWW retry) — so a note persists even when the turn later cancels / wall-clocks / errors. **No auto-extraction**: the agency to persist belongs to the agent. The block is folded into the system prompt of every later model round **between the persona and the attached-skills catalog** (`resolveSystem` `notesPreamble`, both `/api/agent` and the durable in-step resolver), framed as **unverified agent-authored working memory — never standing orders / established fact** (a notes write must never manufacture a persona). Empty string is the clear verb; the fold drops empty/whitespace/over-cap to unset (zero tokens). The host GET overlay rides `SessionSnapshot.workingNotes` (localStorage re-sanitized on load; `parseCloudSessionSnapshot` + `overlayEnvelopeMeta` restore). Host `cloudMetaFor` **never emits** this key (adversarial-review #940 — a stale/absent snapshot PUT at `Date.now()` would LWW-stomp the tool write). Envelope PUT **copy-forwards** the stored block when the host omits it. Worker **clear** is a present empty string, not a PUT-omit. A notes write is NOT hot: it lands on the next model round/turn. "A novel is not memory": 32 KiB bounds the standing per-round inference cost far under the 1 MiB whole-meta budget. NEW cap — no existing cap changed. |
| `freshnessReminderPointer` | Redis-safe opaque string (≤ `REDIS_SAFE_OPAQUE_ID_MAX` = 512) | `isRedisSafeOpaqueId` | The object id of the **freshness-reminder Blob** (plan #941, source #693) — the **volatile** `{paths}` JSON object naming the workspace paths the PREVIOUS turn committed `read_file` on. A **sibling** reserved key to `modelMessagesPointer` (same opaque rule, DISTINCT key — the `{paths}` projection is its own Blob surface, never folded into the model-messages projection), row/byte-capped at `FRESHNESS_REMINDER_MAX_PATHS` = 64 / `FRESHNESS_REMINDER_MAX_BYTES` = 16 KiB (drop-oldest, keep newest + explicit omitted marker). The next turn's FIRST model round reads it in-step (confused-deputy `isObjectIdBoundTo` enforced, fail-open) and folds a trailing `Error: File-freshness law…` reminder row: earlier `tool_result` snapshots are NOT live file views — a `read_file` must be re-run THIS turn (a **full** read) before `str_replace` / `write_file`. **Volatility:** the terminal persist seam rewrites the projection on EVERY persist — a zero-read turn writes `{paths:[]}` and advances the pointer, so a stale path list never survives two turns. Poison drops to unset (never a 400). Worker-owned (written by the terminal persist). Host `cloudMetaFor` **never emits** this key (same LWW-stomp class as `modelMessagesPointer`). Envelope PUT **copy-forwards** the stored pointer when the host omits it. The route reads it pre-start (sanitize-only pass-through — the route never fetches the Blob). Clear is DELETE, not a PUT-omit. NEW caps — no existing cap changed. |

The **working-notes fold** (plan #938) is read by BOTH the durable in-step
preamble resolver (`resolveInStepPreambles`) and the legacy `/api/agent` route —
same envelope, same sanitizer, same fixed frame — so the two paths can never
drift. The fold runs even when the persona/skills stores are absent (the
guard was widened; the notes read only needs the envelope).

The **model-messages projection** (the object `modelMessagesPointer` addresses) is
the LLM-payload counterpart of the display checkpoint: the same reconstructed
orchestrator rows, projected to the shape the model consumes — user and
assistant(+tool-calls) rows kept verbatim, `tool` results truncated to a bounded
excerpt, `reasoning` never carried, `persist`/`error` loop-internal rows skipped,
and a `tool` row whose `toolCallId` has no matching assistant `tool-call`
dropped (a strict provider never sees an orphan `tool-result`). The next durable
turn reads it at `POST /api/turns` (confused-deputy `isObjectIdBoundTo` enforced)
and seeds the orchestrator with real `tool-call`/`tool-result` pairs instead of a
flattened `formatPromptWithHistory` prose fold. A session with no readable
pointer runs exactly one legacy fold, then the terminal persist writes the
projection and every later turn is structured. LLM payload ≠ paint payload: the
`tool_run` card stays display-primary and is never folded into inference.

### Compaction

When a session's seeded model context grows past the selected model's fold
budget, the durable turn **compacts** the oldest prefix into a bounded summary
checkpoint instead of just trimming it. Compaction is logical, not physical: the
transcript and earlier model-messages objects stay retained in Blob — compaction
changes what the **next model seed** carries, never stored history.

| Piece | Behavior |
|-------|----------|
| Checkpoint carrier | `meta.compactionPointer` holds only a Redis-safe, session-bound object id. Its Blob object is the typed checkpoint `{ summary, filesTouched, retainedTail }` (≤ `COMPACTION_CHECKPOINT_MAX_BYTES` = 2.25 MiB), written by the terminal persist seam after a successful compaction — never envelope `meta`, never a Function body. The host flatten PUT never emits the key, and `upsertEnvelope` copy-forwards the stored valid value; a later successful compaction advances it. |
| Trigger + cut | At `POST /api/turns` the backend resolves the selected model's joined catalog window and its fold budget (window − reserve; the reserve is already subtracted and never subtracted twice), evaluates the **pre-trim** seed, and compacts only when that seed exceeds the budget **and** a safe cut exists at a user-turn boundary. The cut is re-paired so an assistant tool call is never separated from its tool result. With no legal cut the ordinary route trim (drop oldest, re-pair; the current ask always survives) is the fail-open fallback — compaction never blocks a turn. |
| Server-only summary | The Workflow runs **one** tools-off summarizer step before the first model round, using the same selected model with BYOK re-resolved in-step. The Wasm canvas and DOM host never summarize and gain no bridge/protocol surface. A failed, empty, or unusable summary **fails open**: the turn proceeds from the ordinary bounded seed and no checkpoint is persisted (a partial summary never becomes a fabricated next-turn checkpoint). |
| Next-turn seed selection | Every pointer is validated against the requesting `{tenantId, userId, sessionId}` and every decoded body is re-validated and re-paired on read. The seed preference is exact: (1) a valid model-messages object whose first row is the compaction honesty row — the post-compact live warehouse, so work done **after** a compaction is kept on later non-compacting turns; (2) otherwise a valid checkpoint, rendered as the honesty summary row followed by its re-paired retained tail; (3) otherwise an ordinary valid model-messages projection; (4) finally the host's legacy `promptHistory` sidecar. Unbound, missing, malformed, or invalid objects never seed another session — each falls through safely; bound pointers with no readable seed and no sidecar fail closed (503) rather than starting a history-less turn. |
| Honesty | The summary is a `user`-role row beginning exactly `Summary of earlier session (compacted, not live assistant prose):` — compaction context is never framed as live assistant prose, and nothing new is painted in the canvas (the row is server-side seed only). `filesTouched` renders the bounded `Files read/modified:` context line. |

See [harness-limits.md](harness-limits.md) · Compaction limits for the existing
bounds, and [feature-divide.md](feature-divide.md) for the ownership split.

### Caps (server + host pre-PUT trim)

| Cap | Value | Notes |
|-----|-------|--------|
| Messages per record | **no count cap** | Body cap may drop oldest if needed |
| Per-message text | **262 144** UTF-8 bytes | Aligns with bridge `MAX_MSG_LEN` |
| Function-carried full-record body | **2 MiB** (`HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES`) | `/api/sessions/:id` rollforward PUT/GET gate + host rollforward trim — must stay well under the 4.5 MiB Vercel Function payload ceiling (a raised cap never re-enables a one-shot >4.5 MB Function body) |
| Blob transcript-object body | **8 MiB** (`HARNESS_SESSION_MAX_BODY_BYTES`) | **Per object** (worker chunk or host flatten root) — client→Blob upload, NOT a Function body. Host `trimForCloudPut` and worker persist both **drop oldest messages** to fit the object. Hitting the ceiling is a trim, not a turn-end. Reconstruct may span many objects. |
| Transcript `prev` walk | **256** objects (`TRANSCRIPT_CHUNK_WALK_MAX`) | Loop/DoS bound on reconstruct **and** worker persist. Fail-closed on cycle / foreign `prev` / missing object (not this-chunk-only). Worker chunks carry `depth` (1-based chain length) so persist refuses a 257th object **without** walking ancestors. Flatten roots omit `prev`/`depth` (length 1). NEW generous cap — not a message cap. |
| Record id / tenant / user | max **512**, Redis-safe `^[A-Za-z0-9_-]{1,512}$` | so `KEYS`/prefix globs can never bleed |
| Attached-skill inject | **256 KiB** ceiling (`HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES`) | the default inject is a bounded **catalog** (one flattened line per attached/always-on skill: slug + name + description). A maxed CJK library of 32+8 can exceed 256 KiB; lines pack by remaining budget (occupancy 1 may use the full 256 KiB; the 32+8 count caps are the row ceiling, not a per-line tax) so every resolvable slug still appears. Bodies are never injected (the agent pulls them via `fetch_skill`, capped at `SKILL_FETCH_MAX_RETURN_BYTES` = 256 KiB per call). The 256 KiB value is an unchanged safety-rail ceiling — no cap raised or lowered |

Host `trimForCloudPut` folds `cwd` + `activeSandboxId` into `meta.{logicalCwd,activeSandboxId}`
and `attachedSlugs` into `meta.attachedSkills`, `selectedModel` into `meta.selectedModel`,
`reasoningEffort` into `meta.reasoningEffort`,
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

The **only large surface** of a session — the transcript — lives in
**objects** in Vercel Blob (S3-backed; BYO S3/R2 behind the same seam), **never in
Redis and never through a Function payload**. Redis keeps the **small, always-fetchable
envelope** (`harness:envelope:…`): ownership, `createdAt`, `updatedAt` (LWW), reserved
`meta`, and `meta.transcriptPointer` (the key of the latest transcript object).
Worker persist writes a **this-run chunk** (`id` + `messages` + optional `prev` +
optional `depth`) on mid-turn `running` overlays, and **trims oldest messages**
in that chunk to the 8 MiB object ceiling so a fat tool batch cannot kill the
turn. The **terminal** persist (`completed`) reconstructs the bound prior chain
then suffix-merges this-run messages (the same idempotent `mergeCheckpointOntoPrior`
reconstruct uses), so the head chunk itself carries prior + this-run history
even when the pointer was a this-run-only mid-turn overlay — durability is
worker-owned. That terminal head is a **flatten root** (`prev` / `depth`
omitted) so GET does not walk ancestors. After SSE `error` the host adopts that
worker transcript (GET) for local paint only and **does not** flatten-PUT (a
host-clock PUT would LWW-clobber the worker pointer — plan #934 / source #933).
A GET miss holds later host PUTs (including model/effort-pick `repo.put`, not
only `persist()`) until a GET merges the worker head; a held-session local write
does not bump the clock (freeze-0 LWW). Host GET of a prev-bearing head
fail-closes on a broken walk (never this-chunk-only), including
`turnStatus=completed` — a `failWrite` overlay is still this-run-only. Host
terminal PUT on `done` may additionally **flatten** to a full trimmed snapshot
with **`prev` / `depth` omitted** (flatten root).
Reconstruct walks `prev` when present. Persist refuses to append when the
head's chain length is already 256.
A leftover `{ deltas }` object is not a snapshot — next persist starts
from this run only and does not link `prev`.

- **Client→Blob uploads only.** The server holds the Blob credential
  (`BLOB_READ_WRITE_TOKEN`) and mints a **short-lived, scoped, credential-checked** upload
  URL via `POST /api/sessions/:id/transcript`; the client PUTs a new segment object
  **directly to Blob** (no fat body through a Function — a server upload through a
  Function still 413s against the 4.5 MiB Vercel payload limit). `GET` with `?objectId=`
  returns a server-signed read URL for any object **bound to this session** (current
  pointer or a `prev` chunk) so the host can walk the chain from Blob.
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
- Capped at 8 skills (`USER_ALWAYS_ON_SKILLS_MAX`), catalog-listed alongside
  every other attached skill in the same per-turn inject (see the caps table).

See [docs/skills.md](skills.md) — always-on skills.
