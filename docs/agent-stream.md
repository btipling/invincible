# Agent stream (SSE)

`POST /api/agent` can return a **Server-Sent Events** body when the client asks for it.
Default remains a single JSON `{ text, toolTrace?, cwd? }` response for tests and simple clients.

`POST /api/turns` (production durable-turn path) uses the **same** event types as `/api/agent`. Tokens ride the Workflows durable stream (`getWritable`). Stream **write and close must run on a `'use step'` stack** — a `'use workflow'` function cannot call `getWriter` / `write` / `close`. The writer helpers (`lib/workflows/turnSseWrite.ts`) are **directive-free** and must not carry `'use step'` (nested-step ban). Live model-step writes hold **one** Workflows writer for the round (`withDefaultStreamWriter` around `generateOneRound` in `modelGenerateStep`) — do **not** call `getWritable()` per token. Live `tool_result` holds **one** writer inside `toolExecuteStep` for that round’s toolCalls (one step per burst; independent calls overlap; bind-mutators and FS editors serialize). Loop-owned `done` / `error` (and wrap-up skipped-tool lines) stay one write per `writeTurnSse` step. A user-stream **PUT** 5xx / 429 / timeout latches the held writer immediately (stream appends are not idempotent; SDK `STREAM_RETRY_OPTIONS` already retried 429 inside the first `write()`; a reject poisons the 4.8.4 sink so a second `write()` cannot PUT). Held writer latches dead; later tokens no-op. Persist is the source of truth; live SSE is a viewport. Writer I/O does **not** fail the turn. That is the **producer** path — a dropped **reader** body (tab/proxy EOF) is detach, not a writer blip. AbortError on write is never latched.

## Negotiation

| Client | Server |
|--------|--------|
| Header `Accept: text/event-stream` | `Content-Type: text/event-stream; charset=utf-8` + SSE events |
| Other / missing Accept | JSON `{ text, toolTrace?, cwd? }` or `{ error }` |

Early failures (auth, grants, bad body, BYOK) always use **JSON** status responses — even if Accept requested a stream. Typical statuses are **401** (unauthenticated), **403** (no usable sandbox grant and no alternate tools / denied), and other **4xx** for bad body or bad data. There is **no** sandbox-not-configured **503** → chat fallback; host stream clients must parse the JSON error and must **not** special-case a chat-fallback string (the route never emits it).

Response hints: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.


## Request body (cwd)

| Field | Required | Notes |
|-------|----------|--------|
| `prompt` | yes | Same limits as chat |
| `modelId` | no | Gateway model id |
| `cwd` | no | Logical **workspace-root-relative** directory for this turn |

