import { describe, expect, it } from 'vitest';
import type { HarnessSessionRecord } from '../sessions/sessionStore';
import {
  buildSkillBlock,
  parseAttachedSkills,
  parseSkillCommand,
  resolveSkillPreamble,
  serializeAttachedSkills,
  type ParsedSkillCommand,
  type SkillBodyReader,
  type SessionStoreLite,
} from './skillInject';

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

function readerOf(rows: Partial<Record<string, { body: string } | null>>): SkillBodyReader {
  return {
    async getSkillBySlug(_userId: string, slug: string) {
      const row = rows[slug];
      return { ok: true, value: row ?? null };
    },
  };
}

function readEventActions(
  res: Awaited<ReturnType<typeof resolveSkillPreamble>>,
): { action: string; slug: string; ok: boolean }[] {
  return res.events.map((e) => ({ action: e.action, slug: e.slug, ok: e.ok }));
}

describe('parseSkillCommand', () => {
  it('attaches a bare leading /slug and strips the prefix from the prompt', () => {
    const p = parseSkillCommand('/create-plan please scaffold a new plan');
    expect(p.type).toBe('attach');
    expect((p as { rest: string }).rest).toBe('please scaffold a new plan');
  });

  it('dashed slug /create-plan resolves (hyphen-inclusive charset)', () => {
    const p = parseSkillCommand('/create-plan');
    expect(p.type).toBe('attach');
    expect((p as { slug: string }).slug).toBe('create-plan');
  });

  it('non-slash prompt passes through unchanged', () => {
    const p = parseSkillCommand('help me with read_file');
    expect(p.type).toBe('none');
  });

  it('a bare `/` with no slug is plain text', () => {
    expect(parseSkillCommand('/').type).toBe('none');
    expect(parseSkillCommand('/ help').type).toBe('none');
  });

  it('a `/path` mid-token (not leading) is plain text', () => {
    // NOT anchored mid-token — only the leading slash is a command.
    expect(parseSkillCommand('open ./file.txt').type).toBe('none');
  });

  it('a leading slash with an uppercase/space slug is NOT a valid command', () => {
    const p = parseSkillCommand('/Not A Slug');
    expect(p.type).toBe('none');
  });

  it('/unskill is checked FIRST so /unskill slug is not swallowed as an attach', () => {
    const p = parseSkillCommand('/unskill create-plan');
    expect(p.type).toBe('detach');
    expect((p as { slug: string }).slug).toBe('create-plan');
    // The whole command is consumed — no leftover prose for the model.
    expect((p as { rest: string }).rest).toBe('');
  });

  it('/unskill with no slug is not a valid detach (falls through)', () => {
    const p = parseSkillCommand('/unskill');
    // `/unskill` itself is a valid slug-shaped token, so it attaches `unskill`.
    expect(p.type).toBe('attach');
    expect((p as { slug: string }).slug).toBe('unskill');
  });
});

describe('parseAttachedSkills / serializeAttachedSkills', () => {
  it('parses a well-formed JSON-array string of slugs; drops dups + invalid', () => {
    expect(parseAttachedSkills('["a","b"]')).toEqual(['a', 'b']);
    expect(parseAttachedSkills('["a","a"]')).toEqual(['a']);
    // malformed / non-array / invalid slug → fail-closed empty
    expect(parseAttachedSkills('not json')).toEqual([]);
    expect(parseAttachedSkills('{"a":1}')).toEqual([]);
    expect(parseAttachedSkills('[1, null]')).toEqual([]);
    expect(parseAttachedSkills('["Bad Slug"]')).toEqual([]);
    expect(parseAttachedSkills(undefined)).toEqual([]);
    expect(parseAttachedSkills(42)).toEqual([]);
  });

  it('serialize → parse round-trips', () => {
    expect(parseAttachedSkills(serializeAttachedSkills(['a', 'create-plan']))).toEqual([
      'a',
      'create-plan',
    ]);
  });
});

describe('buildSkillBlock', () => {
  it('labels the block with the slug', () => {
    expect(buildSkillBlock('create-plan', 'Plan sections:\n- goals')).toBe(
      '### Skill attached: create-plan\nPlan sections:\n- goals',
    );
  });
});

