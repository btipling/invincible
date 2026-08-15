import { createProdServices } from '../../../../lib/di';
import { requireSessionUser } from '../../../../lib/tenancy/session';
import {
  resolveSessionStore,
  sessionKeyFor,
} from '../../../../lib/tenancy/harnessSessionsRedis';
import { isEnvelopeStore } from '../../../../lib/sessions/sessionStore';
import { isRedisSafeOpaqueId, STATUS_PROBE_MIN_INTERVAL_MS } from '../../../../lib/sessionCloudCaps';
import {
  formatGitStatusSlot,
  probeGitStatus,
  type GitStatusProbeResult,
} from '../../../../lib/agent/statusProbe';

export const runtime = 'nodejs';

/** Phase-1/2 DI: services wired at the composition root (module never constructs). */
const services = createProdServices();

/**
 * Per-instance rate clock for the git probe (plan #540). Vercel serverless has
 * NO global process clock — this Map is deliberately per-instance best-effort
 * (NOT a durable global lock; a second instance won't share it). The **host
 * cadence is the primary throttle**; this map only collapses a single-instance
 * hot loop / stale-tab refresh storm so one instance stops exec'ing sandbox git
 * turns on every request. Keyed by `userId:sandboxId`.
 */
const lastProbeAt = new Map<string, number>();
let lastProbeCache = new Map<string, GitStatusProbeResult>();

/**
 * Bound both per-instance maps (plan #540 Caps): a long-lived instance serving
 * many distinct `userId:sandboxId` combinations must not grow unbounded. When a
 * new key pushes the map past a generous cap, the oldest FIFO entry drops so
 * probe history stays bounded and only the hottest bind is served from cache.
 * Generous vs the realistic host cadence / distinct-bind count on one instance.
 */
const STATUS_PROBE_CACHE_MAX = 256;
function boundedSet<T>(m: Map<string, T>, key: string, value: T): Map<string, T> {
  m.set(key, value);
  if (m.size > STATUS_PROBE_CACHE_MAX) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
  return m;
}

/**
 * Redis-safe opaque id guard for the `?sandboxId=` query param (session-carry
 * ONLY, mirroring `app/api/sandboxes/route.ts` parseQuerySandboxId). The
 * **envelope `meta.activeSandboxId` wins**; this param is a carry never an
 * override. A PRESENT but invalid value is ignored (fall back to envelope) so a
 * corrupt host param can never target a stray bind. Returns `undefined` when
 * the param is absent/empty/invalid.
 */
function parseQuerySandboxIdCarry(raw: string | null): string | undefined {
  if (raw == null || raw === '') return undefined;
  return isRedisSafeOpaqueId(raw) ? raw : undefined;
}

/**
 * GET /api/harness/status — read-only git probe for the status bar git slot.
 *
 * Resolves the caller's active bind (envelope-authoritative: `meta.activeSandboxId`
 * wins over any `?sandboxId=` carry) and runs a bounded, argv-only, read-only git
 * probe at the bind workspace root. Returns `{ git: { branch?, sha?, dirty? } }`
 * without ever echoing bind secrets / base_url / token.
 *
 * Rate limit: server-side `STATUS_PROBE_MIN_INTERVAL_MS` per **instance**
 * (best-effort). Inside the window → `{ git: <cached>, rate_limited: true }`
 * (never 429-spam; the cached last value is returned).
 *
 * Fail-soft: no bind / non-git / probe error → `{ git: {} }` (git slot stays
 * empty; other slots unaffected). Read-only; never mutates Production.
 *
 * Auth edge: middleware matcher + in-route `requireSessionUser` (mirror
 * `/api/agent` / `/api/sandboxes`).
 */
export async function GET(req: Request): Promise<Response> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) {
    return sessionGate.response;
  }
  const userId = sessionGate.user?.id;
  if (!userId) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }

  const url = new URL(req.url);
  const requested = parseQuerySandboxIdCarry(url.searchParams.get('sandboxId'));

  // Resolve the active bind. The server envelope bind is authoritative; the
  // `?sandboxId=` param is only a Redis-safe carry to seed when the envelope
  // lacks a bind (mirror the route-B1 envelope-first precedence).
  let requestedSandboxId: string | undefined = requested;
  const sessionId = url.searchParams.get('sessionId');
  if (sessionId) {
    try {
      const tenantRes =
        await services.harnessSessionsRedis.resolveTenantIdForUser(userId);
      if (tenantRes.ok) {
        const storeRes = await resolveSessionStore();
        const store =
          storeRes.ok && isEnvelopeStore(storeRes.value)
            ? storeRes.value
            : undefined;
        if (store) {
          const envelope = await store.readEnvelope(
            sessionKeyFor(tenantRes.value, userId, sessionId),
          );
          const bound = envelope?.meta?.activeSandboxId;
          if (typeof bound === 'string' && bound) {
            requestedSandboxId = bound;
          }
        }
      }
    } catch {
      // Fail-open: fall back to the param carry / no override below.
    }
  }

  const resolved = await services.resolveSandbox.resolveAgentSandbox(
    userId,
    {},
    { ...(requestedSandboxId ? { requestedSandboxId } : {}), signal: req.signal },
  );
  if (!resolved.ok) {
    // Fail-soft: no usable bind → empty git slot (200, never a status 403 storm
    // on an informational probe; the host cadence just keeps the slot muted).
    return Response.json({ git: {} });
  }

  const key = `${userId}:${resolved.value.sandboxId}`;
  const now = Date.now();
  const last = lastProbeAt.get(key);
  let git: GitStatusProbeResult;
  let value: string;
  if (last != null && now - last < STATUS_PROBE_MIN_INTERVAL_MS) {
    // In the window: serve the cached last value (per-instance), never a new exec.
    // The formatted `value` is included here too — the host treats a
    // `rate_limited` 200 as KEEP-last, so omitting it would CLEAR the git slot
    // (pr #544 #1 Major L1+L9). Same wire both branches: `value` present when
    // the cached result has a branch/sha, absent only when git is empty.
    git = lastProbeCache.get(key) ?? {};
    value = formatGitStatusSlot(git);
    return Response.json({ git, rate_limited: true, ...(value ? { value } : {}) });
  }
  git = await probeGitStatus(resolved.value.client, req.signal);
  boundedSet(lastProbeAt, key, now);
  boundedSet(lastProbeCache, key, git);

  value = formatGitStatusSlot(git);
  return Response.json({ git, ...(value ? { value } : {}) });
}
