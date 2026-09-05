/**
 * backend-agents C14b (#835) + C15 (#809) — `POST /api/turns`: the durable-turn
 * START surface with abuse guards.
 *
 * Starts a Workflows `turnWorkflow` (B12 loop) run for one prompt and streams
 * its live SSE (or returns its `runId`). The route is a thin auth+body gate
 * that passes ONLY serializable values to `start()` — never closures, api keys,
 * or module-level resolver wiring (Vercel step VMs don't share the route's
 * module state).
 *
 * Step seams are re-resolved INSIDE each `'use step'` body from the serializable
 * `scope` arg. This is the production path — the route MUST NOT call
 * `setPersistSeamResolver` / `setToolWorldResolver` (those are test overrides).
 *
 * Tool schemas are assembled IN-STEP via the shared `assembleDurableToolWorld`
 * helper (same path for model + tool steps). The route MUST NOT pass a `tools`
 * dict — the model must see the same tools the execute step can run.
 *
 * Pre-`start()` gates (fail closed, never enqueue a doomed run):
 *  1. Auth (`requireSessionUser`) → 401
 *  2. `sessionId` required → 400
 *  3. 429 min-interval guard (C15) — per-session, zero-I/O, short-circuits
 *     before BYOK
 *  4. 409 in-flight guard (C15) — per-session, same-isolate dedup, zero-I/O
 *     before BYOK
 *  5. Tenant resolve → 503
 *  6. BYOK resolve → 4xx
 *  7. Envelope read → 409 durable-turn guard (C15) — live-only
 *     ('running'/'cancelling') **and** the bound Workflow run still exists with
 *     a non-terminal status (plan #842: missing/failed/cancelled run is not
 *     live — outage envelopes must not 409 forever); shares the existing
 *     envelope read; cross-isolate dedup (the in-flight guard above is
 *     same-isolate)
 *  8. Sandbox hard-deny → 403
 *
 * `inFlight` is set IMMEDIATELY after the `has()` check (zero-I/O, BEFORE any
 * gate that may await: tenant resolve, BYOK, envelope read, sandbox probe).
 * Cleared in a `finally` block on EVERY path (success, throw, or any early
 * return from a pre-start gate) so a retry can always proceed — the flag
 * never leaks. `lastStartAtMs` advances ONLY on a successful `start()` call —
 * 429/any-pre-start-gate-failure never burn the window.
 *
 * `turnRunId` is DERIVED in-workflow (`getWorkflowMetadata().workflowRunId`), so
 * the terminal persist's `turnRunId` equals the route-side `run.runId` (never
 * session id).
 *
 * Fail closed: `start` throw → 503, never a `/api/agent` fallback (source lock).
 * `maxDuration = 1800` reuses the `/api/agent` constant verbatim (no cap change).
 */
import { start, getRun } from 'workflow/api';
import { bodyForRun } from '../../../lib/agent/pipeRunReadable';
import { parseAgentBody } from '../../../lib/agent/agentBody';
import {
  resolveAgentReasoning,
  shouldFetchEffortCatalog,
} from '../../../lib/agent/reasoningConfig';
import { effortValuesForModel, getJoinedWindowMap } from '../../../lib/gateway/modelCatalog';
import {
  AGENT_STREAM_CONTENT_TYPE,
  wantsAgentStream,
} from '../../../lib/agent/agentStream';
import { overlayWorkerMeta } from '../../../lib/agent/workerMetaOverlay';
import {
  buildModelMessages,
  trimModelMessagesToBudget,
} from '../../../lib/agent/modelMessages';
import { renderSummaryRow } from '../../../lib/agent/compaction';
import { foldBudgetTokens } from '../../../lib/agent/contextBudget';
import { TURN_START_MIN_INTERVAL_MS, sanitizeTurnRunId, isRedisSafeOpaqueId } from '../../../lib/sessionCloudCaps';
import { mapByokResolveFailure } from '../../../lib/chatServer';
import { createProdServices } from '../../../lib/di';
import { requireSessionUser } from '../../../lib/tenancy/session';
import { resolveSessionStore } from '../../../lib/tenancy/harnessSessionsRedis';
import { isEnvelopeStore } from '../../../lib/sessions/sessionStore';
import { isObjectIdBoundTo } from '../../../lib/sessions/blobStore';
import { sessionKeyFor } from '../../../lib/tenancy/harnessSessionsRedis';
import { type ResolveAgentSandboxResult } from '../../../lib/tenancy/resolveSandbox';
import { turnWorkflow } from '../../../lib/workflows/turnWorkflow';

