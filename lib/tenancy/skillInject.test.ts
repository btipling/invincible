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
  buildCatalogLine,
  buildSkillBlock,
  parseSkillCommand,
  resolveSkillPreamble,
  type ParsedSkillCommand,
  type SessionStoreEnvelope,
  type SkillBodyReader,
  type SkillSummaryLister,
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

/** In-memory fake for the catalog seam (summaries only, no body). */
function listerOf(
  rows: { slug: string; name: string; description: string }[],
): SkillSummaryLister {
  return {
    async listUserSkills(_userId: string) {
      return { ok: true as const, value: rows };
    },
  };
}

/** Catalog lister that fails like the store (ok:false / throw). */
function failingLister(mode: 'ok-false' | 'throw'): SkillSummaryLister {
  return {
    async listUserSkills() {
      if (mode === 'throw') throw new Error('store down');
      return { ok: false as const, code: 'unavailable', error: 'down' };
    },
  };
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

/** Standard catalog fixture used across the catalog tests. */
const CATALOG_ROWS = [
  { slug: 'create-plan', name: 'Create plan', description: 'writes a plan issue' },
  { slug: 'review', name: 'Review', description: 'adversarial reviewer' },
];

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

describe('buildSkillBlock (retired body-block helper)', () => {
  it('labels the block with the slug', () => {
    expect(buildSkillBlock('create-plan', 'Plan sections:\n- goals')).toBe(
      '### Skill attached: create-plan\nPlan sections:\n- goals',
    );
  });
});

describe('buildCatalogLine', () => {
  it('formats one catalog line: slug first, then name, then description', () => {
    expect(
      buildCatalogLine({
        slug: 'create-plan',
        name: 'Create plan',
        description: 'writes a plan issue',
      }),
    ).toBe('`create-plan` — Create plan: writes a plan issue');
  });

  it('omits the description separator when the description is empty', () => {
    expect(buildCatalogLine({ slug: 'a', name: 'A', description: '' })).toBe(
      '`a` — A',
    );
  });
});

describe('resolveSkillPreamble — catalog inject (plan #557 / #931)', () => {
  it('injects a catalog of slug+name+description lines with NO body text', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["create-plan","review"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'none' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({
        'create-plan': { body: 'PLAN BODY SECRETMARKER' },
        review: { body: 'REVIEW BODY SECRETMARKER' },
      }),
      listUserSkills: listerOf(CATALOG_ROWS),
    });
    // Catalog lines present (slug first, find_skill summary shape).
    expect(res.preamble).toContain(
      '`create-plan` — Create plan: writes a plan issue',
    );
    expect(res.preamble).toContain('`review` — Review: adversarial reviewer');
    // NO bodies in the inject.
    expect(res.preamble).not.toContain('PLAN BODY');
    expect(res.preamble).not.toContain('REVIEW BODY');
    expect(res.preamble).not.toContain('### Skill attached:');
    // Sticky slugs still resolve and persist.
    expect(res.attachedSlugs).toEqual(['create-plan', 'review']);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["create-plan","review"]');
  });

  it('catalog covers sticky ∪ always-on, de-duplicated, always-on first and never persisted', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["sticky"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'none' },
      sessionStore: store,
      sessionKey: KEY,
      alwaysOnSlugs: ['shared', 'always-slug'],
      userSkills: readerOf({
        'always-slug': { body: 'B' },
        shared: { body: 'B' },
        sticky: { body: 'B' },
      }),
      listUserSkills: listerOf([
        { slug: 'always-slug', name: 'Always', description: 'always-on' },
        { slug: 'shared', name: 'Shared', description: 'both' },
        { slug: 'sticky', name: 'Sticky', description: 'session attach' },
      ]),
    });
    // All three listed exactly once; always-on first in catalog order.
    expect(res.preamble).toContain('`always-slug` — Always: always-on');
    expect(res.preamble).toContain('`shared` — Shared: both');
    expect(res.preamble).toContain('`sticky` — Sticky: session attach');
    expect((res.preamble?.match(/`shared`/g) ?? []).length).toBe(1);
    const alwaysIdx = res.preamble!.indexOf('`always-slug`');
    const stickyIdx = res.preamble!.indexOf('`sticky`');
    expect(alwaysIdx).toBeLessThan(stickyIdx);
    // Persisted sticky set does NOT include the always-on slugs.
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["sticky"]');
  });

  it('deleted/stale slug drops from the catalog AND the sticky set (no silent lie)', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["deleted","kept"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'none' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ deleted: null, kept: { body: 'K' } }),
      listUserSkills: listerOf([
        { slug: 'kept', name: 'Kept', description: 'still here' },
      ]),
    });
    expect(res.preamble).toContain('`kept` — Kept: still here');
    expect(res.preamble).not.toContain('deleted');
    expect(res.attachedSlugs).toEqual(['kept']);
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["kept"]');
  });

  it('a /skill-name attach adds the slug to the sticky set + emits skill_attached; the body is NOT in the preamble', async () => {
    const store = new FakeStore(makeEnvelope({}));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'create-plan', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ 'create-plan': { body: 'PLAN BODY SECRET' } }),
      listUserSkills: listerOf(CATALOG_ROWS),
    });
    expect(readEventActions(res)).toEqual([
      { action: 'attach', slug: 'create-plan', ok: true },
    ]);
    expect(res.preamble).toContain('`create-plan` — Create plan: writes a plan issue');
    expect(res.preamble).not.toContain('PLAN BODY SECRET');
    expect(res.attachedSlugs).toEqual(['create-plan']);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["create-plan"]');
  });

  it('an over-256 KiB skill can now attach + be catalog-listed (too_large retired)', async () => {
    const bigBody = 'x'.repeat(HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES + 1);
    const store = new FakeStore(makeEnvelope({}));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'huge', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ huge: { body: bigBody } }),
      listUserSkills: listerOf([
        { slug: 'huge', name: 'Huge', description: 'very large playbook' },
      ]),
    });
    // Attach succeeds — no body inject any more, so size is not an attach hazard.
    expect(readEventActions(res)).toEqual([{ action: 'attach', slug: 'huge', ok: true }]);
    expect(res.preamble).toContain('`huge` — Huge: very large playbook');
    expect(res.attachedSlugs).toEqual(['huge']);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["huge"]');
  });

  it('two large attached skills both catalog-list (budget retired; catalog stays tiny)', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["a"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'b', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ a: { body: 'A' }, b: { body: 'B' } }),
      listUserSkills: listerOf([
        { slug: 'a', name: 'A', description: 'first' },
        { slug: 'b', name: 'B', description: 'second' },
      ]),
    });
    expect(readEventActions(res)).toEqual([{ action: 'attach', slug: 'b', ok: true }]);
    expect(res.attachedSlugs).toEqual(['a', 'b']);
    expect(res.preamble).toContain('`a` — A: first');
    expect(res.preamble).toContain('`b` — B: second');
  });

  it('store listUserSkills error → fail-open: no catalog, command-applied set persisted (not omit, not detach-all)', async () => {
    for (const mode of ['ok-false', 'throw'] as const) {
      const store = new FakeStore(makeEnvelope({ attachedSkills: '["kept"]' }));
      const res = await resolveSkillPreamble({
        userId: KEY.userId,
        command: { type: 'none' },
        sessionStore: store,
        sessionKey: KEY,
        userSkills: readerOf({ kept: { body: 'K' } }),
        listUserSkills: failingLister(mode),
      });
      expect(res.preamble).toBeUndefined();
      // Command-applied set is returned and persisted so a later attach/detach
      // on this path is honored. `[]` would be host detach-all; omit would
      // undo an in-turn command. `["kept"]` is the pre-command set here.
      expect(res.attachedSlugs).toEqual(['kept']);
      expect(res.attachedSkills).toBe('["kept"]');
      expect(store.upserts).toHaveLength(1);
      expect(store.upserts[0]!.meta?.attachedSkills).toBe('["kept"]');
    }
  });

  it('store listUserSkills error + /skill-name attach persists the new slug (events ok:true is honest)', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["kept"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'create-plan', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({
        kept: { body: 'K' },
        'create-plan': { body: 'PLAN BODY' },
      }),
      listUserSkills: failingLister('ok-false'),
    });
    expect(res.preamble).toBeUndefined();
    expect(readEventActions(res)).toEqual([
      { action: 'attach', slug: 'create-plan', ok: true },
    ]);
    expect(res.attachedSlugs).toEqual(['kept', 'create-plan']);
    expect(res.attachedSkills).toBe('["kept","create-plan"]');
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["kept","create-plan"]');
  });

  it('store listUserSkills error + /unskill persists the removal (events ok:true is honest)', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["kept","other"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'detach', slug: 'kept', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ kept: { body: 'K' }, other: { body: 'O' } }),
      listUserSkills: failingLister('throw'),
    });
    expect(res.preamble).toBeUndefined();
    expect(readEventActions(res)).toEqual([
      { action: 'detach', slug: 'kept', ok: true },
    ]);
    expect(res.attachedSlugs).toEqual(['other']);
    expect(res.attachedSkills).toBe('["other"]');
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["other"]');
  });

  it('happy-path attach does not hydrate the body (existence is a summary lookup)', async () => {
    let bodyReads = 0;
    const reader: SkillBodyReader = {
      async getSkillBySlug(_userId, slug) {
        bodyReads += 1;
        return { ok: true as const, value: { body: `BODY-${slug}` } };
      },
    };
    const store = new FakeStore(makeEnvelope({}));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'create-plan', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: reader,
      listUserSkills: listerOf(CATALOG_ROWS),
    });
    expect(bodyReads).toBe(0);
    expect(readEventActions(res)).toEqual([
      { action: 'attach', slug: 'create-plan', ok: true },
    ]);
    expect(res.preamble).toContain('`create-plan` — Create plan: writes a plan issue');
    expect(res.preamble).not.toContain('BODY-create-plan');
  });

  it('unknown slug attach still fails closed (no leak, no sticky add)', async () => {
    const store = new FakeStore(makeEnvelope({}));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'does-not-exist', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ 'does-not-exist': null }),
      listUserSkills: listerOf(CATALOG_ROWS),
    });
    expect(readEventActions(res)).toEqual([
      { action: 'attach', slug: 'does-not-exist', ok: false },
    ]);
    expect(res.preamble).toBeUndefined();
    expect(res.attachedSlugs).toEqual([]);
  });

  it('no session store/key → attach still catalogs THIS turn, no sticky persist', async () => {
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'create-plan', rest: '' },
      userSkills: readerOf({ 'create-plan': { body: 'B' } }),
      listUserSkills: listerOf(CATALOG_ROWS),
    });
    expect(readEventActions(res)).toEqual([{ action: 'attach', slug: 'create-plan', ok: true }]);
    expect(res.preamble).toContain('`create-plan` — Create plan: writes a plan issue');
  });

  it('/unskill removes a sticky slug from the catalog and persists removal', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["a","b"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'detach', slug: 'a', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ a: { body: 'A' }, b: { body: 'B' } }),
      listUserSkills: listerOf([
        { slug: 'a', name: 'A', description: '' },
        { slug: 'b', name: 'B', description: '' },
      ]),
    });
    expect(readEventActions(res)).toEqual([{ action: 'detach', slug: 'a', ok: true }]);
    expect(res.preamble).toContain('`b` — B');
    expect(res.preamble).not.toContain('`a` — A');
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["b"]');
  });

  it('/unskill cannot detach an always-on slug (refused, stays in catalog)', async () => {
    const store = new FakeStore(makeEnvelope({}));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'detach', slug: 'always-slug', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      alwaysOnSlugs: ['always-slug'],
      userSkills: readerOf({ 'always-slug': { body: 'B' } }),
      listUserSkills: listerOf([
        { slug: 'always-slug', name: 'Always', description: 'on' },
      ]),
    });
    const detachEv = res.events.find(
      (e) => e.action === 'detach' && e.slug === 'always-slug',
    );
    expect(detachEv?.ok).toBe(false);
    expect(res.preamble).toContain('`always-slug` — Always: on');
  });

  it('dangling always-on slug (skill deleted) is silently skipped', async () => {
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'none' },
      alwaysOnSlugs: ['deleted-slug'],
      userSkills: readerOf({}), // skill does not exist
      listUserSkills: listerOf([]),
    });
    expect(res.preamble).toBeUndefined();
    expect(res.attachedSlugs).toEqual([]);
  });

  it('malformed stored attachedSkills fails closed (no sticky, fresh attach still works)', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: 'not-json' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'create-plan', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ 'create-plan': { body: 'B' } }),
      listUserSkills: listerOf(CATALOG_ROWS),
    });
    expect(res.preamble).toContain('`create-plan`');
    expect(res.attachedSlugs).toEqual(['create-plan']);
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
      listUserSkills: listerOf([{ slug: 'x', name: 'X', description: '' }]),
    });
    expect(store.upserts[0]!.updatedAt).toBe(1); // = envelope.updatedAt, not Date.now()
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["x"]');
  });

  it('store upsertEnvelope THROWS → fail open (catalog this turn, sticky write skipped)', async () => {
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
      command: { type: 'attach', slug: 'create-plan', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ 'create-plan': { body: 'B' } }),
      listUserSkills: listerOf(CATALOG_ROWS),
    });
    expect(res.preamble).toContain('`create-plan`');
    expect(readEventActions(res)).toEqual([{ action: 'attach', slug: 'create-plan', ok: true }]);
  });

  it('re-attach of an already-attached slug is idempotent (dedupes, one confirmation event)', async () => {
    const store = new FakeStore(makeEnvelope({ attachedSkills: '["a"]' }));
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'a', rest: '' },
      sessionStore: store,
      sessionKey: KEY,
      userSkills: readerOf({ a: { body: 'A' } }),
      listUserSkills: listerOf([{ slug: 'a', name: 'A', description: '' }]),
    });
    expect(res.attachedSlugs).toEqual(['a']);
    expect(store.upserts[0]!.meta?.attachedSkills).toBe('["a"]');
    expect(readEventActions(res)).toEqual([{ action: 'attach', slug: 'a', ok: true }]);
  });

  it('invalid slug shape → fail closed with reason invalid', async () => {
    const res = await resolveSkillPreamble({
      userId: KEY.userId,
      command: { type: 'attach', slug: 'Bad Slug!', rest: '' },
      userSkills: readerOf({}),
      listUserSkills: listerOf([]),
    });
    expect(res.events[0]).toMatchObject({ action: 'attach', ok: false, reason: 'invalid slug' });
    expect(res.preamble).toBeUndefined();
  });
});
