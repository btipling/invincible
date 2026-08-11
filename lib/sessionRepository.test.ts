import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HARNESS_SESSION_MAX_BODY_BYTES,
  HARNESS_SESSION_MAX_MSG_BYTES,
} from './sessionCloudCaps';
import {
  createHttpSessionRepository,
  isEmptyOfDialogue,
  parseCloudSessionSnapshot,
  shouldAdoptServer,
  trimForCloudPut,
  truncateUtf8,
  utf8ByteLength,
} from './sessionRepository';
import type { SessionSnapshot } from './sessionStore';

function snap(
  partial: Partial<SessionSnapshot> & { messages?: SessionSnapshot['messages'] },
): SessionSnapshot {
  return {
    id: partial.id ?? 'sess_test',
    updatedAt: partial.updatedAt ?? 1000,
    messages: partial.messages ?? [],
  };
}

describe('trimForCloudPut', () => {
  it('omits cwd and keeps id/updatedAt', () => {
    const out = trimForCloudPut({
      id: 'sess_a',
      updatedAt: 42,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
      cwd: 'workspace',
    });
    expect(out).toEqual({
      id: 'sess_a',
      updatedAt: 42,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
    });
    expect('cwd' in out).toBe(false);
  });

  it('keeps message count; body trim drops oldest only when over ~2 MiB', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `m_${i}`,
      role: 'user' as const,
      text: `t${i}`,
      at: i,
    }));
    const out = trimForCloudPut(snap({ messages }));
    expect(out.messages).toHaveLength(50);
    expect(out.messages[0]?.id).toBe('m_0');
    expect(out.messages.at(-1)?.id).toBe('m_49');
  });

  it('truncates oversize UTF-8 text', () => {
    const text = 'é'.repeat(HARNESS_SESSION_MAX_MSG_BYTES); // 2 bytes each → over cap
    expect(utf8ByteLength(text)).toBeGreaterThan(HARNESS_SESSION_MAX_MSG_BYTES);
    const out = trimForCloudPut(
      snap({
        messages: [{ id: 'm1', role: 'assistant', text, at: 1 }],
      }),
    );
    expect(utf8ByteLength(out.messages[0]!.text)).toBeLessThanOrEqual(
      HARNESS_SESSION_MAX_MSG_BYTES,
    );
  });

  it('drops oldest until body under ~2 MiB', () => {
    // ~100 KiB per message ASCII → need many to exceed 2 MiB
    const chunk = 'x'.repeat(100_000);
    const messages = Array.from({ length: 30 }, (_, i) => ({
      id: `m_${i}`,
      role: 'user' as const,
      text: chunk,
      at: i,
    }));
    const out = trimForCloudPut(snap({ messages }));
    const body = JSON.stringify({
      id: out.id,
      updatedAt: out.updatedAt,
      messages: out.messages,
    });
    expect(utf8ByteLength(body)).toBeLessThanOrEqual(HARNESS_SESSION_MAX_BODY_BYTES);
    expect(out.messages.length).toBeLessThan(30);
    expect(out.messages.at(-1)?.id).toBe('m_29');
  });
});

describe('truncateUtf8', () => {
  it('preserves short strings', () => {
    expect(truncateUtf8('hello', 100)).toBe('hello');
  });

  it('does not split multi-byte sequences', () => {
    const s = 'aaéé';
    const out = truncateUtf8(s, 4); // a a + partial é
    expect(utf8ByteLength(out)).toBeLessThanOrEqual(4);
    expect(() => out).not.toThrow();
  });
});

describe('shouldAdoptServer / empty dialogue', () => {
  it('detects empty-of-dialogue (system only)', () => {
    expect(
      isEmptyOfDialogue(
        snap({
          messages: [{ id: 's', role: 'system', text: 'welcome', at: 1 }],
        }),
      ),
    ).toBe(true);
    expect(
      isEmptyOfDialogue(
        snap({
          messages: [{ id: 'u', role: 'user', text: 'hi', at: 1 }],
        }),
      ),
    ).toBe(false);
  });

  it('adopts strictly newer server', () => {
    const local = snap({ updatedAt: 100, messages: [{ id: 'u', role: 'user', text: 'a', at: 1 }] });
    const server = snap({
      updatedAt: 200,
      messages: [{ id: 'u', role: 'user', text: 'b', at: 1 }],
    });
    expect(shouldAdoptServer(local, server)).toBe(true);
    expect(shouldAdoptServer(server, local)).toBe(false);
  });

  it('equal updatedAt keeps local', () => {
    const local = snap({ updatedAt: 100, messages: [{ id: 'u', role: 'user', text: 'a', at: 1 }] });
    const server = snap({
      updatedAt: 100,
      messages: [{ id: 'u', role: 'user', text: 'b', at: 1 }],
    });
    expect(shouldAdoptServer(local, server)).toBe(false);
  });

  it('adopts server when local empty-of-dialogue', () => {
    const local = snap({
      updatedAt: 500,
      messages: [{ id: 's', role: 'system', text: 'welcome', at: 1 }],
    });
    const server = snap({
      updatedAt: 100,
      messages: [{ id: 'u', role: 'user', text: 'hi', at: 1 }],
    });
    expect(shouldAdoptServer(local, server)).toBe(true);
  });
});

