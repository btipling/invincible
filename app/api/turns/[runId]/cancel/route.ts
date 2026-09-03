/**
 * backend-agents G22 (#816) — `POST /api/turns/:runId/cancel`: the durable-turn
 * **server cancel** seam. Stop/Esc on an attached durable run cancels the
 * Workflow run route-side via `getRun(runId).cancel()` — this route never
 * enters the workflow, never adds a step, and never passes a signal/closure
 * into `start()`. The loop's existing `'cancelled'` status path (abort-signal
 * → `executeTool` → `'cancelled'` value → `fail('cancelled', …)` → terminal
 * persist + writable close) is the in-loop half and is unchanged.
 *
 * Mirrors `[runId]/stream` gate-for-gate:
 *  1. Auth (`requireSessionUser`) → 401 (middleware matcher + in-route dual).
 *  2. `sessionId` query REQUIRED + `isRedisSafeOpaqueId` → 400.
 *  3. Envelope read; `meta.turnRunId === runId` else **404** (no existence
 *     leak across sessions; never 403). Store unavailable / read throw → 503
 *     FAIL-CLOSED (the tenancy gate is the only owner check).
 *  4. `getRun(cleanRunId)` — absent → 404; `run.status` terminal
 *     (`completed|failed|cancelled`) → **409** with the terminal status in the
 *     body (idempotent no-op: the turn already ended; `run.cancel` NOT called).
 *  5. Live (`pending|running`) → `run.cancel()`. Cancel throw → fail-closed
 *     503 (never a partial cancel claim; the lost-race terminalizes-between-
 *     status-read-and-cancel case lands here and the host re-resolves via the
 *     attach/terminal event — never a false "cancelled").
 *  6. Accepted cancel → `overlayWorkerMeta` PATCH `turnStatus: 'cancelling'`
 *     (worker-owned key, copy-then-override, `updatedAt` strictly newer — the
 *     same LWW contract as the start route's running PATCH). `turnRunId` rides
 *     unchanged in the envelope per the B8 copy-forward contract (the PATCH
 *     only overrides `turnStatus`). The run's own terminal persist then owns
 *     the terminal status (`persistOverlayStatus` unchanged — a cancelled run
 *     still persists `'completed'`; `'cancelling'` is a host-held liveness
 *     state only, always superseded).
 *
 * C15 interplay: the start route's live-only 409 requires BOTH
 * `turnStatus ∈ {running, cancelling}` AND a non-terminal `getRun` status, so
 * a stale `'cancelling'` with a terminal/absent run never blocks the next
 * prompt.
 *
 * Per-run min-interval soft guard (`TURN_CANCEL_MIN_INTERVAL_MS`, NEW cap,
 * plan #816 Caps table): same Map+boundedSet shape as C15's start guard —
 * per-process, zero-I/O, keyed by `sessionId:runId` so an accepted cancel of
 * wr_1 cannot 429 Stop on wr_2 (adversarial-review #927 pass 8). The window
 * advances ONLY on an **accepted** cancel so a terminal 409 / ownership 404 /
 * 503 never burns it. Bounds `getRun`+PATCH write amplification from a hostile
 * repeat-Stop client on the **same** run.
 *
 * No body. The route never reads or writes the transcript, checkpoint, or
 * queue (Wasm FIFO + F21 mirror untouched).
 */
import { getRun } from 'workflow/api';
import { overlayWorkerMeta } from '../../../../../lib/agent/workerMetaOverlay';
import { createProdServices } from '../../../../../lib/di';
import {
  isRedisSafeOpaqueId,
  sanitizeTurnRunId,
  TURN_CANCEL_MIN_INTERVAL_MS,
} from '../../../../../lib/sessionCloudCaps';
import { isEnvelopeStore } from '../../../../../lib/sessions/sessionStore';
import {
  resolveSessionStore,
  sessionKeyFor,
} from '../../../../../lib/tenancy/harnessSessionsRedis';
import { requireSessionUser } from '../../../../../lib/tenancy/session';