describe('resolveSkillPreamble', () => {
  it('attach resolves + injects THIS turn and persists the sticky set', async () => {
    const store = new FakeStore(makeRecord({}));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'create-plan', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ 'create-plan': { body: 'PlanX\n' } }),
    });
    expect(readEventActions(res)).toEqual([
      { action: 'attach', slug: 'create-plan', ok: true },
    ]);
    expect(res.preamble).toContain('### Skill attached: create-plan');
    expect(res.preamble).toContain('PlanX');
    expect(res.attachedSlugs).toEqual(['create-plan']);
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]!.meta.attachedSkills).toBe('["create-plan"]');
  });

  it('later turn re-applies a sticky skill from meta without a new attach event', async () => {
    const store = new FakeStore(makeRecord({ attachedSkills: '["create-plan"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'none' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ 'create-plan': { body: 'Body after edit' } }),
    });
    // Sticky re-resolve is SILENT (no display event), body re-read applies edit.
    expect(res.events).toHaveLength(0);
    expect(res.preamble).toContain('Body after edit');
    expect(res.attachedSlugs).toEqual(['create-plan']);
  });

  it('unknown/foreign slug → fail closed (no inject, no leak), event ok:false', async () => {
    const store = new FakeStore(makeRecord({}));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'does-not-exist', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ 'does-not-exist': null }),
    });
    expect(readEventActions(res)).toEqual([
      { action: 'attach', slug: 'does-not-exist', ok: false },
    ]);
    expect(res.preamble).toBeUndefined();
    expect(res.attachedSlugs).toEqual([]);
  });

  it('invalid slug shape → fail closed with reason invalid', async () => {
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'Bad Slug!', rest: '' },
      userSkills: readerOf({}),
    });
    expect(res.events[0]).toMatchObject({ action: 'attach', ok: false, reason: 'invalid slug' });
    expect(res.preamble).toBeUndefined();
  });

  it('/unskill removes a sticky slug, stops re-injecting, persists removal', async () => {
    const store = new FakeStore(makeRecord({ attachedSkills: '["a","b"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'detach', slug: 'a', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ a: { body: 'A' }, b: { body: 'B' } }),
    });
    expect(readEventActions(res)).toEqual([
      { action: 'detach', slug: 'a', ok: true },
    ]);
    expect(res.preamble).toContain('### Skill attached: b');
    expect(res.preamble).not.toContain('### Skill attached: a');
    expect(store.puts[0]!.meta.attachedSkills).toBe('["b"]');
  });

  it('/unskill a not-attached slug is a no-op with ok:false', async () => {
    const store = new FakeStore(makeRecord({ attachedSkills: '["b"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'detach', slug: 'zzz', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ b: { body: 'B' } }),
    });
    expect(readEventActions(res)).toEqual([
      { action: 'detach', slug: 'zzz', ok: false },
    ]);
    expect(res.attachedSlugs).toEqual(['b']);
  });

  it('no session store/key → attach still injects THIS turn, no sticky persist', async () => {
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'x', rest: '' },
      userSkills: readerOf({ x: { body: 'Offline safe' } }),
    });
    expect(readEventActions(res)).toEqual([{ action: 'attach', slug: 'x', ok: true }]);
    expect(res.preamble).toContain('Offline safe');
  });

  it('store get THROWS → fail open: attach injects this turn, sticky skipped', async () => {
    const throwingStore = {
      async get() {
        throw new Error('redis down');
      },
      async put() {
        throw new Error('should not be called');
      },
    };
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'x', rest: '' },
      sessionStore: throwingStore,
      sessionKey: KEY,
      userSkills: readerOf({ x: { body: 'Blip safe' } }),
    });
    expect(res.preamble).toContain('Blip safe');
    expect(readEventActions(res)).toEqual([{ action: 'attach', slug: 'x', ok: true }]);
  });

  it('store put THROWS → fail open (inject this turn, sticky write skipped)', async () => {
    const store = {
      async get() {
        return makeRecord({});
      },
      async put() {
        throw new Error('redis down');
      },
    };
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'x', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ x: { body: 'Resilient' } }),
    });
    expect(res.preamble).toContain('Resilient');
    expect(readEventActions(res)).toEqual([{ action: 'attach', slug: 'x', ok: true }]);
  });

  it('malformed stored attachedSkills fails closed (no sticky, attach may still work)', async () => {
    const store = new FakeStore(makeRecord({ attachedSkills: 'not-json' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'x', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ x: { body: 'New skill' } }),
    });
    // No prior sticky skills survive a corrupt blob (fail closed); the fresh
    // attach still resolves + injects, and the sticky set is rewritten cleanly.
    expect(res.preamble).toContain('### Skill attached: x');
    expect(res.attachedSlugs).toEqual(['x']);
    expect(store.puts[0]!.meta.attachedSkills).toBe('["x"]');
  });

  it('sticky skill whose body no longer resolves silently stops attaching', async () => {
    const store = new FakeStore(makeRecord({ attachedSkills: '["deleted","kept"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'none' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ deleted: null, kept: { body: 'K' } }),
    });
    expect(res.preamble).toContain('### Skill attached: kept');
    expect(res.preamble).not.toContain('deleted');
    expect(res.attachedSlugs).toEqual(['kept']);
    // persisted set drops the dead slug
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]!.meta.attachedSkills).toBe('["kept"]');
  });
});
