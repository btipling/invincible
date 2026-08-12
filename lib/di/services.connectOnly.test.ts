/**
 * Connect-only proof for the composition root (phase 1 — #440).
 *
 * The Major concern from the #442 adversarial review: factories wired with
 * `createProdServices({ connect })` must be able to complete *nested* calls
 * that internally resolve `loadSoleMembership` (e.g. user github token / MCP /
 * preferred-sandbox / sandbox-instance). Those nested lookups used to forward
 * only `{ db: deps.db }`, which is undefined on the connect-only prod path —
 * dropping `connect` and turning every membership lookup into a firm
 * `unavailable`. If `connect` were dropped entirely, `withConnection` would
 * throw "missing dependency" and the flow would fall over to `unavailable`.
 *
 * This suite drives the real composition root *without any real database*:
 * the injected `connect` returns a lightweight in-memory fake `db` that only
 * answers the exact query shapes the tested flows issue. It proves the DI
 * wiring (that nested `connect` is forwarded and actually used) without
 * cold-booting PGlite, replaying migrations, or reseeding tables. Real SQL
 * semantics for each flow are already covered by the dedicated tenancy
 * PGlite suites (soleMembership / userPreferredSandbox / userGithubToken …).
 * The shared test engine for those real-DB suites is owned by `#431`/`#441`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProdServices } from './index';
import { wrapTenantDek } from '../tenancy/tenantKeys';
import type { RedisClientLike } from '../sessions/redisSessionStore';

const AMK = Buffer.alloc(32, 42);
const DEK = Buffer.alloc(32, 7);

const TENANT = 'tenant-0001';
const ADMIN_USER = 'admin-0001';
const MEMBER_USER = 'member-0001';
const SANDBOX = 'sandbox-0001';

type Row = Record<string, unknown>;
type RowState = Record<string, Row[]>;

/** Extract a drizzle pgTable's storage name (stored on a global symbol). */
function tableName(table: unknown): string {
  const t = table as { [key: symbol]: unknown };
  const viaSymbol = t[Symbol.for('drizzle:Name')];
  if (typeof viaSymbol === 'string') return viaSymbol;
  const tName = (table as { name?: unknown }).name;
  if (typeof tName === 'string') return tName;
  throw new Error('unrecognised drizzle table in connect-only fake db');
}

/**
 * In-memory row store keyed by drizzle table pipe name (e.g. `tenant_members`).
 * `membership` is the sole-membership row expected for the flow under test —
 * the fake does not apply WHERE predicates, so the store holds exactly the
 * (single) membership the flow should resolve. Real filter/join semantics are
 * covered by the tenancy PGlite suites; this suite only proves connect wiring.
 */
function seedState(membership: Row[]): RowState {
  return {
    tenants: [
      { id: TENANT, dekCiphertext: wrapTenantDek(DEK, AMK), dekVersion: 1 },
    ],
    tenant_members: membership,
    user_preferred_sandbox: [],
    sandbox_grants: [
      {
        sandboxId: SANDBOX,
        name: 'Workspace',
        slug: 'workspace',
        backend: 'vercel',
        status: 'active',
        image: null,
        canRead: true,
        canWrite: true,
      },
    ],
    user_github_tokens: [],
    user_mcp_servers: [],
    user_sandbox_instances: [],
  };
}

/**
 * A tiny in-memory `db` double serving the select/transaction/insert surface
 * the connect-only flows use. Queries are routed by the table pipe name passed
 * to `.from(...)`; selection columns are ignored because the modules only read
 * known fields off the returned rows. `.where/.limit/.for/.innerJoin` are
 * passthroughs resolving to the same row set — enough to prove wiring, not SQL.
 */