export const runtime = 'nodejs';
export const maxDuration = 1800;

/** Composition root — all wiring constructed here, never in route body. */
const services = createProdServices();

/**
 * G22 per-process soft abuse guard — per-run (`sessionId:runId`), NOT global.
 * Same Map+boundedSet shape as the C15 start guard on `app/api/turns/route.ts`.
 * Key includes `runId` so an accepted cancel of wr_1 cannot 429 Stop on wr_2
 * (adversarial-review #927 pass 8). Same-run repeat-Stop still 429s. The window
 * advances ONLY on an accepted cancel — a terminal 409 / ownership 404 /
 * store-or-cancel 503 never burns it.
 */
const lastCancelAtMs = new Map<string, number>();
const TURN_CANCEL_CACHE_MAX = 256;

function boundedSet<T>(m: Map<string, T>, key: string, value: T): Map<string, T> {
  m.set(key, value);
  if (m.size > TURN_CANCEL_CACHE_MAX) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
  return m;
}

/** Workflow run statuses after which a cancel is an idempotent no-op. */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * POST /api/turns/:runId/cancel?sessionId=...
 *
 * Server-cancel one live durable run. Response:
 *  - 200 `{ runId, turnStatus: 'cancelling' }` on an accepted cancel
 *  - 400 invalid runId / missing-or-invalid sessionId
 *  - 401 auth failure
 *  - 404 run not found OR ownership mismatch (tenancy guard)
 *  - 409 `{ runId, status }` when the run is already terminal (idempotent no-op)
 *  - 429 repeat-Stop soft guard (window advances only on accepted cancel)
 *  - 503 fail-closed for tenant resolve / store unavailable / cancel throw
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<Response> {
  // Auth gate — same requireSessionUser as the stream route (dual gate with
  // the middleware matcher).
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) return sessionGate.response;
  const userId = sessionGate.user?.id;
  if (!userId) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }

  const { runId } = await params;

  // Validate runId against TURN_RUN_ID_MAX (A1 #795) — a bad URL param is a
  // client error (400), same as the stream route.
  const cleanRunId = sanitizeTurnRunId(runId);
  if (cleanRunId === undefined) {
    return Response.json({ error: 'Invalid runId' }, { status: 400 });
  }

  // Parse and sanitize sessionId — REQUIRED for tenancy-bound ownership
  // verification (same contract as the stream route).
  const rawSessionId = new URL(req.url).searchParams.get('sessionId');
  if (!rawSessionId) {
    return Response.json(
      { error: 'sessionId query parameter is required.' },
      { status: 400 },
    );
  }
  if (!isRedisSafeOpaqueId(rawSessionId)) {
    return Response.json(
      { error: 'Invalid sessionId.' },
      { status: 400 },
    );
  }
  const sessionId = rawSessionId; // type-narrowed by isRedisSafeOpaqueId

  // G22 429 min-interval guard — per-run soft abuse gate, zero I/O,
  // BEFORE any gate that may await (tenant resolve, envelope read, getRun).
  // Keyed by sessionId:runId so an accepted cancel of wr_1 cannot 429 Stop
  // on wr_2 (adversarial-review #927 pass 8). Advances only on an accepted
  // cancel below.
  const now = Date.now();
  const cancelWindowKey = `${sessionId}:${cleanRunId}`;
  const last = lastCancelAtMs.get(cancelWindowKey);
  if (last != null && now - last < TURN_CANCEL_MIN_INTERVAL_MS) {
    return Response.json(
      {
        error:
          'Too many cancel requests. Please wait before cancelling again.',
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil(TURN_CANCEL_MIN_INTERVAL_MS / 1000)),
        },
      },
    );
  }

  // Tenancy check — resolve tenant, read the session envelope, verify
  // envelope.meta.turnRunId matches the requested runId. FAIL-CLOSED (503)
  // when the store is unavailable or the read throws; mismatch/miss → 404
  // (never 403 — no existence leak across sessions).
  const tenantRes =
    await services.harnessSessionsRedis.resolveTenantIdForUser(userId);
  if (!tenantRes.ok) {
    return Response.json(
      { error: 'Unable to resolve tenant for run cancel.' },
      { status: 503 },
    );
  }
  const sessionKey = sessionKeyFor(tenantRes.value, userId, sessionId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let envelopeStore: any;
  try {
    const storeRes = await resolveSessionStore();
    if (!storeRes.ok || !isEnvelopeStore(storeRes.value)) {
      return Response.json(
        { error: 'Unable to cancel run (store unavailable).' },
        { status: 503 },
      );
    }
    envelopeStore = storeRes.value;
  } catch {
    return Response.json(
      { error: 'Unable to cancel run (store unavailable).' },
      { status: 503 },
    );
  }

  let storedUpdatedAt = 0;
  try {
    const envelope = await envelopeStore.readEnvelope(sessionKey);
    if (!envelope || envelope.meta?.turnRunId !== cleanRunId) {
      return Response.json(
        { error: `Run not found: ${cleanRunId}` },
        { status: 404 },
      );
    }
    storedUpdatedAt =
      typeof envelope.updatedAt === 'number' ? envelope.updatedAt : 0;
  } catch {
    return Response.json(
      { error: 'Unable to cancel run (store unavailable).' },
      { status: 503 },
    );
  }

  // Status truth gate — `getRun` absent → 404; terminal → 409 idempotent
  // no-op (run.cancel NOT called); live → cancel. Infra throw → 503
  // fail-closed (never a partial cancel claim).
  try {
    const run = getRun(cleanRunId);
    if (!(await run.exists)) {
      return Response.json(
        { error: `Run not found: ${cleanRunId}` },
        { status: 404 },
      );
    }
    const status = await run.status;
    if (TERMINAL_RUN_STATUSES.has(status)) {
      return Response.json(
        { runId: cleanRunId, status },
        { status: 409 },
      );
    }
    await run.cancel();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Unable to cancel run (fail closed): ${msg}` },
      { status: 503 },
    );
  }

  // Accepted cancel — advance the per-run soft-guard window (only an
  // accepted cancel burns it), then persist the host-held liveness marker.
  boundedSet(lastCancelAtMs, cancelWindowKey, Date.now());

  // G22 host-held `'cancelling'` marker: worker-owned `turnStatus` PATCH via
  // the B8 overlay seam. `turnRunId` rides unchanged (copy-forward). The
  // strictly-newer clock mirrors the start route's running PATCH so a host
  // PUT in the same millisecond can never self-conflict. A PATCH failure is
  // non-fatal: the run's own terminal persist owns the terminal status, and
  // C15's live-only 409 requires a non-terminal `getRun` status too, so a
  // stale marker can never block the next prompt.
  let cancelWarning: string | null = null;
  try {
    const cancellingRes = await overlayWorkerMeta({
      envelopeStore,
      key: sessionKey,
      patch: { turnStatus: 'cancelling' as const },
      updatedAt: Math.max(Date.now(), storedUpdatedAt + 1),
    });
    if (!cancellingRes.ok) {
      // Stable warning — code only, never the raw error (can carry Redis
      // host/port/connect strings via overlayWorkerMeta's toMessage paths).
      cancelWarning = `Cancelling PATCH did not persist (${cancellingRes.code})`;
    }
  } catch {
    // Stable warning — never interpolate err.message (can carry Redis details).
    cancelWarning = 'Cancelling PATCH failed to persist';
  }

  const headers: Record<string, string> = {
    'x-workflow-run-id': cleanRunId,
  };
  if (cancelWarning) {
    headers['x-workflow-run-warning'] = cancelWarning;
  }
  const body: { runId: string; turnStatus: 'cancelling'; warning?: string } = {
    runId: cleanRunId,
    turnStatus: 'cancelling',
  };
  if (cancelWarning) body.warning = cancelWarning;
  return Response.json(body, { headers });
}
