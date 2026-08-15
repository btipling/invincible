import { describe, it, expect } from 'vitest';
import {
  createMetaSandboxTools,
  projectSandboxOption,
  META_SANDBOX_SYSTEM_ADDENDUM,
  type SandboxChoiceListProvider,
  type SessionStoreSeam,
} from './metaSandboxTools';
import type { SandboxChoice } from '../tenancy/userPreferredSandbox';
import {
  isEnvelopeStore,
  type ServerSessionStore,
  type SessionEnvelope,
  type SessionEnvelopeInput,
  type SessionEnvelopeStore,
} from '../sessions/sessionStore';

/** AI SDK tool.execute options (mirrors metaTools.test.ts). */
const execOpts = { toolCallId: '1', messages: [] } as never;

/** Build a SandboxChoice with safe defaults. */
function choice(o: Partial<SandboxChoice> & { sandboxId: string }): SandboxChoice {
  return {
    name: o.name ?? o.sandboxId,
    slug: o.slug ?? o.sandboxId,
    backend: o.backend ?? 'vercel',
    status: o.status ?? 'active',
    image: o.image ?? null,
    usable: o.usable ?? true,
    granted: o.granted ?? true,
    canRead: o.canRead ?? true,
    canWrite: o.canWrite ?? true,
    ...o,
  };
}

/** Non-envelope store (does NOT implement readEnvelope/upsertEnvelope). */
function makeLegacyStore(): ServerSessionStore {
  return {
    async get() {
      return null;
    },
    async put() {
      return { status: 'stored', record: {} as never };
    },
    async list() {
      return [];
    },
    async remove() {
      return false;
    },
  };
}

/**
 * In-memory envelope store (implements `readEnvelope`/`upsertEnvelope` so
 * `isEnvelopeStore` passes). Tracks upsert count + the live envelope.
 */
function makeEnvelopeStore(initial?: SessionEnvelope) {
  let env: SessionEnvelope | null = initial ?? null;
  let upserts = 0;
  const store: SessionEnvelopeStore = {
    async get() {
      return null;
    },
    async put() {
      return { status: 'stored', record: {} as never };
    },
    async list() {
      return [];
    },
    async remove() {
      return false;
    },
    async readEnvelope() {
      return env;
    },
    async upsertEnvelope(_key, input: SessionEnvelopeInput) {
      upserts += 1;
      if (env && input.updatedAt < env.updatedAt) {
        return { status: 'conflict', server: env };
      }
      env = {
        id: input.id,
        userId: input.userId,
        tenantId: input.tenantId,
        createdAt: env?.createdAt ?? Date.now(),
        updatedAt: input.updatedAt,
        meta: input.meta ?? {},
      };
      return { status: 'stored', envelope: env };
    },
  };
  return {
    store,
    getEnv: () => env,
    upsertCount: () => upserts,
  };
}

type StoreResult = ServerSessionStore | 'unavailable' | Error;

function makeSeam(
  store: StoreResult,
  tenant: string | 'unavailable' = 'tenant-1',
): SessionStoreSeam {
  return {
    async resolveTenantIdForUser() {
      if (tenant === 'unavailable') {
        return { ok: false as const, code: 'NO_TENANT', error: 'no tenant' };
      }
      return { ok: true as const, value: tenant };
    },
    async resolveSessionStore() {
      if (store === 'unavailable') {
        return {
          ok: false as const,
          code: 'SESSION_STORE_UNAVAILABLE',
          error: 'session store unavailable',
        };
      }
      if (store instanceof Error) throw store;
      return { ok: true as const, value: store };
    },
  };
}

function makeListProvider(options: SandboxChoice[]): SandboxChoiceListProvider {
  return {
    async listUserSandboxChoices() {
      return { ok: true as const, value: { preferredSandboxId: null, options } };
    },
  };
}

const USABLE_OPTIONS = [
  choice({ sandboxId: 'sb-vercel', name: 'Vercel Workspace', slug: 'vercel', backend: 'vercel' }),
  choice({ sandboxId: 'sb-byo', name: 'BYO Box', slug: 'byo', backend: 'byo' }),
];

