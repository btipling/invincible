import { describe, expect, it } from 'vitest';
import type { HarnessSessionRecord } from '../sessions/sessionStore';
import {
  cleanSnapshot,
  mergePersonaMeta,
  resolvePersonaPreamble,
  type PersonaBodyReader,
  type SessionStoreLite,
} from './personaInject';

const KEY = {
  tenantId: 'tenant1',
  userId: 'user1',
  sessionId: 'sess_abc123',
};

function makeRecord(meta: HarnessSessionRecord['meta']): HarnessSessionRecord {
  return {
    id: KEY.sessionId,
    tenantId: KEY.tenantId,
    userId: KEY.userId,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    meta,
  };
}

/** In-memory fake implementing the minimal session-store seam. */
class FakeStore implements SessionStoreLite {
  record: HarnessSessionRecord | null;
  puts: HarnessSessionRecord[] = [];
  constructor(record: HarnessSessionRecord | null) {
    this.record = record;
  }
  async get() {
    return this.record;
  }
  async put(_key: unknown, record: HarnessSessionRecord) {
    this.record = record;
    this.puts.push(record);
    return { status: 'stored' as const };
  }
}

function readerOf(
  rows: Record<string, { body: string } | null>,
): PersonaBodyReader {
  return {
    async getPersonaById(_userId: string, personaId: string) {
      const row = rows[personaId];
      return { ok: true, value: row ?? null };
    },
  };
}

describe('personaInject.cleanSnapshot / mergePersonaMeta', () => {
  it('trims and drops empty/whitespace', () => {
    expect(cleanSnapshot('  hi  ')).toBe('hi');
    expect(cleanSnapshot('   ')).toBeUndefined();
    expect(cleanSnapshot(undefined)).toBeUndefined();
    expect(cleanSnapshot('')).toBeUndefined();
  });

  it('mergePersonaMeta is additive and bumps updatedAt', () => {
    const rec = makeRecord({ title: 'T', logicalCwd: 'proj' });
    const next = mergePersonaMeta(rec, 'pers_1', 'Always use tabs.');
    expect(next.meta).toEqual({
      title: 'T',
      logicalCwd: 'proj',
      personaId: 'pers_1',
      personaSnapshot: 'Always use tabs.',
    });
    expect(next.updatedAt).toBeGreaterThanOrEqual(rec.updatedAt);
    // messages / identity preserved
    expect(next.id).toBe(rec.id);
    expect(next.messages).toEqual([]);
  });
});

describe('resolvePersonaPreamble', () => {
  it('later turn: reuses meta.personaSnapshot from the session (edit is inert)', async () => {
    const store = new FakeStore(
      makeRecord({ personaId: 'pers_1', personaSnapshot: 'Locked text.' }),
    );
    let readCalls = 0;
    const rd: PersonaBodyReader = {
      async getPersonaById() {
        readCalls += 1;
        return { ok: true, value: { body: 'Live body (should NOT be used).' } };
      },
    };
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      sessionId: KEY.sessionId,
      sessionStore: store,
      sessionKey: KEY,
      userPersonas: rd,
    });
    expect(out).toBe('Locked text.');
    expect(readCalls).toBe(0);
    expect(store.puts).toHaveLength(0);
  });

  it('first turn: resolves body personaId and persists the snapshot once', async () => {
    const store = new FakeStore(makeRecord({ title: 'T' }));
    const rd = readerOf({ pers_1: { body: 'Always use tabs.' } });
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      personaId: 'pers_1',
      sessionId: KEY.sessionId,
      sessionStore: store,
      sessionKey: KEY,
      userPersonas: rd,
    });
    expect(out).toBe('Always use tabs.');
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]!.meta.personaId).toBe('pers_1');
    expect(store.puts[0]!.meta.personaSnapshot).toBe('Always use tabs.');
    // other reserved keys preserved
    expect(store.puts[0]!.meta.title).toBe('T');
  });

  it('cloud-bound: uses meta.personaId when no body personaId', async () => {
    const store = new FakeStore(makeRecord({ personaId: 'pers_2' }));
    const rd = readerOf({ pers_2: { body: 'Stack compliance.' } });
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      sessionId: KEY.sessionId,
      sessionStore: store,
      sessionKey: KEY,
      userPersonas: rd,
    });
    expect(out).toBe('Stack compliance.');
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]!.meta.personaId).toBe('pers_2');
  });

  it('sessionId present, session absent, body personaId → inject this turn (no persist)', async () => {
    const store = new FakeStore(null);
    let readCalls = 0;
    const rd: PersonaBodyReader = {
      async getPersonaById() {
        readCalls += 1;
        return { ok: true, value: { body: 'First-turn race.' } };
      },
    };
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      personaId: 'pers_1',
      sessionId: KEY.sessionId,
      sessionStore: store,
      sessionKey: KEY,
      userPersonas: rd,
    });
    expect(out).toBe('First-turn race.');
    expect(readCalls).toBe(1);
    expect(store.puts).toHaveLength(0);
  });

  it('sessionId present, session absent, no personaId → fail closed (no inject, no leak)', async () => {
    const store = new FakeStore(null);
    let readCalls = 0;
    const rd: PersonaBodyReader = {
      async getPersonaById() {
        readCalls += 1;
        return { ok: true, value: { body: 'should not run' } };
      },
    };
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      sessionId: KEY.sessionId,
      sessionStore: store,
      sessionKey: KEY,
      userPersonas: rd,
    });
    expect(out).toBeUndefined();
    expect(readCalls).toBe(0);
  });

  it('no sessionId + body personaId → inject this turn, no persist', async () => {
    const rd = readerOf({ pers_1: { body: 'Offline safe.' } });
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      personaId: 'pers_1',
      userPersonas: rd,
    });
    expect(out).toBe('Offline safe.');
  });

  it('sessionId set + body personaId but NO store/key → inject this turn, no put (offline/Redis-off)', async () => {
    const rd = readerOf({ pers_1: { body: 'Redis-off safe.' } });
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      personaId: 'pers_1',
      sessionId: KEY.sessionId,
      userPersonas: rd,
    });
    expect(out).toBe('Redis-off safe.');
  });

  it('sessionId set + body personaId but store get THROWS → inject this turn, no put (fail open)', async () => {
    const throwingStore = {
      async get() {
        throw new Error('redis down');
      },
      async put() {
        throw new Error('should not be called');
      },
    };
    const rd = readerOf({ pers_1: { body: 'Blip safe.' } });
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      personaId: 'pers_1',
      sessionId: KEY.sessionId,
      sessionStore: throwingStore,
      sessionKey: KEY,
      userPersonas: rd,
    });
    expect(out).toBe('Blip safe.');
  });

  it('unknown/other-user personaId → undefined (no inject, no leak)', async () => {
    const rd = readerOf({ pers_1: null });
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      personaId: 'pers_1',
      userPersonas: rd,
    });
    expect(out).toBeUndefined();
  });

  it('no persona → undefined (behaviour identical to today)', async () => {
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      userPersonas: readerOf({}),
    });
    expect(out).toBeUndefined();
  });

  it('store errors fail open but still inject this turn', async () => {
    const store = {
      async get() {
        return makeRecord({ title: 'T' });
      },
      async put() {
        throw new Error('redis down');
      },
    };
    const rd = readerOf({ pers_1: { body: 'Resilient.' } });
    const out = await resolvePersonaPreamble({
      userId: KEY.userId,
      personaId: 'pers_1',
      sessionId: KEY.sessionId,
      sessionStore: store,
      sessionKey: KEY,
      userPersonas: rd,
    });
    expect(out).toBe('Resilient.');
  });
});