describe('parseCloudSessionSnapshot', () => {
  it('accepts valid body and rejects junk', () => {
    expect(
      parseCloudSessionSnapshot({
        id: 'sess_x',
        updatedAt: 1,
        messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      }),
    ).toEqual({
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
    });
    expect(parseCloudSessionSnapshot(null)).toBeNull();
    expect(parseCloudSessionSnapshot({ id: 'x', updatedAt: 1, messages: 'nope' })).toBeNull();
  });
});

describe('createHttpSessionRepository', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pull adopts newer server via onAdopt', async () => {
    const server = {
      id: 'sess_s',
      updatedAt: 200,
      messages: [{ id: 'm', role: 'user', text: 'server', at: 1 }],
    };
    const fetchImpl = vi.fn(async () =>
      Response.json(server, { status: 200 }),
    );
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({ fetchImpl, onAdopt });
    const result = await repo.pull(
      snap({
        updatedAt: 100,
        messages: [{ id: 'm', role: 'user', text: 'local', at: 1 }],
      }),
    );
    expect(result.action).toBe('adopt');
    expect(onAdopt).toHaveBeenCalledWith(server);
  });

  it('pull does not adopt when server older and local has dialogue', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        id: 'sess_s',
        updatedAt: 50,
        messages: [{ id: 'm', role: 'user', text: 'server', at: 1 }],
      }),
    );
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({ fetchImpl, onAdopt });
    const result = await repo.pull(
      snap({
        updatedAt: 100,
        messages: [{ id: 'm', role: 'user', text: 'local', at: 1 }],
      }),
    );
    expect(result.action).toBe('noop');
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it('pull adopts when local empty-of-dialogue', async () => {
    const server = {
      id: 'sess_s',
      updatedAt: 10,
      messages: [{ id: 'm', role: 'user', text: 'server', at: 1 }],
    };
    const fetchImpl = vi.fn(async () => Response.json(server));
    const repo = createHttpSessionRepository({ fetchImpl });
    const result = await repo.pull(
      snap({
        updatedAt: 999,
        messages: [{ id: 's', role: 'system', text: 'welcome', at: 1 }],
      }),
    );
    expect(result.action).toBe('adopt');
  });

  it('pull re-checks getLocal after round-trip (no clobber of newer turn)', async () => {
    let live = snap({
      updatedAt: 100,
      messages: [{ id: 'm', role: 'user', text: 'local', at: 1 }],
    });
    let resolveGet!: (r: Response) => void;
    const getGate = new Promise<Response>((r) => {
      resolveGet = r;
    });
    const server = {
      id: 'sess_s',
      updatedAt: 150,
      messages: [{ id: 'm', role: 'user', text: 'server', at: 1 }],
    };
    const fetchImpl = vi.fn(async () => getGate);
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({
      fetchImpl,
      onAdopt,
      getLocal: () => live,
    });
    const pullPromise = repo.pull(live);
    // Local advanced while GET in flight.
    live = snap({
      updatedAt: 200,
      messages: [
        { id: 'm', role: 'user', text: 'local', at: 1 },
        { id: 'm2', role: 'user', text: 'newer', at: 2 },
      ],
    });
    resolveGet(Response.json(server, { status: 200 }));
    const result = await pullPromise;
    expect(result.action).toBe('noop');
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it('401 disables repository', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'auth' }, { status: 401 }),
    );
    const repo = createHttpSessionRepository({ fetchImpl });
    const result = await repo.pull(snap({}));
    expect(result.action).toBe('disabled');
    expect(repo.enabled).toBe(false);
  });

  it('404 NOT_FOUND is noop (multi-tenant only)', async () => {
    const empty = createHttpSessionRepository({
      fetchImpl: vi.fn(async () =>
        Response.json({ error: 'missing', code: 'NOT_FOUND' }, { status: 404 }),
      ),
    });
    expect((await empty.pull(snap({}))).action).toBe('noop');
    expect(empty.enabled).toBe(true);
  });

  it('409 on push adopts server body', async () => {
    const server = {
      id: 'sess_s',
      updatedAt: 300,
      messages: [{ id: 'm', role: 'user', text: 'winner', at: 1 }],
    };
    const fetchImpl = vi.fn(async () => Response.json(server, { status: 409 }));
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({ fetchImpl, onAdopt });
    repo.schedulePush(
      snap({
        updatedAt: 100,
        messages: [{ id: 'm', role: 'user', text: 'stale', at: 1 }],
      }),
    );
    // allow microtasks
    await vi.waitFor(() => expect(onAdopt).toHaveBeenCalledWith(server));
  });

  it('409 does not adopt when getLocal is already newer', async () => {
    let live = snap({
      updatedAt: 100,
      messages: [{ id: 'm', role: 'user', text: 'stale', at: 1 }],
    });
    const server = {
      id: 'sess_s',
      updatedAt: 150,
      messages: [{ id: 'm', role: 'user', text: 'server', at: 1 }],
    };
    let resolvePut!: (r: Response) => void;
    const putGate = new Promise<Response>((r) => {
      resolvePut = r;
    });
    const fetchImpl = vi.fn(async () => putGate);
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({
      fetchImpl,
      onAdopt,
      getLocal: () => live,
    });
    repo.schedulePush(live);
    await Promise.resolve();
    live = snap({
      updatedAt: 200,
      messages: [{ id: 'm2', role: 'user', text: 'newer', at: 2 }],
    });
    resolvePut(Response.json(server, { status: 409 }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    // give putOnce time to finish 409 path
    await Promise.resolve();
    await Promise.resolve();
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it('remove issues DELETE only (no PUT)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const repo = createHttpSessionRepository({ fetchImpl });
    await repo.remove();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstCall = fetchImpl.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit | undefined,
    ];
    expect(firstCall[1]?.method).toBe('DELETE');
  });

  it('remove cancels pending push so clear never PUTs empty', async () => {
    let resolvePut!: (r: Response) => void;
    const putGate = new Promise<Response>((r) => {
      resolvePut = r;
    });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      if (method === 'PUT') {
        return putGate;
      }
      return new Response(null, { status: 204 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    repo.schedulePush(
      snap({
        updatedAt: 1,
        messages: [{ id: 'm', role: 'user', text: 'a', at: 1 }],
      }),
    );
    await Promise.resolve();
    expect(calls).toEqual(['PUT']);
    // Queue a second push then remove — pending cleared; in-flight PUT may finish
    repo.schedulePush(
      snap({
        id: 'sess_empty',
        updatedAt: 2,
        messages: [],
      }),
    );
    await repo.remove();
    resolvePut(Response.json(snap({ updatedAt: 1, messages: [] })));
    await vi.waitFor(() => expect(calls.filter((m) => m === 'DELETE').length).toBeGreaterThanOrEqual(1));
    // No second PUT after remove drained pending
    expect(calls.filter((m) => m === 'PUT')).toHaveLength(1);
    // Initial DELETE + compensatory DELETE after in-flight PUT completes
    expect(calls.filter((m) => m === 'DELETE').length).toBeGreaterThanOrEqual(1);
  });

  it('remove during in-flight PUT issues compensatory DELETE after PUT lands', async () => {
    let resolvePut!: (r: Response) => void;
    const putGate = new Promise<Response>((r) => {
      resolvePut = r;
    });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(method);
      if (method === 'PUT') {
        return putGate;
      }
      return new Response(null, { status: 204 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    repo.schedulePush(
      snap({
        updatedAt: 1,
        messages: [{ id: 'm', role: 'user', text: 'a', at: 1 }],
      }),
    );
    await Promise.resolve();
    expect(calls).toEqual(['PUT']);
    // Clear while PUT in flight — epoch bump + immediate DELETE
    await repo.remove();
    expect(calls.filter((m) => m === 'DELETE')).toHaveLength(1);
    // PUT completes after clear (would resurrect row without compensatory DELETE)
    resolvePut(
      Response.json(
        snap({
          updatedAt: 1,
          messages: [{ id: 'm', role: 'user', text: 'a', at: 1 }],
        }),
      ),
    );
    await vi.waitFor(() => expect(calls.filter((m) => m === 'DELETE')).toHaveLength(2));
    expect(calls.filter((m) => m === 'PUT')).toHaveLength(1);
  });

  it('coalesce: rapid pushes serialize and last pending is sent', async () => {
    const bodies: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let puts = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        puts += 1;
        bodies.push(String(init.body));
        if (puts === 1) await gate;
        return Response.json(JSON.parse(String(init.body)));
      }
      return new Response(null, { status: 204 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    repo.schedulePush(
      snap({
        updatedAt: 1,
        messages: [{ id: 'm1', role: 'user', text: 'one', at: 1 }],
      }),
    );
    await Promise.resolve();
    repo.schedulePush(
      snap({
        updatedAt: 2,
        messages: [{ id: 'm2', role: 'user', text: 'two', at: 2 }],
      }),
    );
    repo.schedulePush(
      snap({
        updatedAt: 3,
        messages: [{ id: 'm3', role: 'user', text: 'three', at: 3 }],
      }),
    );
    release();
    await vi.waitFor(() => expect(puts).toBeGreaterThanOrEqual(2));
    expect(puts).toBeLessThanOrEqual(3);
    expect(bodies.at(-1)).toContain('three');
  });
});
