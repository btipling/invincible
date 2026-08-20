import { describe, expect, it } from 'vitest';
import type {
  EnvelopeUpsertResult,
  SessionEnvelope,
  SessionEnvelopeInput,
} from '../sessions/sessionStore';
import {
  HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES,
  parseAttachedSkills,
  serializeAttachedSkills,
} from '../sessionCloudCaps';
import {
  buildSkillBlock,
  parseSkillCommand,
  resolveSkillPreamble,
  type ParsedSkillCommand,
  type SessionStoreEnvelope,
  type SkillBodyReader,
} from './skillInject';

const KEY = {
  tenantId: 'tenant1',
  userId: 'user1',
  sessionId: 'sess_abc123',
};

function makeEnvelope(meta: SessionEnvelope['meta']): SessionEnvelope {
  return {
    id: KEY.sessionId,
    tenantId: KEY.tenantId,
    userId: KEY.userId,
    createdAt: 1,
    updatedAt: 1,
    meta,
  };
}

/** In-memory fake implementing the phase-0 ENVELOPE session-store seam. */
class FakeStore implements SessionStoreEnvelope {
  env: SessionEnvelope | null;
  upserts: SessionEnvelopeInput[] = [];
  constructor(env: SessionEnvelope | null) {
    this.env = env;
  }
  async readEnvelope(key: { sessionId: string }) {
    if (key.sessionId !== KEY.sessionId) return null;
    return this.env;
  }
  async upsertEnvelope(
    _key: unknown,
    input: SessionEnvelopeInput,
  ): Promise<EnvelopeUpsertResult> {
    this.env = {
      id: input.id,
      userId: input.userId,
      tenantId: input.tenantId,
      createdAt: this.env?.createdAt ?? 1,
      updatedAt: input.updatedAt,
      meta: input.meta ?? {},
    };
    this.upserts.push(input);
    return { status: 'stored', envelope: this.env };
  }
}

function readerOf(rows: Partial<Record<string, { body: string } | null>>): SkillBodyReader {
  return {
    async getSkillBySlug(_userId: string, slug: string) {
      const row = rows[slug];
      return { ok: true as const, value: row ?? null };
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

  it('/unskill with no slug falls through (attaches the `unskill` token)', () => {
    const p = parseSkillCommand('/unskill');
    expect(p.type).toBe('attach');
    expect((p as { slug: string }).slug).toBe('unskill');
  });
});

describe('parseAttachedSkills / serializeAttachedSkills (caps seam)', () => {
  it('parses a well-formed JSON-array string of slugs; drops dups + invalid', () => {
    expect(parseAttachedSkills('["a","b"]')).toEqual(['a', 'b']);
    expect(parseAttachedSkills('["a","a"]')).toEqual(['a']);
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
  it('attach resolves + injects THIS turn and persists the sticky set via the envelope', async () => {
    const store = new FakeStore(makeEnvelope({}));
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
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["create-plan"]');
  });

  it('envelope persist keeps updatedAt UNCHANGED (never bumps the clock)', async () => {
    const store = new FakeStore(makeEnvelope({}));
    await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'x', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ x: { body: 'X' } }),
    });
    expect(store.upserts[0]!.updatedAt).toBe(1); // = envelope.updatedAt, not Date.now()
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["x"]');
  });

  it('later turn re-applies a sticky skill from meta without a new attach event', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["create-plan"]' }));
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
    const store = new FakeStore(makeEnvelope({}));
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
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["a","b"]' }));
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
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["b"]');
  });

  it('re-attach of an already-attached slug is idempotent (dedupes, no duplicate events)', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["a"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'a', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ a: { body: 'A' } }),
    });
    expect(res.attachedSlugs).toEqual(['a']);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["a"]');
    // A successful (idempotent) re-attach still emits a confirmation event.
    expect(readEventActions(res)).toEqual([{ action: 'attach', slug: 'a', ok: true }]);
  });

  it('/unskill a not-attached slug is a no-op with ok:false', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["b"]' }));
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

  it('store readEnvelope THROWS → fail open: attach injects this turn, sticky skipped', async () => {
    const throwingStore = {
      async readEnvelope() {
        throw new Error('redis down');
      },
      async upsertEnvelope() {
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

  it('store upsertEnvelope THROWS → fail open (inject this turn, sticky write skipped)', async () => {
    const store = {
      async readEnvelope() {
        return makeEnvelope({});
      },
      async upsertEnvelope() {
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

  it('malformed stored attachedSkills fails closed (no sticky, fresh attach still works)', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: 'not-json' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'x', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ x: { body: 'New skill' } }),
    });
    expect(res.preamble).toContain('### Skill attached: x');
    expect(res.attachedSlugs).toEqual(['x']);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["x"]');
  });

  it('sticky skill whose body no longer resolves silently stops attaching', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["deleted","kept"]' }));
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
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["kept"]');
  });
});

describe('resolveSkillPreamble — inject byte budget (adversarial-review L5 + "silent lie" fix)', () => {
  const bigBody = 'x'.repeat(HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES + 1);
  const fitsBody = 'y'.repeat(HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES - 1024);

  it('rejects an attach whose body alone exceeds the inject budget (too_large), never adds the slug', async () => {
    const store = new FakeStore(makeEnvelope({}));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'huge', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ huge: { body: bigBody } }),
    });
    expect(res.events[0]).toMatchObject({
      action: 'attach',
      slug: 'huge',
      ok: false,
      reason: 'too_large',
    });
    // The too-big skill is NEVER added to the sticky set (no silent never-injected attach).
    expect(res.attachedSlugs).toEqual([]);
    expect(res.preamble).toBeUndefined();
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('[]');
  });

  it('rejects an attach that fits alone but not alongside the attached set (budget)', async () => {
    // `a` consumes nearly the whole budget; the new `b` cannot fit → `budget`.
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["a"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'b', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ a: { body: fitsBody }, b: { body: fitsBody } }),
    });
    expect(res.events[0]).toMatchObject({
      action: 'attach',
      slug: 'b',
      ok: false,
      reason: 'budget',
    });
    expect(res.attachedSlugs).toEqual(['a']);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["a"]');
  });

  it('an attach that fits is accepted and injected even when large', async () => {
    const midBody = 'm'.repeat(64 * 1024); // 64 KiB — well within budget
    const store = new FakeStore(makeEnvelope({}));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'big-but-ok', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ 'big-but-ok': { body: midBody } }),
    });
    expect(res.events[0]).toMatchObject({ action: 'attach', slug: 'big-but-ok', ok: true });
    expect(res.attachedSlugs).toEqual(['big-but-ok']);
    expect(res.preamble).toContain('### Skill attached: big-but-ok');
  });

  it('a sticky slug that outgrew the budget drops from the PREAMBLE but stays ATTACHED (no silent dis-attach)', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["big","small"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'none' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({
        big: { body: 'x'.repeat(HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES + 1) },
        small: { body: 'tiny' },
      }),
    });
    // The oversized sticky slug is not injected this turn…
    expect(res.preamble).not.toContain('### Skill attached: big');
    expect(res.preamble).toContain('### Skill attached: small');
    // …but it stays attached (a sticky set is not silently dis-attached)…
    expect(res.attachedSlugs).toEqual(['big', 'small']);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["big","small"]');
  });
});