describe('meta_sandbox_list — non-secret inventory projection', () => {
  it('projects only safe fields (no base_url / token_ciphertext / host inventory)', () => {
    const projected = projectSandboxOption(choice({ sandboxId: 'sb-1' }));
    const keys = Object.keys(projected).sort();
    expect(keys).toEqual(
      [
        'backend',
        'canRead',
        'canWrite',
        'granted',
        'id',
        'image',
        'name',
        'slug',
        'status',
        'usable',
      ].sort(),
    );
    expect(keys).not.toContain('base_url');
    expect(keys).not.toContain('token_ciphertext');
    expect(keys).not.toContain('token');
  });

  it('lists all options with readable lines and never leaks secret fields', async () => {
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: makeSeam('unavailable'),
    });
    const out = String(await tools.meta_sandbox_list.execute!({}, execOpts));
    expect(out).toContain('id=sb-vercel');
    expect(out).toContain('id=sb-byo');
    expect(out).not.toContain('base_url');
    expect(out).not.toContain('token');
    expect(out).toContain('backend=vercel');
  });

  it('empty list is honest', async () => {
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider([]),
      sessionStoreSeam: makeSeam('unavailable'),
    });
    expect(String(await tools.meta_sandbox_list.execute!({}, execOpts))).toBe(
      'No sandboxes found for this user.',
    );
  });
});

describe('meta_sandbox_active — current bind descriptor', () => {
  it('reports no persisted override when sessionId/store absent → active null', async () => {
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: undefined,
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: makeSeam('unavailable'),
    });
    const out = String(await tools.meta_sandbox_active.execute!({}, execOpts));
    expect(out).toContain('active: null');
    expect(out).toContain('id=sb-vercel');
  });

  it('reports the persisted usable active id and its tool surface', async () => {
    const envStore = makeEnvelopeStore();
    const seam = makeSeam(envStore.store);
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: seam,
    });
    // Seed a persisted active id via the envelope store.
    await envStore.store.upsertEnvelope(
      { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'sess-1' },
      { id: 'sess-1', userId: 'user-1', tenantId: 'tenant-1', updatedAt: 100, meta: { activeSandboxId: 'sb-vercel' } },
    );
    const out = String(await tools.meta_sandbox_active.execute!({}, execOpts));
    expect(out).toContain('active: sandboxId=sb-vercel');
    expect(out).toContain('tools=[');
    // tool surface includes write tools for a canWrite sandbox
    expect(out).toContain('list_dir');
    expect(out).toContain('exec');
  });

  it('reports set-but-unusable persisted id honestly (fail-closed, no fake descriptor)', async () => {
    const envStore = makeEnvelopeStore();
    const seam = makeSeam(envStore.store);
    await envStore.store.upsertEnvelope(
      { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'sess-1' },
      { id: 'sess-1', userId: 'user-1', tenantId: 'tenant-1', updatedAt: 100, meta: { activeSandboxId: 'sb-dead' } },
    );
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: seam,
    });
    const out = String(await tools.meta_sandbox_active.execute!({}, execOpts));
    expect(out).toContain('sb-dead');
    expect(out).toContain('NOT a usable grant');
  });
});