export const runtime = 'nodejs';
// Vercel Pro/Enterprise Fluid extended max is 1800s (30m) — same constant as
// app/api/agent/route.ts, reused verbatim (no cap change).
export const maxDuration = 1800;

/** Composition root — all wiring constructed here, never in route body. */
const services = createProdServices();

/**
 * C15 per-process soft abuse guards — per-session (`sessionId`), NOT global.
 * Survive one Vercel Function invocation — not a durable rate limit (Redis
 * out of scope for C15). Pattern matches `app/api/harness/status/route.ts`
 * (per-userid:sandboxid Map + boundedSet). Keyed by `sessionId` so tenant A's
 * turn never 429s a co-located tenant B on the same isolate.
 *
 * `lastStartAtMs` advances ONLY on a successful `start()` call — any
 * pre-start-gate-failure never burn the window.
 *
 * `inFlight` is set IMMEDIATELY after the `has()` check (zero-I/O, before
 * any gate that may await) and cleared in a `finally` block on EVERY path
 * (success, throw, or any early return) — a same-isolate dedup that catches
 * the actual double-click (two concurrent `fetch()` calls that both pass the
 * 429 gate).
 */
const lastStartAtMs = new Map<string, number>();
const inFlight = new Set<string>();
const TURN_START_CACHE_MAX = 256;

function boundedSet<T>(m: Map<string, T>, key: string, value: T): Map<string, T> {
  m.set(key, value);
  if (m.size > TURN_START_CACHE_MAX) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
  return m;
}

function boundedSetStr(s: Set<string>, key: string): Set<string> {
  s.add(key);
  if (s.size > TURN_START_CACHE_MAX) {
    const oldest = s.values().next().value;
    if (oldest !== undefined) s.delete(oldest);
  }
  return s;
}