describe('resolveSkillPreamble — always-on auto-attach (plan #720 phase 2)', () => {
  it('always-on slugs are prepended before sticky set, never persisted to meta', async () => {
    const store = new FakeStore(
      makeEnvelope({ attachedSkills: '["sticky"]' }),
    );
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'none' },
      sessionStore: store,
      sessionKey: KEY,
      alwaysOnSlugs: ['always-slug'],
      userSkills: readerOf({
        'always-slug': { body: 'always-on body' },
        sticky: { body: 'sticky body' },
      }),
    });

    // Both are injected, always-on first in preamble order.
    expect(res.preamble).toContain('### Skill attached: always-slug');
    expect(res.preamble).toContain('### Skill attached: sticky');
    const alwaysIdx = res.preamble!.indexOf('always-slug');
    const stickyIdx = res.preamble!.indexOf('sticky');
    expect(alwaysIdx).toBeLessThan(stickyIdx);

    // Both are in attachedSlugs (resolved set).
    expect(res.attachedSlugs).toContain('always-slug');
    expect(res.attachedSlugs).toContain('sticky');

    // Persisted sticky set does NOT include the always-on slug.
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["sticky"]');
  });

  it('always-on slugs are de-duplicated against sticky set', async () => {
    const store = new FakeStore(
      makeEnvelope({ attachedSkills: '["shared"]' }),
    );
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'none' },
      sessionStore: store,
      sessionKey: KEY,
      alwaysOnSlugs: ['shared'],
      userSkills: readerOf({ shared: { body: 'shared body' } }),
    });

    // Injected exactly once (de-duped).
    const blocks =
      res.preamble?.match(/### Skill attached: shared/g) ?? [];
    expect(blocks).toHaveLength(1);

    // attachedSlugs has it once.
    expect(res.attachedSlugs.filter((s) => s === 'shared')).toHaveLength(1);

    // Persisted set is empty (shared is always-on, not sticky).
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('[]');
  });

  it('/unskill cannot detach an always-on slug', async () => {
    const store = new FakeStore(
      makeEnvelope({}),
    );
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'detach', slug: 'always-slug', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      alwaysOnSlugs: ['always-slug'],
      userSkills: readerOf({ 'always-slug': { body: 'always-on body' } }),
    });

    // always-slug still injected (cannot be detached).
    expect(res.preamble).toContain('### Skill attached: always-slug');

    // Detach event reports not_attached because the slug was not in the
    // detachable (sticky) set.
    const detachEv = res.events.find(
      (e) => e.action === 'detach' && e.slug === 'always-slug',
    );
    expect(detachEv?.ok).toBe(false);
  });

  it('dangling always-on slug (skill deleted) is silently skipped', async () => {
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'none' },
      alwaysOnSlugs: ['deleted-slug'],
      userSkills: readerOf({}), // skill does not exist
    });

    expect(res.preamble).toBeUndefined();
    expect(res.attachedSlugs).toEqual([]);
  });
});