describe('meta_sandbox_switch — persist activeSandboxId via envelope seam', () => {
  it('switches a valid usable grant and persists meta.activeSandboxId (Redis-safe, envelope fake)', async () => {
    const envStore = makeEnvelopeStore({
      id: 'sess-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      createdAt: 1,
      updatedAt: 1234,
      meta: { logicalCwd: 'src' },
    });
    const seam = makeSeam(envStore.store);
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: seam,
    });
    expect(isEnvelopeStore(envStore.store)).toBe(true);

    const out = String(
      await tools.meta_sandbox_switch.execute!({ sandboxId: 'sb-byo' }, execOpts),
    );
    expect(out).toContain('switched active sandbox to id=sb-byo');
    const env = envStore.getEnv();
    expect(env?.meta.activeSandboxId).toBe('sb-byo');
    // updatedAt preserved (mirror skillInject — never bump the host clock).
    expect(env?.updatedAt).toBe(1234);
    expect(env?.meta.logicalCwd).toBe('src'); // stored fields preserved
    expect(envStore.upsertCount()).toBe(1);
  });

  it('creates a fresh envelope when none exists (still persists)', async () => {
    const envStore = makeEnvelopeStore();
    const seam = makeSeam(envStore.store);
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: seam,
    });
    const out = String(
      await tools.meta_sandbox_switch.execute!({ sandboxId: 'sb-vercel' }, execOpts),
    );
    expect(out).toContain('switched active sandbox to id=sb-vercel');
    expect(envStore.getEnv()?.meta.activeSandboxId).toBe('sb-vercel');
  });

  it('fails closed (no write) on an unusable / ungranted id', async () => {
    const envStore = makeEnvelopeStore();
    const seam = makeSeam(envStore.store);
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider([
        choice({ sandboxId: 'sb-ok', usable: true, canRead: true, canWrite: true }),
        choice({ sandboxId: 'sb-dead', usable: false }),
        choice({ sandboxId: 'sb-nogrant', granted: false, usable: false, canRead: false, canWrite: false }),
      ]),
      sessionStoreSeam: seam,
    });
    const dead = String(
      await tools.meta_sandbox_switch.execute!({ sandboxId: 'sb-dead' }, execOpts),
    );
    expect(dead).toMatch(/^ERROR meta_sandbox_switch:/);
    const nogrant = String(
      await tools.meta_sandbox_switch.execute!({ sandboxId: 'sb-nogrant' }, execOpts),
    );
    expect(nogrant).toMatch(/^ERROR meta_sandbox_switch:/);
    expect(envStore.upsertCount()).toBe(0); // no partial write
  });

  it('rejects a foreign/wrong-tenant id (not in the caller choices) → no write', async () => {
    const envStore = makeEnvelopeStore();
    const seam = makeSeam(envStore.store);
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: seam,
    });
    const out = String(
      await tools.meta_sandbox_switch.execute!({ sandboxId: 'sb-foreign' }, execOpts),
    );
    expect(out).toMatch(/^ERROR meta_sandbox_switch:/);
    expect(envStore.upsertCount()).toBe(0);
  });

  it('fails closed (no partial write) when the session store is unavailable', async () => {
    const seam = makeSeam('unavailable');
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: seam,
    });
    const out = String(
      await tools.meta_sandbox_switch.execute!({ sandboxId: 'sb-vercel' }, execOpts),
    );
    expect(out).toMatch(/^ERROR meta_sandbox_switch:/);
    expect(out).toMatch(/no partial write|not switched/);
  });

  it('fails closed when the store does not support the envelope seam (isEnvelopeStore guard)', async () => {
    const legacy = makeLegacyStore();
    expect(isEnvelopeStore(legacy)).toBe(false);
    const seam = makeSeam(legacy);
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: seam,
    });
    const out = String(
      await tools.meta_sandbox_switch.execute!({ sandboxId: 'sb-vercel' }, execOpts),
    );
    expect(out).toMatch(/^ERROR meta_sandbox_switch:/);
    expect(out).toMatch(/envelope seam|no partial write/);
  });

  it('requires a sessionId on the request (otherwise no write)', async () => {
    const envStore = makeEnvelopeStore();
    const seam = makeSeam(envStore.store);
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: undefined,
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: seam,
    });
    const out = String(
      await tools.meta_sandbox_switch.execute!({ sandboxId: 'sb-vercel' }, execOpts),
    );
    expect(out).toMatch(/^ERROR meta_sandbox_switch:/);
    expect(out).toContain('no sessionId');
    expect(envStore.upsertCount()).toBe(0);
  });

  it('rejects a non-Redis-safe sandboxId (fail-closed, no write)', async () => {
    const envStore = makeEnvelopeStore();
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: makeSeam(envStore.store),
    });
    const out = String(
      await tools.meta_sandbox_switch.execute!({ sandboxId: 'a:b:c' }, execOpts),
    );
    expect(out).toMatch(/^ERROR meta_sandbox_switch:/);
    expect(out).toContain('Redis-safe');
    expect(envStore.upsertCount()).toBe(0);
  });
});

describe('surface shape + system addendum', () => {
  it('exposes exactly the sandbox meta tools', () => {
    const tools = createMetaSandboxTools({
      userId: 'user-1',
      sessionId: 'sess-1',
      userPreferredSandbox: makeListProvider(USABLE_OPTIONS),
      sessionStoreSeam: makeSeam('unavailable'),
    });
    expect(Object.keys(tools).sort()).toEqual(
      ['meta_sandbox_active', 'meta_sandbox_list', 'meta_sandbox_switch'].sort(),
    );
  });

  it('carries a non-empty sandbox system addendum', () => {
    expect(META_SANDBOX_SYSTEM_ADDENDUM.length).toBeGreaterThan(0);
    expect(META_SANDBOX_SYSTEM_ADDENDUM).toContain('meta_sandbox_switch');
    expect(META_SANDBOX_SYSTEM_ADDENDUM).not.toContain('base_url');
  });
});