**Omitted / null `cwd`:** server uses `"."` (workspace-root default); there is no `SANDBOX_DEFAULT_CWD` env knob.  
**Present but invalid** (host-absolute, control chars, non-string): **400** JSON error — not a stream.  
**Response `cwd`:** included on JSON success and SSE `done` only when FS tools ran this turn; always a normalized workspace-relative path. Host session should update stored cwd **only on success** (never on abort/error).  
**Response `usage` (Phase 3 #539 + #628):** a bounded, **provider-sourced** token summary `{ source: "provider", prompt?, completion?, total?, cached? }`. Emitted as a **live `usage` SSE event** mid-stream when the AI SDK reports **aggregate** usage on a `finish` stream part (`totalUsage`, or v7 `usage`), and again on the SSE `done` event / JSON result as the **conclusive reconcile**. `finish-step` is **never** a source — its per-step counts are not a turn total. Absent (no event emitted) when a finish part reports no usable token counts, and on abort/cancel (no completion). The host folds the context slot immediately on the live event; `done.usage` is the final reconcile. Default on missing usage is **hidden** — never client token math. Serialized carrier capped at `USAGE_SUMMARY_MAX_BYTES` (96 B); an oversized carrier is omitted, never a broken turn.

## Events

Each SSE block is one `data: <json>\n\n` line:

| `type` | Fields | Host use |
|--------|--------|----------|
| `tool_start` | `name`, optional `id` | **Live-paint** one display-only `tool_run` card (protocol v11 / kind 6) on this event |
| `tool_result` | `name`, `ok`, `summary`, optional `id`, optional `preview`, optional `changeDirCwd`, optional `activeSandboxId` | **Grow the open `tool_run` card in place** (total increments) while the last ring row is a tool-run; else open a NEW card at `1`. `id` is the provider tool-call id (same value as `tool_start.id`) — the host pairs completion-order live results by this id when present, not LIFO-by-name. `preview` is a bounded, redacted level-2 detail body (`TOOL_RUN_PREVIEW_MAX_CHARS` = 100k, head+tail `… (N more lines)`) built from flattened+redacted tool output — **not** raw MCP envelopes. `changeDirCwd` is the confirmed workspace-relative cwd from a successful `change_dir` (typed field from the raw result — never the truncated summary). `activeSandboxId` is the switched-to sandbox id from a successful `meta_sandbox_switch` (Phase 2 #627 / #625) — the host applies it live mid-turn |
| `reasoning_delta` | `text` (chunk) | Grow a **Thinking** bubble (protocol v8) |
| `text_delta` | `text` (chunk) | Grow Assistant bubble(s) |
| `usage` | `usage` | **Live mid-stream** provider token summary from a `finish` part (aggregate only). `finish-step` never emits this. The host folds the context slot immediately; `done.usage` is the final reconcile. Absent when the part carried no usable counts — never a clear/flicker |
| `done` | `text`, optional `finishReason`, optional `toolTrace`, optional `cwd`, optional `usage` | Collapse open thinking; finalize session; apply `cwd` on success only; fold bounded provider `usage` (Phase 3 #628 — `done.usage` is the conclusive reconcile). **`finishReason: content-filter` / `error` is provider refusal** — the durable loop sends SSE `error` (`content filtered` / `model error`) instead, and the host treats a refusal `done` the same way. `length` (provider output cap) is `done` with the partial text — a cap is not a failed turn. Real chat end is `stop`, omitted, or `length`. |
| `error` | `error`, optional `status` | Collapse open thinking; a host **retryable** failure retries the same turn up to 5 attempts (**1 attempt** if any ring row has already been painted mid-stream — re-painting would duplicate tools/bubbles) before give-up; give-up paints the Error message and the turn lands on **Error** — never consuming the operator queue |

Unknown types are ignored (forward-compatible). String fields are redacted server-side with the same secret list as JSON responses.

On the production durable path (`POST /api/turns`), `reasoning_delta` / `text_delta` / `tool_start` token-stream from inside the model step as provider parts arrive, on **one** held Workflows writer for that round. `tool_result` streams from inside the **tool-batch** step (`toolExecuteStep({ calls })` — one `'use step'` per model round’s toolCalls, independent calls overlap, bind-mutators and FS editors serialize) on one held writer as each call settles. `done` / `error` stay loop-owned (`writeTurnSse`). Legacy `/api/agent` token-streams those same event types as they arrive from the provider. If the Workflows user-stream PUT blips (5xx / 429 / timeout dropped immediately; SDK already retried 429), the loop and transcript persist continue. Operator Error chrome is for an actual failed turn, not a viewport flush.

### Level-2 preview (`tool_result.preview`)

The stream `tool_result` event carries an **optional** `preview` field: a bounded,
redacted level-2 detail body for the harness expander (phase 3 #353). It is built
from the already **flattened + redacted** tool output (never a raw MCP JSON
envelope), keeps the **real** first **40** / last **10** lines of the full output
joined by `… (M more lines)` — head/tail are taken **before** the char cap, so
the L2 "tail" is genuinely the end-of-output — and is capped at
`TOOL_RUN_PREVIEW_MAX_CHARS` (100k) per tool. Short single-line results omit
`preview`, so the host paints a static label instead of a duplicate-of-L1 blank
expander. The host feeds `preview` into the level-2 `detail` of the aggregated
`tool_run` message; because a whole `tool_run` row encodes into ONE message, a
group-level encode budget + a hard clamp to the 262 144-byte/msg cap keep a
multi-preview streak from overflowing it (never a silent mid-payload clip).

**JSON fallback** (`Accept` other than `text/event-stream`) keeps a **one-line
level-2 detail from `summary`** — documented parity for the tests/simple-clients
path, not silently diverging from the stream.

## Wasm bridge

Assistant and thinking growth use **protocol v8** `inv_update_last_message` so streaming does not create one ring message per token. Each **uninterrupted** tool streak is aggregated by the host into ONE `tool_run` message (protocol **v11** / bridge **kind 6**) that the Wasm paints as a default-collapsed expandable control — **not** System lines. The tool card is **painted live**: each `tool_start`/`tool_result` opens (or grows) that ONE kind-6 row immediately — `1 tool called` → `2…` — via `update_last`, growing iff the last ring row is a tool-run; otherwise a **new** card at `1`. A **thinking row that lands last** (and any assistant/user/error row) is a physical separator and opens a fresh card (see [harness-limits.md](harness-limits.md) — commit-once is removed). Thinking uses `MessageKind.Thinking` (muted warm chrome + **same GFM paint** as assistant). No dual DOM transcript. In-place stream growth relies on harness stick-to-bottom (content height) so the viewport follows when the user is near the bottom — not on new SSE event types.

### Thinking collapse

While a Thinking segment is **open**, the host grows the full monologue (≤ Wasm `MAX_MSG_LEN`, currently **256 KiB**). While the harness is **Busy**, every thinking row that belongs to the current turn stays **fully visible** (including the live streaming one and any segments the turn has already closed) **only while the thinking default-collapsed preference is OFF** — when it is ON (the default, Leader then **`t`**), the Busy turn's thinking **also starts collapsed** unless the operator re-expands a row (which still works mid-Busy). Once the **turn completes** (`done`, `error`, or cancel → Ready/err), every **committed** thinking row from completed turns **auto-collapses** to a compact expandable control: a `Thinking` expander + a one-click re-expand to the full markdown monologue (muted one-line preview while collapsed, Copy on the header). This collapses accumulated reasoning so scrolled-away thinking stops being laid out and repainted every frame (composing with the O(dirty) slot-keyed parse + `cache_layout` paint for the rich transcript). Expand state and the preference are **in-memory only** — thinking and the preference are ephemeral and never survive refresh; a New/Clear/session switch returns the preference to ON. There is **no** per-turn thinking-segment or live-tool line product cap — use **Stop** to cancel.

### User cancel (Stop)

While a turn is **busy**, the harness shows **Stop**. That sets a protocol **v9**
pending cancel; the host polls it, aborts the in-flight `fetch` (`AbortSignal`),
and the existing cancel path surfaces `Request cancelled.` (no new SSE event type,
no chat fallback). Stopping before the host starts the turn discards a pending
submit so no ghost request is sent.

### Session save

| Kind | SessionStore | History fold |
|------|--------------|--------------|
| User / Assistant | **Yes** | Included |
| `tool_run` (live tools, protocol v11) | **Yes** (live-paint path: open card appended / grown in place) | **Not folded** (display-only, plan #345) — continue may re-run tools |
| Error | **Yes** | Included as `Error:` (stall/cancel context) |
| Thinking | **No** (display-only) | Never |

## Reasoning / model config

| Control | Effect |
|---------|--------|
| Model id (harness picker) | Choose a reasoning-capable granted model when desired |
| Effort (harness picker) | In-canvas menu next to the model (protocol v23). Hidden when neither Gateway nor models.dev `vercel.models[id]` published **wire-valid** values for this id. Live pick is `POST { reasoning }`. Catalog tokens are the Gateway language-model enum (`provider-default` \| `none` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh`). Catalog `max` rewrites to `xhigh` (label is never `max`); other non-wire tokens drop. A stored/request `max` coerces to `xhigh` if listed, else `high`. Unset (NEVER_AUTO-only lists) shows `effort` until the operator commits. |
| Resolved provider (harness label) | In-canvas text after the effort menu (protocol v24). Hidden when unknown. SSE `provider` is **live on the durable writer** (`formatLiveModelSse` allowlist). Capture: generation `providerMetadata.gateway.routing.resolvedProvider` (then `finalProvider`, then `providerName`/`provider`) then BYOK pin. `done.resolvedProvider` is the conclusive replace when present. Catalog id is unchanged. |
| Request `reasoning` | Optional body field on `POST /api/turns` and `POST /api/agent` (`^[a-z0-9_-]{1,32}$`). Wins over env. Wire tokens skip the catalog GET; `max` still fetches so coerce can pick `xhigh` vs `high`. |
| `AGENT_REASONING` | Ops override only: `provider-default` \| `none` \| `low` \| `medium` \| `high`. Not the operator UI. Do not set `max` here. |
| `GET /api/models` `reasoningOptions` | Per-model joined catalog: Gateway `type: effort` values when published; models.dev `vercel.models[id]` fills when Gateway omitted or empty. Catalog `max` rewrites to `xhigh`; remaining non-wire tokens drop. Empty array when both miss. |

When `reasoning` is omitted and `AGENT_REASONING` is unset, the server enables `reasoning: low` if the model id looks reasoning-capable (`reasoning` / `thinking` in the id, but not `non-reasoning`; `glm-5*` ids also match — GLM-5.x always thinks) **and** the joined catalog has not published a non-empty effort list. If the catalog lists efforts, the conservative pick is `low` then `minimal` then `medium` then `none`, then the first remaining value that is not `max` / `xhigh` / `provider-default`. The product never auto-selects `max` or `xhigh`. Catalog join rewrites `max` → `xhigh` so GLM-5.3-flash publishes `low`/`high`/`xhigh`. A request `max` then sends `xhigh`. Other models omit the option. Thinking tokens are still provider completion.


## End of turn

Most harness turns paint a final line. **Detach does not** — losing the live reader (leave-site abort, or durable `/api/turns` body EOF without a producer `done` / `error` **while the Workflow run is still live**) is not “the turn ended.” If `getRun().status` is already `cancelled` or `failed`, start/attach returns a synthetic SSE `error` **without calling `getReadable()`** — that is a turn end (Stop / error), not detach. `running` / `completed` still wrap `getReadable()` so a later cancel injects SSE and completed replay can drain. Operator Stop/Esc on an attach **aborts this reader only** and keeps `running` (server cancel is a separate seam).

| Outcome | Line |
|---------|------|
| Model finished (SSE `done` with `stop`, omitted, `length`, or any non-refusal `finishReason`) | `Turn ended · model finished` (System) |
| Output truncated (legacy SSE `error` `output truncated` only) | `Turn ended · error · output truncated` (Error). Durable `finishReason: length` is **not** this — it is model-finished with the partial assistant text. |
| Content filtered (provider `finishReason: content-filter`) | `Turn ended · error · content filtered` (Error). Same envelope rule. |
| Model / stream fail (provider `finishReason: error`) | `Turn ended · error · model error` (Error). Same envelope rule. Not a token cap. |
| Step budget wrap-up (512 workflow steps) | Wrap-up model round (tools off) then SSE `done` with that text — **not** `Turn ended · error · step budget exhausted`. The bound still stops the loop; it is not a failed turn. |
| **1-hour wall-clock cap** (plan #923) | Wrap-up model round (tools off, wall copy) then SSE **`error` `turn wall clock exceeded`** → `Turn ended · error · turn wall clock exceeded` (Error). The 1-hour bound stops the loop at the deadline; the run's terminal persist still writes `completed` (a bound is not a failed turn — the next prompt is allowed). |
| User Stop | `Turn ended · you stopped` (System) |
| Detach (leave-site abort, or durable reader-drop without `done`/`error` after the run id is folded, **while the Workflow run is still live**) | **No** turn-end line. Session keeps `turnRunId` + `turnStatus: 'running'`. Lifecycle Ready. The workflow is not cancelled. |
| Error / timeout / empty | `Turn ended · error · …` / timed out / empty (Error). A retryable error retries the **same** turn up to **5 attempts** with bounded backoff before give-up (**1 attempt once a ring row has been painted mid-stream**, and **1 attempt once a durable `/api/turns` run has started** — another POST would start a second workflow); on give-up the host sets the turn lifecycle to **Error** (so a queued head is never drained) and, if the operator queue is non-empty, inserts `Continue the current turn` as the new head. Permanent failures (the `PERMANENT_TURN_STATUS` whitelist — 400/401/403/404/413/422) give up after a single attempt; **408/429/5xx and timeout/empty stay retryable before durable start** (retry the same turn up to 5 attempts). After durable SSE start, empty/EOF without `done`/`error` **while the run is still live** is **detach**, not empty-complete and not a retry. A terminal Workflow status (`cancelled` / `failed` / `completed`) with no producer `done`/`error` is a turn end (Stop / error / done) — start/attach streams close when the run is terminal even if the producer never wrote the event. **Recoverable bookkeeping give-up** (`transcript segment write failed`, `object byte ceiling`, `session store unavailable` — `_` folds to space so the sessions `error` field and `SESSION_STORE_UNAVAILABLE` `code` hit the same needle; belt-and-suspenders after persist `{ok:false}` is non-terminal. POST `/api/turns` tenant/attach 503 copies are **not** needles — D18 / C15) is a **new** host turn: one `'continue'` POST with history fold when `canAutoContinue` (queue empty, no pending submit) and the envelope is not `running`. Not same-POST retry. Cap **1** per give-up (survives `sess_*` → UUID mint-bind); the next operator submit clears the flag. Stop / content-filter / validation / detach never auto-continue. |
| Standalone chat (`/api/chat`) | `Turn ended · chat finished` (System) — kept helper only; a failed agent turn does **not** fall back here |

These markers are **not** folded as tools into the next prompt. Error turn-end lines **are** folded as `Error: …` so Continue sees them. Hitting the step cap runs one tools-off wrap-up round this turn (`Error: step budget exhausted` in the **model** messages, system `STEP_BUDGET_WRAPUP_SYSTEM` — never `DEFAULT_AGENT_SYSTEM`) so the agent can say what it completed, then SSE `done` with that wrap-up text. Hitting the **1-hour wall-clock cap** (plan #923) runs the same tools-off wrap-up with **wall-specific** copy (`TURN_WALL_CLOCK_WRAPUP` / `_SYSTEM` — distinct from the step-budget strings), a 5-minute wrap-up bound (`deadlineAt + TURN_WALL_CLOCK_WRAPUP_MAX_MS`, not `Date.now() + WRAPUP_MAX` per attempt) + `reasoning: 'none'` (the wrap-up is 1h-exempt so it can complete after the cap, but not unbounded), and ends with SSE **`error` `turn wall clock exceeded`** — a hard stop mid-work is honest as an error line. When the 512-step cap and the 1-hour wall **both** fire, the **wall** terminal wins (the 512-step wrap-up is still subject to the 1h `deadlineAt` signal — running it after `deadlineAt` with no signal reintroduces the 4h evidence class). Envelope `completed` is written **after** wrap-up (not before) so C15's live-only 409 stays held. Unpaired tool-calls (cap mid-fanout) are closed with a skipped tool result first so the provider will accept the wrap-up user message.


There is **no in-repo output-token cap**. `finishReason: length` is the **provider** default max completion (not a product `maxOutputTokens`). The turn completes with the partial text (`done`); it is not a canvas Error.

## Durable events, re-resolve, and the checkpoint Blob

The durable `/api/turns` run holds its live state on the session **envelope** so
a viewport can attach to / re-resolve a run that survives tab close. The four
reserved-`meta` carriers are defined in
[session-model.md](session-model.md) (`turnRunId`, `turnStatus`,
`turnStreamCursor`, `checkpointPointer`); this section is the wire side.

- **Durable events = `getWritable()` deltas, not the event log.** Token
  `reasoning_delta` / `text_delta` / `tool_start` / `tool_result` ride the
  Workflows durable stream (one held writer per model/tool burst). The
  orchestrator's `step_completed` history stays **delta-only** — the full
  transcript is never put in the event log (O(n²) entity storage / the 2k-event
  slow-replay line). The transcript and the checkpoint live in **Blob**; the
  event log is Vercel's replay history, not the transcript store.
- **Re-resolve the tool world; re-construct the persist seam.**
  `modelGenerateStep` and `toolExecuteStep` re-resolve the tool world
  (`assembleDurableToolWorld`) from the serialized `scope` on every
  invocation — BYOK/grants, the sandbox bind, MCP servers, and `http_get`
  are re-resolved **inside the step**, never captured as a closure arg.
  `persistStep` re-constructs the Blob+envelope persist seam from the same
  `scope` (`createPersistStepSeam`); it does not assemble the tool world.
  Nothing the orchestrator holds is a live resource; replay re-derives it.
  This is why a turn survives a Function recycle: the step boundary is the
  unit of re-resolution.
- **Checkpoint-as-Blob.** The message checkpoint (the bounded `{role, content}[]`
  replay projection the loop truncates with `truncateMessageCheckpoint`) is
  written as its **own Blob object** — row/byte-capped at
  `TURN_MSG_CHECKPOINT_MAX_ROWS` = 4096 / `TURN_MSG_CHECKPOINT_MAX_BYTES` = 8 MiB
  — and only its object **id** rides in envelope `meta.checkpointPointer` (a
  sibling reserved key to `transcriptPointer`). The checkpoint body is **never**
  the 1 MiB `meta` body. On replay the loop re-reads the checkpoint from Blob by
  that pointer; a missing/unreadable checkpoint object is a fresh start for that
  run, not a corrupt `meta`.

The durable model step (`modelGenerateStep`) passes the **same** `resolveSystem()` string as `POST /api/agent` — base standing orders (including “Be concise”), plus optional persona / attached-skill blocks resolved in-step from the assembled tool registry. Persona inject reads and locks `meta.personaSnapshot` on the envelope (`readEnvelope` / `upsertEnvelope`, `updatedAt` unchanged), not the legacy whole-blob `get`/`put`. A missing system prompt is not an output cap; it is what used to let a provider default `max_tokens` look like a mysterious mid-sentence stop. Slash-command `/skill-name` attach still lives on `/api/agent`; the durable step re-resolves sticky and always-on skills only (`command: none`).

**Terminal persist is worker-owned and terminal-agnostic (plan #934).** The
worker's **terminal** persist suffix-merges this-run checkpoint messages onto
the prior readable transcript (the same idempotent `mergeCheckpointOntoPrior`
the reconstruct walk uses) before writing the head chunk, so the head itself
carries prior + this-run history. A wall-clock `error` terminal is therefore
as durable as a `done` terminal: even when the host never runs its `done`
flatten, refresh / next-prompt hydrate and the next turn's model history fold
still contain the this-turn assistants and the wrap-up handoff. Mid-turn
`running` persists stay this-run-only (transient overlays), and the merged
head is still bounded by `HARNESS_SESSION_MAX_BODY_BYTES` via
`fitSnapshotUtf8` (oldest rows drop first, newest kept).

## Turn-end logs (Workflows)

Durable `'use step'` bodies `console.log` one JSON line each. These show on **Observability → Workflows** for that run — **not** HTTP Runtime Logs (`/api/harness/status` is the only HTTP probe on that surface).

| `tag` | When | Fields (allowlisted; never prompt/system/tool args/bodies) |
|-------|------|--------|
| `invincible.turn.model` | each model round (success or `{ok:false}`) | `ok`, `finishReason?`, `toolCallCount?`, `textChars?` (assistant text only), `reasoningChars?` (UTF-16 length of accumulated redacted thinking; omitted when none), `completion?` (provider output tokens when reported), `code?` |
| `invincible.turn.persist` | each persist (terminal or mid-turn) | `ok`, `terminal`, `status?`, `turnRunId?`, `code?` |
| `invincible.turn.loop` | one per terminal loop result (plan #923) | `status`, `reason?` (`steps` \| `wall` — cap reason), `elapsedMs?` (bounded run wall-clock elapsed; omitted when no deadline) |

A truncated round logs `finishReason: "length"` on the model line, then a terminal persist, then SSE `done` with the partial text (a cap is not a failed turn). Provider `content-filter` / `error` log the same finishReason, then terminal persist, then SSE `error` with the mapped string. A thinking-only round logs `textChars: 0` and `reasoningChars` for the CoT. A natural chat end logs `finishReason: "stop"` (or omits it) and SSE `done`. A wall-capped run logs an `invincible.turn.loop` line with `status: "capped"` and `reason: "wall"` so an operator can tell the 1-hour cap from the 512-step cap (`reason: "steps"`).

## Caps

Product philosophy: **no live-tool / thinking-segment UX walls** — cancel with **Stop**.

| Cap | Value | Behavior |
|-----|------:|----------|
| Live `tool_run` groups | **one per uninterrupted streak** (painted live, grows per event) | Consecutive tools paint ONE growing card; a thinking/assistant/user/error row that lands last opens a NEW card |
| Thinking **segments** | **none** | Every reasoning segment paints |
| Thinking / line chars | **256 KiB** | Wasm `MAX_MSG_LEN` only (bridge hard edge) |
| Ring slots | **2048** | Wasm `MAX_MSG`; older drop when full; Load earlier for SessionStore |
| Tool summary length | **salient ≤320** | `salientToolBits` — path/counts/status only; **not** full read_file/exec/http bodies. `read_file` status lines include `offset` / `limit` / `lines=returned/total`; L1 salient stays `path · N lines · M B`. `sandbox_info` salient is backend · cwd · env-count (or `unavailable`) — **not** the env dump |
| Tool level-2 `preview` | **≤ 100k per tool** (`TOOL_RUN_PREVIEW_MAX_CHARS`), real head 40 / tail 10 lines + `… (M more lines)` | Bounded + redacted server-side; short single-line results omit it (static label). Whole-group encoded-detail budget + hard clamp keep any multi-preview `tool_run` row ≤ 262 144 B/msg |
| `tool_run` group payload | **≤ 262 144 B** (`TOOL_RUN_MSG_HARD_MAX`) | Host clips/omits memorized previews (explicit `…` or static label) rather than overflowing the ring/cloud per-msg cap |
| JSON end-of-turn toolTrace lines | **none** | All entries shown; level-2 detail stays the one-line `summary` (parity) |
| Auto-continue per give-up | **1** (`AUTO_CONTINUE_PER_GIVE_UP`) | Host one-shot after classified recoverable bookkeeping give-up. Queue / pending submit / running envelope win. Flag migrates across `sess_*` → UUID mint-bind. Host SSE retry 5 / 1 after paint is **unchanged** (same POST). |
| Stream write latch | **immediate** on PUT reject | Workflows user-stream PUT 5xx / 429 / timeout latch the held writer dead; later tokens no-op. SDK `STREAM_RETRY_OPTIONS` retries **429** inside the first `write()`. No in-process second PUT (4.8.4 sink is sticky after reject). AbortError is never latched. |
| Durable-turn wall clock | **1 hour** (`TURN_WALL_CLOCK_MAX_MS`, plan #923 — Bjorn-authorized) | Hard cap enforced inside the Workflow step VM: the `'use workflow'` entry derives a deterministic `deadlineAt` from `getWorkflowMetadata().workflowStartedAt` + this value; the loop checks step boundaries and each `'use step'` rebuilds an `AbortSignal.timeout(remaining)` per attempt (model round **and** tool batch), so a long/retried model round or stacked serial tool waves abort AT the deadline. Wrap-up (**wall fold only**) is 1h-exempt but bounded by `deadlineAt + TURN_WALL_CLOCK_WRAPUP_MAX_MS` (5 min) + `reasoning: 'none'` — the 512-step wrap-up does not inherit this bound, but it **does** still carry the 1h `deadlineAt` signal. When both caps fire, **wall wins**. Cap exit = tools-off wrap-up + SSE `error` `turn wall clock exceeded`. Envelope `completed` is written after wrap-up (not before). The cap value is **code** — no env override. Env-comment-only seams (never enforcement): `TURN_WALL_CLOCK_DEADLINE_TTL_MS` (60 000, cache TTL) + `TURN_WALL_CLOCK_PROBE_EVERY_MS` (2 000, reserved status-slot probe cadence). |

## Deferred (not in stream contract yet)

- `step` events / step status strip  
- `POST /api/chat` SSE (agent stream is the product path)

## Where to change

| Concern | Path |
|---------|------|
| Event map / tool summary | `lib/agent/agentStream.ts` |
| streamText + reasoning option (production `/api/turns`) | `lib/agent/generateOneRound.ts`, `lib/agent/reasoningConfig.ts` |
| streamText + reasoning option (legacy `/api/agent`) | `lib/agent/runAgent.ts`, `lib/agent/reasoningConfig.ts` |
| Route SSE vs JSON | `app/api/agent/route.ts` |
| Logical cwd parse / default | `lib/agent/agentBody.ts`, `lib/sandbox/config.ts`, `lib/agent/workPath.ts` |
| Host consumer + collapse/caps | `lib/harnessChat.ts`, `lib/agentApi.ts` |
| Recoverable bookkeeping auto-continue | `lib/turnRecoverable.ts` (client-safe classifier; `_` folds to space so `code` and `error` match; turns-route tenant/attach 503 copies are intentionally not needles), `lib/harnessCanAutoContinue.ts`, `app/harness/HarnessHost.tsx` (one `'continue'` POST, `skipUserAppend`, `repostFollowUp` folded into the helper, mint-bind flag migrate) — **not** same-POST retry |
| Truncated / capped fold | `lib/agent/modelFinish.ts` (`isProviderRefusalFinish`: `content-filter` / `error` → SSE `error`; `length` is `done`; `TURN_WALL_CLOCK_ERROR`/`_WRAPUP`/`_WRAPUP_SYSTEM`), `lib/workflows/turnLoop.ts` (empty tools + refusal `finishReason` → SSE `error`; `length` → `done`; 512-step cap → wrap-up then `done`, not `step budget exhausted`; 1-hour wall cap → wall wrap-up then SSE `error` `turn wall clock exceeded`, `reason:'wall'`) |
| Durable-turn wall clock | `lib/sessionCloudCaps.ts` (`TURN_WALL_CLOCK_MAX_MS` + `TURN_WALL_CLOCK_WRAPUP_MAX_MS` + TTL/probe seams), `lib/workflows/turnDeadline.ts` (`deadlineSignal` / `isDeadlineElapsed` / `wrapUpDeadlineAt` / `combineAbortSignals`), `lib/workflows/turnWorkflow.ts` (`deadlineAt` from `getWorkflowMetadata().workflowStartedAt`), `lib/workflows/modelGenerateStep.ts` + `lib/agent/generateOneRound.ts` (deadline `AbortSignal`, wall wrap-up bound + `reasoning: 'none'` (`wrapUp === 'wall'` only; `wrapUp === 'steps'` still carries the 1h signal), `'wall_clock'` code on deadline abort), `lib/workflows/toolExecuteStep.ts` (whole-batch deadline gate + deadline signal + between-wave skip + `'wall_clock'`), `lib/workflows/turnLoop.ts` (wrap-up persist is the first `completed`; when both caps fire, wall wins; a steps wrap-up `'wall_clock'` is the wall terminal), `lib/workflows/turnLog.ts` (`invincible.turn.loop`) |
| Durable stream write | `lib/workflows/turnSseWrite.ts` (5xx/429/timeout latch immediately; SDK retries 429 inside the first `write()`; one held writer per model/tool burst; sparse `writeOnDefaultStream` for loop `done` / `error`) |
| Durable persist | `lib/workflows/persistStep.ts` (Blob JSON is `id` + `messages`, not `deltas`), `lib/agent/turnPersistSeam.ts` (trim oldest to 8 MiB), `lib/workflows/turnLoop.ts` (persist `{ok:false}` of **any** code continues the loop — never an SSE `error`). Persist oversize is **not** an SSE `error`. |
| Durable tool batch | `lib/workflows/toolExecuteStep.ts` (`{ calls }` — one step per model round; waves at `change_dir` / `meta_sandbox_switch` / `write_file` / `str_replace`; live `tool_result` on one held writer; `maxRetries = 0` so a timeout/kill cannot replay applied writes; 1-call infra throws retry in-process), `lib/workflows/toolWaves.ts`, `lib/workflows/turnLoop.ts` (persist once after the batch) |
| Workflows step logs | `lib/workflows/turnLog.ts`, `lib/workflows/modelGenerateStep.ts`, `lib/workflows/persistStep.ts` |
| Thinking paint | `native/harness/src/ui/thinking.zig` (protocol v8 kind) |
| Feature divide | [feature-divide.md](feature-divide.md) |
| System map | [architecture.md](architecture.md) |