function buildFakeDb(state: RowState) {
  const rowsFor = (table: unknown) => state[tableName(table)] ?? [];

  const query = (table: unknown) => {
    const pending = Promise.resolve(rowsFor(table));
    return {
      then: pending.then.bind(pending),
      catch: pending.catch.bind(pending),
      finally: pending.finally.bind(pending),
      where: () => query(table),
      limit: () => query(table),
      for: () => query(table),
      innerJoin: () => query(table),
    };
  };

  const makeDb = {
    select: () => ({ from: (table: unknown) => query(table) }),
    insert: (table: unknown) => ({
      values: (rows: Row | Row[]) => {
        const list = Array.isArray(rows) ? rows : [rows];
        const t = tableName(table);
        return {
          onConflictDoUpdate: () => {
            // No-op upsert: persist rows for later reads (github-token round-trip).
            if (t === 'user_github_tokens' && list[0]) {
              const existing = state[t].find((r) => r.userId === list[0]?.userId);
              if (existing) Object.assign(existing, list[0]);
              else state[t].push(list[0]);
            }
            return Promise.resolve();
          },
          returning: () => Promise.resolve(list),
        };
      },
    }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(makeDb),
  };

  return makeDb;
}

describe('createProdServices connect-only (no real DB, injected connect)', () => {
  let state: RowState;
  let connectCalls: number;

  beforeEach(() => {
    state = seedState([{ userId: MEMBER_USER, tenantId: TENANT, role: 'member' }]);
    connectCalls = 0;
  });

  /** Wire the whole production root to the fake connect; no bare `db` anywhere. */
  const services = () =>
    createProdServices({
      connect: async () => {
        connectCalls += 1;
        return {
          db: buildFakeDb(state) as never,
          close: async () => {},
        };
      },
    });

  it('soleMembership resolves through connect alone', async () => {
    const res = await services().soleMembership.loadSoleMembership(MEMBER_USER);
    expect(res).toEqual({ ok: true, tenantId: TENANT, role: 'member' });
    expect(connectCalls).toBeGreaterThan(0);
  });

  it('listUserSandboxChoices completes nested membership via connect', async () => {
    const res = await services().userPreferredSandbox.listUserSandboxChoices(
      MEMBER_USER,
    );
    // member is not admin → grants-only path (no admin "all sandboxes" select).
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.options.map((o) => o.sandboxId)).toContain(SANDBOX);
    expect(res.value.options.find((o) => o.sandboxId === SANDBOX)?.usable).toBe(
      true,
    );
    expect(connectCalls).toBeGreaterThan(0);
  });

  it('setUserGithubToken completes nested membership + DEK via connect', async () => {
    state = seedState([{ userId: ADMIN_USER, tenantId: TENANT, role: 'owner' }]);
    const instances = services();
    const set = await instances.userGithubToken.setUserGithubToken(
      ADMIN_USER,
      'ghp_connect_only_proof',
      { amk: AMK },
    );
    expect(set.ok).toBe(true);
    if (!set.ok) throw new Error(set.error);

    const status = await instances.userGithubToken.getUserGithubTokenStatus(
      ADMIN_USER,
      { amk: AMK },
    );
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(status.error);
    expect(status.value.configured).toBe(true);
    expect(connectCalls).toBeGreaterThan(0);
  });

  it('listUserMcpServers completes nested membership via connect', async () => {
    const res = await services().userMcpServers.listUserMcpServers(MEMBER_USER);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.value).toEqual([]);
    expect(connectCalls).toBeGreaterThan(0);
  });

  it('createWorkspace completes nested membership + platform via connect', async () => {
    const created: string[] = [];
    const instances = services();
    const res = await instances.userSandboxInstance.createWorkspace(MEMBER_USER, {
      sandboxApi: {
        create: async (p: { name: string }) => {
          created.push(p.name);
          return { name: p.name, stop: async () => {}, delete: async () => {}, extendTimeout: async () => {} };
        },
        get: async () => {
          throw new Error('unexpected get');
        },
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.value.purpose).toBe('workspace');
    expect(res.value.status).toBe('running');
    expect(created).toHaveLength(1);
    expect(connectCalls).toBeGreaterThan(0);
  });
});

describe('createSessionStore (root env resolution, nit L8)', () => {
  const originalEnv = { ...process.env };

  /** Minimal fake Redis-backed client that records `ex` on set. */
  function fakeClient() {
    const calls: { key: string; opts?: { ex?: number } }[] = [];
    const map = new Map<string, unknown>();
    const client: RedisClientLike = {
      async get(k) {
        return map.has(k) ? structuredClone(map.get(k)) : null;
      },
      async set(k, v, opts) {
        map.set(k, structuredClone(v));
        calls.push({ key: k, opts });
        return 'OK';
      },
      async del(...ks) {
        for (const k of ks) map.delete(k);
        return ks.length;
      },
      async keys(pattern) {
        const base = pattern.slice(0, -1);
        return [...map.keys()].filter((k) => k.startsWith(base));
      },
    };
    return { client, calls };
  }

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('resolves REDIS_URL + SESSION_REDIS_TTL_MS once at the root and passes them to the store', async () => {
    process.env.REDIS_URL = 'redis://default:secret@root.resolve.example:6379';
    process.env.SESSION_REDIS_TTL_MS = '2500';
    const { client, calls } = fakeClient();
    const store = createProdServices().createSessionStore({ client });

    expect(store.url()).toBe('redis://default:secret@root.resolve.example:6379');

    // Resolved ttlMs flows into write TTL (ex = ceil(2500/1000) = 3).
    await store.put(
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      {
        id: 's1',
        userId: 'u1',
        tenantId: 't1',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
        meta: {},
      },
    );
    expect(calls.at(-1)?.opts).toEqual({ ex: 3 });
  });
});
