import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HARNESS_SESSION_MAX_BODY_BYTES,
  HARNESS_SESSION_MAX_MSG_BYTES,
} from './sessionCloudCaps';
import {
  createHttpSessionRepository,
  isEmptyOfDialogue,
  parseCloudSessionSnapshot,
  parseSessionSummaryList,
  shouldAdoptServer,
  trimForCloudPut,
  truncateUtf8,
  utf8ByteLength,
  type SessionSummary,
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
  it('folds cwd + activeSandboxId into meta; drops host-absolute cwd / non-Redis-safe sandbox', () => {
    const out = trimForCloudPut({
      id: 'sess_a',
      updatedAt: 42,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
      cwd: 'workspace',
      activeSandboxId: 'sbx_abc123',
    });
    expect(out).toEqual({
      id: 'sess_a',
      updatedAt: 42,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
      meta: { logicalCwd: 'workspace', activeSandboxId: 'sbx_abc123' },
    });
    // no local-only carrier fields leak onto the wire body
    expect('cwd' in out).toBe(false);
    expect('activeSandboxId' in out).toBe(false);

    // host-absolute cwd + non-Redis-safe sandbox are dropped (fail-open to unset)
    const bad = trimForCloudPut({
      id: 'sess_b',
      updatedAt: 1,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
      cwd: '/etc',
      activeSandboxId: 'a:b',
    });
    expect(bad.meta).toBeUndefined();

    // no meta at all when neither carrier is set
    const bare = trimForCloudPut({ id: 'sess_c', updatedAt: 1, messages: [] });
    expect(bare.meta).toBeUndefined();
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

  it('rejects a record whose id differs from the resource id (confused-deputy)', () => {
    const body = {
      id: 'other-id',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
    };
    expect(parseCloudSessionSnapshot(body, 'expected-id')).toBeNull();
  });

  it('restores cwd + activeSandboxId from stored meta (sanitized, fail-open on poison)', () => {
    const body = {
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      meta: { logicalCwd: 'invincible/src', activeSandboxId: 'sbx_abc123' },
    };
    const out = parseCloudSessionSnapshot(body);
    expect(out?.cwd).toBe('invincible/src');
    expect(out?.activeSandboxId).toBe('sbx_abc123');

    // host-absolute cwd + non-Redis-safe sandbox drop to unset (never a sticky 400)
    const bad = parseCloudSessionSnapshot({
      ...body,
      meta: { logicalCwd: '/etc', activeSandboxId: 'a:b' },
    });
    expect(bad?.cwd).toBeUndefined();
    expect(bad?.activeSandboxId).toBeUndefined();

    // no meta → carrier fields unset
    const bare = parseCloudSessionSnapshot({ id: 's', updatedAt: 1, messages: [] });
    expect(bare?.cwd).toBeUndefined();
    expect(bare?.activeSandboxId).toBeUndefined();
  });
});

describe('parseSessionSummaryList', () => {
  it('parses summaries with optional title', () => {
    const out = parseSessionSummaryList([
      { id: 'a', createdAt: 1, updatedAt: 2, title: 'title' },
      { id: 'b' },
    ]);
    expect(out).toEqual([
      { id: 'a', createdAt: 1, updatedAt: 2, title: 'title' },
      { id: 'b' },
    ] satisfies SessionSummary[]);
  });

  it('rejects list with a malformed row', () => {
    expect(parseSessionSummaryList([{ id: 'a' }, { updatedAt: 3 }])).toBeNull();
    expect(parseSessionSummaryList('nope')).toBeNull();
  });
});

describe('createHttpSessionRepository (id-shaped)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';

  function record(id: string, upto: number, messages = [{ id: 'm1', role: 'user' as const, text: 'hi', at: 1 }]) {
    return { id, updatedAt: upto, messages };
  }

  it('create() mints distinct server ids (createFirst mints the first)', async () => {
    const created: SessionSnapshot[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        const id = crypto.randomUUID();
        const s = { id, updatedAt: 0, messages: [] };
        created.push(s);
        return Response.json(s);
      }
      return Response.json(record(idA, 1), { status: 200 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    const first = await repo.createFirst();
    const second = await repo.create();
    expect(first.action).toBe('ok');
    expect(second.action).toBe('ok');
    expect(first.action === 'ok' && second.action === 'ok').toBe(true);
    if (first.action === 'ok' && second.action === 'ok') {
      expect(first.snapshot.id).not.toBe(second.snapshot.id);
      expect(first.snapshot.messages).toHaveLength(0);
    }
  });

  it('put() coalesces per session and writes body id == path id == snapshot.id', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT') {
        calls.push({ url: String(_url), body: JSON.parse(String(init?.body)) });
        return Response.json(record(idA, 10, [{ id: 'm', role: 'user', text: 'x', at: 1 }]), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    let local = snap({ id: idA, updatedAt: 10, messages: [{ id: 'm', role: 'user', text: 'x', at: 1 }] });
    repo.put(idA, local);
    local = { ...local, updatedAt: 20, messages: [{ id: 'm', role: 'user', text: 'y', at: 2 }] };
    repo.put(idA, local);
    local = { ...local, updatedAt: 30, messages: [{ id: 'm', role: 'user', text: 'z', at: 3 }] };
    repo.put(idA, local);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    // Every PUT resolved to the canonical resource + body.id == idA.
    for (const c of calls) {
      expect(c.url).toBe(`/api/sessions/${idA}`);
      expect((c.body as { id: string }).id).toBe(idA);
    }
    // Last (pending) is the newest snapshot.
    expect((calls.at(-1)!.body as { messages: { text: string }[] }).messages.at(-1)!.text).toBe(
      'z',
    );
  });

  it('put() fails closed when snapshot.id != resource id (no network call)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const repo = createHttpSessionRepository({ fetchImpl });
    repo.put(idB, snap({ id: idA }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('remove() issues DELETE for that id only and not others', async () => {
    const dels: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') dels.push(String(url));
      return Response.json(record(idA, 1), { status: 200 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    await repo.remove(idA);
    expect(dels).toEqual([`/api/sessions/${idA}`]);
  });

  it('remove() during in-flight PUT issues a compensatory DELETE after PUT lands', async () => {
    let resolvePut!: (r: Response) => void;
    const putGate = new Promise<Response>((r) => {
      resolvePut = r;
    });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'PUT') return putGate;
      return new Response(null, { status: 204 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    repo.put(idA, snap({ id: idA, updatedAt: 1 }));
    await Promise.resolve();
    expect(calls.some((c) => c.startsWith('PUT'))).toBe(true);
    await repo.remove(idA);
    expect(calls.filter((c) => c.startsWith('DELETE')).length).toBe(1);
    resolvePut(Response.json(record(idA, 1, []), { status: 200 }));
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.startsWith('DELETE')).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('epoch guard prevents Clear (remove) from resurrecting', async () => {
    let resolvePut!: (r: Response) => void;
    const putGate = new Promise<Response>((r) => {
      resolvePut = r;
    });
    const puts: string[] = [];
    const dels: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT') {
        puts.push(String(url));
        return putGate;
      }
      if (method === 'DELETE') dels.push(String(url));
      return Response.json(record(idA, 1), { status: 200 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    repo.put(idA, snap({ id: idA, updatedAt: 1 }));
    await Promise.resolve();
    await repo.remove(idA);
    // Pending cleared → no further PUT fires after remove (only the original in-flight).
    resolvePut(Response.json(record(idA, 1, []), { status: 200 }));
    await vi.waitFor(() => expect(dels.length).toBeGreaterThanOrEqual(2));
    expect(puts).toHaveLength(1);
  });

  it('409 on put adopts server body via onAdopt', async () => {
    const server = { id: idA, updatedAt: 300, messages: [{ id: 'm', role: 'user', text: 'win', at: 1 }] };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return Response.json(server, { status: 409 });
      return new Response(null, { status: 204 });
    });
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({ fetchImpl, onAdopt });
    repo.put(idA, snap({ id: idA, updatedAt: 100, messages: [] }));
    await vi.waitFor(() => expect(onAdopt).toHaveBeenCalledWith(server));
  });

  it('409 adopt is refused when live active session is a different id (switch mid-put)', async () => {
    const server = {
      id: idA,
      updatedAt: 300,
      messages: [{ id: 'm', role: 'user', text: 'win', at: 1 }],
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return Response.json(server, { status: 409 });
      return new Response(null, { status: 204 });
    });
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({
      fetchImpl,
      onAdopt,
      // Simulates the active session being a *different* one while PUT(A) is in flight.
      getLocal: () => snap({ id: idB, updatedAt: 50, messages: [] }),
    });
    repo.put(idA, snap({ id: idA, updatedAt: 100, messages: [] }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it('409 adopt still fires when the live active session matches the put target id', async () => {
    const server = {
      id: idA,
      updatedAt: 300,
      messages: [{ id: 'm', role: 'user', text: 'win', at: 1 }],
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return Response.json(server, { status: 409 });
      return new Response(null, { status: 204 });
    });
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({
      fetchImpl,
      onAdopt,
      getLocal: () => snap({ id: idA, updatedAt: 100, messages: [] }),
    });
    repo.put(idA, snap({ id: idA, updatedAt: 100, messages: [] }));
    await vi.waitFor(() => expect(onAdopt).toHaveBeenCalledWith(server));
  });

  it('401 disables the repository', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'auth' }, { status: 401 }));
    const repo = createHttpSessionRepository({ fetchImpl });
    const res = await repo.get(idA);
    expect(res.action).toBe('disabled');
    expect(repo.enabled).toBe(false);
  });

  it('get() returns notfound on 404 (and leaves the repo enabled)', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'missing', code: 'NOT_FOUND' }, { status: 404 }),
    );
    const repo = createHttpSessionRepository({ fetchImpl });
    expect((await repo.get(idA)).action).toBe('notfound');
    expect(repo.enabled).toBe(true);
  });

  it('get() fails closed when the fetched id does not match the requested id', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(record(idB, 1, [{ id: 'm', role: 'user', text: 'x', at: 1 }]), { status: 200 }),
    );
    const repo = createHttpSessionRepository({ fetchImpl });
    const res = await repo.get(idA);
    expect(res.action).toBe('error');
  });

  it('list() returns summaries', async () => {
    const summary: SessionSummary[] = [{ id: idA, updatedAt: 1, title: 't' }];
    const fetchImpl = vi.fn(async () => Response.json(summary, { status: 200 }));
    const repo = createHttpSessionRepository({ fetchImpl });
    const res = await repo.list();
    expect(res.action).toBe('ok');
    if (res.action === 'ok') expect(res.sessions).toEqual(summary);
  });
});
