/**
 * Phase 2 (#414) — server-only wiring for the id-shaped `/api/sessions*` surface.
 *
 * Owns the seam between the route handlers and the Phase 1 store
 * (`lib/sessions/sessionStore.ts` / `redisSessionStore.ts`):
 *  - derive the caller's tenant via `loadSoleMembership` (server-derived, never
 *    client input — no `requireTenant` helper exists in this repo);
 *  - construct the Redis `ServerSessionStore` (or a test-injected store);
 *  - provide the stable "unavailable / tenancy-off" error surface the host
 *    already treats as disabled.
 *
 * **Server-only.** Never import from client/Wasm code.
 *
 * Note: the plan (#414) originally said "tenancy off → 404 + `CLOUD_SESSION_DISABLED`",
 * but that contract was deliberately dropped from live code; we return **503** +
 * `SESSION_STORE_UNAVAILABLE` instead (the client `sessionRepository` treats any
 * non-2xx as disabled/error).
 */
import {
  type HarnessSessionRecord,
  type ServerSessionStore,
  type SessionListScope,
  type SessionRecordKey,
} from '../sessions/sessionStore';
import { RedisSessionStore } from '../sessions/redisSessionStore';
import { loadSoleMembership } from './soleMembership';

/** Stable error code when the session store cannot be used (unconfigured / unavailable). */
export const SESSION_STORE_UNAVAILABLE = 'SESSION_STORE_UNAVAILABLE';
/** Stable error code when the signed-in user has no resolvable tenant membership. */
export const NO_TENANT = 'NO_TENANT';

export type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };

/** Error response body + status for the routes. */
export function unavailableResponse(code: string, error: string): Response {
  return Response.json({ error, code }, { status: 503 });
}

/**
 * Test seam — inject a store to use for `resolveSessionStore()` calls.
 *
 * Lives on `globalThis` (a `Symbol.for` key) so it survives `vi.resetModules()`
 * (which clears the module cache in route tests) and is shared across the fresh
 * module instances those tests re-import. Cleared with `null` in `afterEach`.
 * Never removes the real env-driven Redis construction from the normal path.
 */
const STORE_OVERRIDE = Symbol.for('invincible.sessions.storeOverride');

export function setSessionStoreForTests(store: ServerSessionStore | null): void {
  const g = globalThis as unknown as Record<symbol, ServerSessionStore | null>;
  if (store) g[STORE_OVERRIDE] = store;
  else delete g[STORE_OVERRIDE];
}

function constructStore(): ServerSessionStore {
  const g = globalThis as unknown as Record<symbol, ServerSessionStore | null>;
  const override = g[STORE_OVERRIDE];
  if (override) return override;
  // Reads REDIS_URL (RESP wire format) and throws when Redis is not configured —
  // resolved to a 503 by the caller.
  return new RedisSessionStore();
}

export async function resolveSessionStore(): Promise<ServiceResult<ServerSessionStore>> {
  try {
    return { ok: true, value: constructStore() };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, code: SESSION_STORE_UNAVAILABLE, error: m };
  }
}

/**
 * Resolve the tenant id for a signed-in user. Tenant scoping is always server
 * derived via `loadSoleMembership` — never from a client request body/header.
 */
export async function resolveTenantIdForUser(
  userId: string,
): Promise<ServiceResult<string>> {
  const membership = await loadSoleMembership(userId);
  if (!membership.ok) {
    if (membership.reason === 'db' || membership.reason === 'ambiguous') {
      return {
        ok: false,
        code: SESSION_STORE_UNAVAILABLE,
        error: 'tenant membership lookup failed',
      };
    }
    return { ok: false, code: NO_TENANT, error: 'no sole tenant membership' };
  }
  return { ok: true, value: membership.tenantId };
}

/** Caller-scoped list key for a user within their tenant. */
export function sessionScopeFor(
  tenantId: string,
  userId: string,
): SessionListScope {
  return { tenantId, userId };
}

/** Caller-scoped record key. Ownership/identity is always the authed user. */
export function sessionKeyFor(
  tenantId: string,
  userId: string,
  sessionId: string,
): SessionRecordKey {
  return { tenantId, userId, sessionId };
}

/** Strip a full record to the lightweight list summary the list route returns. */
export function toSessionSummary(
  record: HarnessSessionRecord,
): { id: string; createdAt: number; updatedAt: number; title: string | null } {
  const title =
    typeof record.meta.title === 'string' && record.meta.title.length > 0
      ? record.meta.title
      : null;
  return { id: record.id, createdAt: record.createdAt, updatedAt: record.updatedAt, title };
}