function failClosed(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Unable to start durable turn (fail closed): ${msg}`;
}

/** Hard deny when resolve returned no client AND there is no soft-path fallback. */
function isHardSandboxDeny(
  res: ResolveAgentSandboxResult,
  httpAttachName: string | null,
): boolean {
  if (res.ok) return false;
  if (res.softContinue || res.selectionRequired) return false;
  if (httpAttachName) return false;
  return true;
}

/**
 * POST /api/turns — start one durable turn and stream/return its runId.
 *
 * Body { prompt: string, sessionId: string, modelId?: string }.
 * - `sessionId` REQUIRED → 400 (parseAgentBody treats it optional, but the
 *   persist seam needs a session scope to locate the envelope).
 * - SSE (`Accept: text/event-stream`) → `bodyForRun` (already-`cancelled`/
 *   `failed` is synthetic SSE without `getReadable()`; `running`/`completed`
 *   wrap `getReadable()`) + header.
 * - else → JSON `{ runId }` + `x-workflow-run-id` header.
 * - `start` throw → 503 fail-closed, no `/api/agent` fallback.
 *
 * The route passes ONLY serializable values to `start()`: `scope`, `modelId`,
 * `userMessage`, optional `persistRunBind`, optional `reasoning`. NO `tools` dict — tool schemas
 * are assembled in-step via the shared `assembleDurableToolWorld` helper.
 * Plan #944: a seeded `priorMessages` is trimmed to the model's window-derived
 * token budget (+ row/byte rails) at this boundary before `start()`.
 * Plan #949 (A4 phase 2): the seed prefers the compaction checkpoint
 * (`meta.compactionPointer` → `[renderSummaryRow(...), ...retainedTail]`,
 * re-validated + re-paired), falling back to `modelMessagesPointer`, then the
 * legacy `promptHistory` sidecar (locked fallback chain).
 */
export async function POST(req: Request): Promise<Response> {
  // Auth gate FIRST (mirrors app/api/agent/route.ts POST gate) — before any
  // persist wire / start.
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;
  const userId = sessionGate.user?.id;
  if (!userId) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      {
        error:
          'Invalid JSON body. Expected { sessionId: string, prompt: string, modelId?: string }.',
      },
      { status: 400 },
    );
  }

  const parsed = parseAgentBody(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }
  // parseAgentBody treats `sessionId` as optional → an explicit 400 guard: the
  // persist seam requires a session scope (plan lock).
  if (parsed.sessionId === undefined) {
    return Response.json(
      { error: 'sessionId is required for durable turns.' },
      { status: 400 },
    );
  }
  const sessionId = parsed.sessionId;

  // C15 429 min-interval guard — per-session soft abuse gate, zero I/O.
  // Short-circuits BEFORE the BYOK resolve (an expensive DB query) so a
  // spammer gets a cheap 429 instead of a DB-backed reject. Keyed by
  // `sessionId` so tenant A's turn never 429s a co-located tenant B.
  const now = Date.now();
  const last = lastStartAtMs.get(sessionId);
  if (last != null && now - last < TURN_START_MIN_INTERVAL_MS) {
    return Response.json(
      {
        error:
          'Too many turn start requests. Please wait before starting another turn.',
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(TURN_START_MIN_INTERVAL_MS / 1000)),
        },
      },
    );
  }

  // C15 in-flight guard — per-session dedup for concurrent POSTs on the
  // same isolate. The flag is SET IMMEDIATELY after the `has()` check (zero
  // I/O, before any gate that may await: tenant resolve, BYOK, envelope read,
  // sandbox probe). A concurrent POST for the same session on this isolate
  // sees the flag and gets 409. Cleared in a `finally` block on EVERY path
  // (success, throw, or any early return from a pre-start gate) so a retry
  // can always proceed — the flag never leaks.
  if (inFlight.has(sessionId)) {
    return Response.json(
      { error: 'A turn is already being started for this session.' },
      { status: 409 },
    );
  }
  boundedSetStr(inFlight, sessionId);

  // Pre-start sandbox probe client — closed after start() succeeds OR on throw.
  // Mirrors /api/agent closeRunners (extendTimeout + drop handle, never stop).
  // Only populated when resolveAgentSandbox returns {ok:true}. Hard-deny
  // ({ok:false}) never opens a client so nothing to close there. Success
  // attach ({ok:true}) DOES open a client regardless of HTTP attach — it is
  // still captured here and closed on the success/throw paths below.
  let sandboxProbeClient: { close?: () => Promise<void> } | undefined;

  try {
    // Session scope for the persist seam + tool world (tenant resolved server-side).
    const tenantRes =
      await services.harnessSessionsRedis.resolveTenantIdForUser(userId);
    if (!tenantRes.ok) {
      return Response.json(
        { error: 'Unable to resolve tenant for the durable turn.' },
        { status: 503 },
      );
    }
    const scope = { tenantId: tenantRes.value, userId, sessionId };

    // Confused-deputy guard for a seed pointer (plan #949 / #936 rule): a
    // seed pointer is usable only when it is a non-empty string re-bound to
    // THIS session scope. Returns the pointer or `undefined` — the narrow
    // form the seed block branches on (a truthy return IS the bound pointer).
    const boundSeedPointer = (pointer: unknown): string | undefined =>
      typeof pointer === 'string' &&
      pointer &&
      isObjectIdBoundTo(pointer, scope)
        ? pointer
        : undefined;

    // 1. BYOK resolve — fail closed BEFORE start (never enqueue a doomed run).
    const byok = await services.resolveInferenceForRequest.resolveByokForRequest(
      userId,
      parsed.modelId,
    );
    if (!byok.ok) {
      const { status, error } = mapByokResolveFailure(byok.reason);
      return Response.json({ error }, { status });
    }

    // Kick the catalog GET now so it overlaps envelope + sandbox probe.
    // Skip only when the body token is already on the Gateway wire enum
    // (it wins the resolver). `max` still fetches so coerce can pick
    // xhigh (rewritten catalog) vs high (empty-catalog last-ditch).
    const catalogPromise = shouldFetchEffortCatalog(parsed.reasoning)
      ? effortValuesForModel(byok.modelId)
      : Promise.resolve([] as string[]);

    // Plan #944: resolve the model's context window at the ROUTE boundary
    // (never inside a `'use step'`) so the seeded `priorMessages` can be
    // trimmed to the window-derived token budget before `start()`. Fail-open
    // to an empty map → the conservative default window (never a lie, never
    // a fabricated large number). Rides the same TTL/negative-cache catalog.
    const windowPromise = getJoinedWindowMap();

    // 2. Resolve the envelope store + session key once — reused for the
    //    persistRunBind read (B13 fallback) AND the post-start running PATCH
    //    (C14d). A store resolve error is best-effort: no bind / no PATCH, but
    //    the turn still starts.
    const sessionKey = sessionKeyFor(tenantRes.value, userId, sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let envelopeStore: any = null;
    let persistRunBind: { cwd?: string; activeSandboxId?: string } | undefined;
    // Plan #941: the per-turn freshness-reminder pointer (sanitize-only; the
    // model step reads the Blob in-step). Undefined = no prior reminder.
    let freshnessReminderPointer: string | undefined;
    // B13 strictly-newer overlayClock base: capture the stored envelope's
    // `updatedAt` so the post-start running PATCH can compute a strictly-newer
    // clock (`max(now, stored+1)`) — same construction as createTurnPersistSeam
    // default (lib/agent/turnPersistSeam.ts:122-124). A bare `Date.now()` can
    // be <= the stored clock (host PUT same-ms or browser clock ahead of server)
    // → B8 rejects with lww_conflict → running marker never lands.
    let storedUpdatedAt = 0;
    // Plan #936 (source #549): the seeded model-messages projection read from
    // the session-bound Blob object pointed to by `meta.modelMessagesPointer`.
    // Fail-closed: an unreadable / unbound / missing / malformed projection is
    // treated as "no pointer" (legacy roll-forward turn), never a 5xx.
    let priorMessages: unknown[] | undefined;
    try {
      const storeRes = await resolveSessionStore();
      if (storeRes.ok && isEnvelopeStore(storeRes.value)) {
        envelopeStore = storeRes.value;
        const envelope = await envelopeStore.readEnvelope(sessionKey);
        if (envelope) {
          // C15 409 duplicate-turn guard — live-only: reject when a turn is
          // already 'running' or 'cancelling' for this session AND the bound
          // Workflow run still exists in a non-terminal status (plan #842).
          // Shares the existing envelope read (no second envelope round-trip).
          const turnStatus = envelope.meta?.turnStatus;
          if (turnStatus === 'running' || turnStatus === 'cancelling') {
            const cleanRunId = sanitizeTurnRunId(envelope.meta?.turnRunId);
            if (!cleanRunId) {
              return Response.json(
                { error: 'A turn is already in progress for this session.' },
                { status: 409 },
              );
            }
            try {
              const prior = getRun(cleanRunId);
              if (await prior.exists) {
                const wfStatus = await prior.status;
                const terminal =
                  wfStatus === 'completed' ||
                  wfStatus === 'failed' ||
                  wfStatus === 'cancelled';
                if (!terminal) {
                  return Response.json(
                    { error: 'A turn is already in progress for this session.' },
                    { status: 409 },
                  );
                }
              }
              // exists === false or terminal status → not live; allow start.
            } catch (err) {
              return Response.json({ error: failClosed(err) }, { status: 503 });
            }
          }

          storedUpdatedAt = typeof envelope.updatedAt === 'number' ? envelope.updatedAt : 0;
          if (typeof envelope.meta?.logicalCwd === 'string' && envelope.meta.logicalCwd) {
            persistRunBind = { ...persistRunBind, cwd: envelope.meta.logicalCwd };
          }
          if (typeof envelope.meta?.activeSandboxId === 'string' && envelope.meta.activeSandboxId) {
            persistRunBind = { ...persistRunBind, activeSandboxId: envelope.meta.activeSandboxId };
          }

          // Plan #936: seed the orchestrator from the persisted model-messages
          // projection. Read the bound Blob object while the envelope is in
          // hand (same pre-start read). confused-deputy guard: the pointer must
          // re-bind to THIS session scope. Any failure → no seed (legacy fold
          // IFF the host still sent `promptHistory`). Adversarial-review #937
          // Major: GET overlay sidecar-stops without reading this sibling Blob,
          // so a bound miss + no sidecar must not start a history-less turn.
          //
          // Plan #949 (A4 compaction phase 2) — seed preference is LOCKED:
          // compactionPointer → modelMessagesPointer → legacy `promptHistory`
          // sidecar. The compaction checkpoint (`{summary, filesTouched,
          // retainedTail}`, written by the persist seam when a compaction ran)
          // is preferred: the route re-validates the shape + re-pairs the
          // retained tail via `buildModelMessages` and seeds
          // `[renderSummaryRow(...), ...retainedTail]` — the honesty-labeled
          // summary row rides FIRST (a `user` row, never live assistant
          // prose; parent #947 Goal 4). A malformed/unbound/missing
          // checkpoint falls through to `modelMessagesPointer` (the #936
          // path below); when a bound pointer exists but NO seed is
          // readable and the host sent no `promptHistory`, the #937
          // fail-closed 503 still applies (shared across both pointers).
          // Same DI surface — `services.createBlobTranscriptStore()` (the
          // #936 read), never a new seam.
          const cpPointer = boundSeedPointer(envelope.meta?.compactionPointer);
          const mmPointer = boundSeedPointer(envelope.meta?.modelMessagesPointer);
          if (cpPointer) {
            try {
              const blobStore = services.createBlobTranscriptStore();
              const raw = await blobStore.read(cpPointer);
              if (raw !== null) {
                const parsedCheckpoint: unknown = JSON.parse(raw);
                // Checkpoint shape lock (#948 `CompactionCheckpoint`): a
                // planted/hostile body that is not `{summary: string,
                // filesTouched: string[], retainedTail: unknown[]}` is not a
                // checkpoint — fall through to the model-messages seed
                // (plan fallback chain), never a partial/honesty-less seed.
                if (
                  parsedCheckpoint !== null &&
                  typeof parsedCheckpoint === 'object' &&
                  !Array.isArray(parsedCheckpoint)
                ) {
                  const o = parsedCheckpoint as Record<string, unknown>;
                  if (
                    typeof o.summary === 'string' &&
                    Array.isArray(o.filesTouched) &&
                    Array.isArray(o.retainedTail)
                  ) {
                    // Rebuild (re-pair + caps) the retained tail so a
                    // planted/stale blob cannot seed an unpaired
                    // tool-result at a strict provider (adversarial #937;
                    // the checkpoint tail is already re-paired at build
                    // time — this is the read-side re-validation lock).
                    const tail = buildModelMessages(o.retainedTail).rows;
                    const seed = [
                      renderSummaryRow(
                        o.summary,
                        o.filesTouched.filter((p): p is string => typeof p === 'string'),
                      ),
                      ...tail,
                    ];
                    // Plan #944 / adversarial #945: trim the seed to the
                    // model's window-derived token budget (+ row/byte
                    // rails) at the route boundary — drop oldest, re-pair.
                    // The current ask is `parsed.prompt` (appended after
                    // the seed as userMessage); it is counted in the token
                    // rail so history yields to it. The summary row is the
                    // OLDEST row in this seed — an extreme rail miss may
                    // drop it (its content is duplicated inside the
                    // checkpoint's baked-in overflow marker, and the
                    // honesty lock holds: what survives is never framed
                    // as live prose).
                    const windowMap = await windowPromise;
                    priorMessages = trimModelMessagesToBudget(
                      seed,
                      foldBudgetTokens(windowMap, byok.modelId),
                      { currentUserContent: parsed.prompt },
                    ).rows;
                  }
                }
              }
            } catch {
              // Fail-closed: unreadable/missing/malformed checkpoint →
              // fall back (modelMessagesPointer, then legacy sidecar).
              priorMessages = undefined;
            }
          }
          if (priorMessages === undefined && mmPointer) {
            try {
              const blobStore = services.createBlobTranscriptStore();
              const raw = await blobStore.read(mmPointer);
              if (raw !== null) {
                const parsedProjection: unknown = JSON.parse(raw);
                if (Array.isArray(parsedProjection)) {
                  // Rebuild (re-pair + caps) so a planted/stale blob cannot
                  // seed an unpaired tool-result at a strict provider
                  // (adversarial-review #937).
                  const built = buildModelMessages(parsedProjection).rows;
                  // Plan #944 / adversarial #945: trim the seed to the
                  // model's window-derived token budget (+ row/byte rails)
                  // at the route boundary — drop oldest, re-pair. The
                  // current ask is `parsed.prompt` (appended after the
                  // seed as userMessage), not the newest seed row; it is
                  // counted in the token rail so history yields to it.
                  const windowMap = await windowPromise;
                  priorMessages = trimModelMessagesToBudget(
                    built,
                    foldBudgetTokens(windowMap, byok.modelId),
                    { currentUserContent: parsed.prompt },
                  ).rows;
                }
              }
            } catch {
              // Fail-closed: unreadable/missing/malformed projection → no seed.
              priorMessages = undefined;
            }
          }
          if (
            priorMessages === undefined &&
            (cpPointer || mmPointer) &&
            parsed.promptHistory === undefined
          ) {
            return Response.json(
              {
                error:
                  'Unable to read the model-messages seed for this session (fail closed).',
              },
              { status: 503 },
            );
          }
          // Plan #941: the per-turn freshness-reminder pointer — sanitize-only
          // pass-through (Redis-safe opaque shape). The route NEVER reads the
          // Blob: the model step resolves + reads the reminder in-step
          // (fail-open), mirroring the #936 seed. Binding is re-enforced
          // in-step via isObjectIdBoundTo; a poisoned value here just omits
          // the arg (advisory memory, never a 5xx).
          const frPointerRaw = envelope.meta?.freshnessReminderPointer;
          if (typeof frPointerRaw === 'string' && isRedisSafeOpaqueId(frPointerRaw)) {
            freshnessReminderPointer = frPointerRaw;
          }
        }
      }
    } catch {
      // Fail-open: no bind → steps use defaults; no running PATCH.
    }

    // 3. Pre-start sandbox hard-deny gate — match `/api/agent`'s fail-closed-
    //    before-enqueue pattern (same as BYOK above). Resolve the sandbox from
    //    the envelope bind and fail 403 on hard deny BEFORE `start()`, so a
    //    doomed run is never enqueued. Soft-path (softContinue / selectionRequired
    //    / HTTP attach running) still proceeds.
    let ghToken: string | undefined;
    try {
      const gh = await services.userGithubToken.decryptUserGithubTokenForServer(
        userId,
      );
      if (gh.ok && gh.value) {
        ghToken = gh.value;
      }
    } catch {
      // Fail-open: no GH token → no exec env.
    }

    let httpAttachName: string | null = null;
    try {
      const loaded = await services.userSandboxInstance.loadInstance(
        userId,
        'http',
      );
      if (
        loaded.ok &&
        loaded.value &&
        loaded.value.status === 'running' &&
        loaded.value.vercelName?.trim()
      ) {
        httpAttachName = loaded.value.vercelName.trim();
      }
    } catch {
      // Fail-open: no HTTP instance → no HTTP tools.
    }

    const sandboxResolved =
      await services.resolveSandbox.resolveAgentSandbox(
        userId,
        {
          ...(ghToken
            ? { execEnv: { GH_TOKEN: ghToken, GITHUB_TOKEN: ghToken } }
            : {}),
        },
        {
          ...(persistRunBind?.activeSandboxId
            ? { requestedSandboxId: persistRunBind.activeSandboxId }
            : {}),
        },
      );

    // Capture the probe client now — must be closed after start() or on throw.
    if (sandboxResolved.ok) {
      sandboxProbeClient = sandboxResolved.value.client;
    }

    if (isHardSandboxDeny(sandboxResolved, httpAttachName)) {
      // Hard deny: no client + no soft-path surface → 403 before enqueue.
      // isHardSandboxDeny guarantees ok:false here — narrow for TS.
      if (!sandboxResolved.ok) return sandboxResolved.response;
    }

    // The single durable loop entry. `turnRunId` is derived in-workflow from
    // getWorkflowMetadata().workflowRunId — never passed as a start() arg.
    // NO `tools` dict — tool schemas are assembled in-step via the shared
    // `assembleDurableToolWorld` helper, so the model sees the same tools
    // the execute step can run.
    const options = await catalogPromise;
    const reasoning = resolveAgentReasoning(byok.modelId, {
      request: parsed.reasoning,
      options,
    });
    // Plan #936 / #949: when a readable seed (compaction checkpoint preferred,
    // then model-messages projection) seeded `priorMessages`, the model gets
    // structured history and `userMessage` is the RAW prompt. When neither
    // pointer seeded (legacy session), the roll-forward turn uses the host's
    // `promptHistory` fold (today's folded `prompt` value moved to an optional
    // field) falling back to the raw prompt when the host didn't send one.
    const userMessage =
      priorMessages !== undefined
        ? parsed.prompt
        : (parsed.promptHistory ?? parsed.prompt);
    const run = await start(turnWorkflow, [
      {
        userMessage,
        modelId: byok.modelId,
        scope,
        ...(persistRunBind ? { persistRunBind } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(priorMessages !== undefined ? { priorMessages } : {}),
        ...(freshnessReminderPointer !== undefined
          ? { freshnessReminderPointer }
          : {}),
      },
    ]);

    // C15: advance the per-session clock ONLY on a successful start() —
    // any-pre-start-gate-failure never burn the window.
    boundedSet(lastStartAtMs, sessionId, Date.now());

    // Close the probe client now that the run is enqueued. The in-step
    // assemble helper opens its OWN client per step VM — this probe was
    // only for the hard-deny gate.
    if (sandboxProbeClient?.close) {
      try {
        await sandboxProbeClient.close();
      } catch {
        // Ignore close errors — the turn is already enqueued.
      }
    }

    // C14d — post-start durable `running` marker: persist turnRunId +
    // turnStatus='running' via the B8 overlay seam immediately after start()
    // returns, BEFORE the route returns the stream/runId. This is a SEPARATE
    // write from the terminal B13 seam (which writes `completed`). Clock uses
    // the SAME strictly-newer construction as B13's createTurnPersistSeam:
    // `max(now, storedUpdatedAt + 1)` so it can NEVER self-conflict with a
    // host PUT in the same millisecond or a browser clock ahead of the server.
    let runWarning: string | null = null;
    if (envelopeStore) {
      try {
        const runningPatch = {
          turnRunId: run.runId,
          turnStatus: 'running' as const,
        };
        const runningRes = await overlayWorkerMeta({
          envelopeStore,
          key: sessionKey,
          patch: runningPatch,
          updatedAt: Math.max(Date.now(), storedUpdatedAt + 1),
        });
        if (!runningRes.ok) {
          // Stable warning — code only, never the raw error (can carry Redis
          // host/port/connect strings via overlayWorkerMeta's toMessage paths).
          runWarning = `Running PATCH did not persist (${runningRes.code})`;
        }
      } catch (err) {
        // Stable warning — never interpolate err.message (can carry Redis details).
        runWarning = `Running PATCH failed to persist`;
      }
    }

    const runHeaders: Record<string, string> = {
      'x-workflow-run-id': run.runId,
    };
    if (runWarning) {
      runHeaders['x-workflow-run-warning'] = runWarning;
    }
    if (wantsAgentStream(req)) {
      return new Response(await bodyForRun(run), {
        status: 200,
        headers: {
          'content-type': AGENT_STREAM_CONTENT_TYPE,
          ...runHeaders,
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }
    const body: { runId: string; warning?: string } = { runId: run.runId };
    if (runWarning) body.warning = runWarning;
    return Response.json(body, { headers: runHeaders });
  } catch (err) {
    // Close the probe client (if it was opened before the throw).
    if (sandboxProbeClient?.close) {
      try {
        await sandboxProbeClient.close();
      } catch {
        // Ignore close errors.
      }
    }
    return Response.json({ error: failClosed(err) }, { status: 503 });
  } finally {
    // Clear the in-flight flag on EVERY path — success, throw, or any early
    // return from a pre-start gate (tenant 503, BYOK 4xx, durable 409,
    // sandbox 403). The flag was set immediately after the `has()` check so
    // no path can leak it.
    inFlight.delete(sessionId);
  }
}
