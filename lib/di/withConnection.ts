/**
 * Shared DI connection resolver (phase 1 — parent #438 / phase #440).
 *
 * Every I/O-owning tenancy module resolves its DB through this helper instead
 * of constructing a connection in its own body. Two mechanisms are injectable:
 *   1. `db`  — a live Drizzle handle the caller already owns (tests inject a
 *              shared engine; hot path — no connect, no close).
 *   2. `connect()` — an injectable provider that returns `{ db, close }` and
 *              owns the open; this helper calls `.close()` in `finally`.
 *
 * If neither is supplied, we fail loudly (explicit wiring error) rather than
 * silently opening a connection. The module body never calls
 * `createDbConnection()`/`client.end()`.
 */
import type { Db } from '../../db';

export type TenancyConnection = { db: Db; close: () => Promise<void> };

/**
 * The injectable connection seam for DB-backed modules.
 * Provide `db` (live handle) or `connect` (provider); never both required.
 */
export type ConnectionResolver = {
  db?: Db;
  connect?: () => Promise<TenancyConnection>;
};

export async function withConnection<T>(
  deps: ConnectionResolver,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  if (deps.db) {
    return fn(deps.db);
  }
  if (deps.connect) {
    const c = await deps.connect();
    try {
      return await fn(c.db);
    } finally {
      await c.close();
    }
  }
  throw new Error('missing dependency: provide db or connect');
}
