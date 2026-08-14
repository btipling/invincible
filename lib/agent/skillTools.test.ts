import { describe, expect, it, vi } from 'vitest';
import {
  createSkillTools,
  SKILL_TOOLS_ONLY_SYSTEM,
  SKILL_TOOLS_SYSTEM_ADDENDUM,
  type SkillSummary,
  type UserSkillsLike,
} from './skillTools';
import {
  SKILL_FETCH_MAX_RETURN_BYTES,
  SKILL_FIND_RESULT_MAX,
} from '../sessionCloudCaps';

/** AI SDK tool.execute options (mirrors lib/agent/httpFetchTools.test.ts). */
const execOpts = { toolCallId: '1', messages: [] } as never;

function makeSummary(
  opts: Partial<SkillSummary & { body: string }>,
): SkillSummary & { body: string } {
  return {
    slug: opts.slug ?? 'create-plan',
    name: opts.name ?? 'Create plan',
    description: opts.description ?? 'Builds a plan issue',
    body: opts.body ?? 'Plaintext skill body.',
  };
}

function makeUserSkills(
  overrides: Partial<UserSkillsLike> = {},
): UserSkillsLike {
  const summaries = [
    makeSummary({ slug: 'create-plan', name: 'Create plan', description: 'writes a plan issue' }),
    makeSummary({ slug: 'fetch-http', name: 'HTTP fetch', description: 'gets public pages' }),
    makeSummary({ slug: 'review-pr', name: 'Review PR', description: 'adversarial review' }),
  ];
  const fns: UserSkillsLike = {
    listUserSkills: vi.fn(async (_userId: string) => ({
      ok: true as const,
      value: summaries.map(({ body: _b, ...rest }) => rest),
    })),
    getSkillBySlug: vi.fn(async (_userId: string, slug: string) => {
      const hit = summaries.find((s) => s.slug === slug);
      if (!hit) return { ok: true as const, value: null };
      return { ok: true as const, value: hit };
    }),
  };
  return {
    listUserSkills: overrides.listUserSkills ?? fns.listUserSkills,
    getSkillBySlug: overrides.getSkillBySlug ?? fns.getSkillBySlug,
  };
}

describe('createSkillTools', () => {
  it('exposes exactly find_skill and fetch_skill', async () => {
    const tools = createSkillTools({ userId: 'user-1', userSkills: makeUserSkills() });
    expect(Object.keys(tools).sort()).toEqual(['fetch_skill', 'find_skill']);
    await tools.find_skill.execute!({ query: '' }, execOpts);
    await tools.fetch_skill.execute!({ slug: 'x' }, execOpts);
  });

  it('find_skill: returns only caller-scoped matching summaries (case-insensitive substring)', async () => {
    const us = makeUserSkills();
    const { find_skill } = createSkillTools({ userId: 'user-1', userSkills: us });
    const out = String(await find_skill.execute!({ query: 'PLAN' }, execOpts));
    expect(out).toContain('create-plan');
    expect(out).not.toContain('fetch-http');
    expect(us.listUserSkills).toHaveBeenCalledWith('user-1');
  });

  it('find_skill: empty/whitespace query returns a bounded listing (top SKILL_FIND_RESULT_MAX)', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      makeSummary({ slug: `s-${i}`, name: `Skill ${i}`, description: '' }),
    );
    const us = makeUserSkills({
      listUserSkills: vi.fn(async () => ({
        ok: true as const,
        value: many.map(({ body: _b, ...rest }) => rest),
      })),
    });
    const { find_skill } = createSkillTools({ userId: 'user-1', userSkills: us });
    const out = String(await find_skill.execute!({}, execOpts));
    const lines = out.split('\n').filter((l) => /^s-\d+ — /.test(l));
    expect(lines.length).toBe(SKILL_FIND_RESULT_MAX);
    expect(out).toContain(`[${many.length - SKILL_FIND_RESULT_MAX} more matches]`);
  });

  it('find_skill: zero skills → friendly empty result, tool still callable', async () => {
    const us = makeUserSkills({
      listUserSkills: vi.fn(async () => ({ ok: true as const, value: [] })),
    });
    const { find_skill } = createSkillTools({ userId: 'user-1', userSkills: us });
    expect(String(await find_skill.execute!({ query: 'anything' }, execOpts))).toBe(
      'No skills found.',
    );
  });

  it('find_skill: store error → soft-fail ERROR string (never throws)', async () => {
    const us = makeUserSkills({
      listUserSkills: vi.fn(async () => ({
        ok: false as const,
        code: 'unavailable',
        error: 'db down',
      })),
    });
    const { find_skill } = createSkillTools({ userId: 'user-1', userSkills: us });
    expect(String(await find_skill.execute!({ query: 'x' }, execOpts))).toContain(
      'ERROR find_skill',
    );
  });

  it('find_skill: never resolves bodies (summaries only on the wire)', async () => {
    const us = makeUserSkills();
    const { find_skill } = createSkillTools({ userId: 'user-1', userSkills: us });
    const out = String(await find_skill.execute!({ query: '' }, execOpts));
    expect(out).not.toContain('Plaintext skill body.');
    expect(us.getSkillBySlug).not.toHaveBeenCalled();
  });

  it("fetch_skill: returns the body for the caller's own skill (user-scoped)", async () => {
    const us = makeUserSkills();
    const { fetch_skill } = createSkillTools({ userId: 'user-1', userSkills: us });
    const out = String(await fetch_skill.execute!({ slug: 'create-plan' }, execOpts));
    expect(out).toContain('=== skill: create-plan ===');
    expect(out).toContain('Plaintext skill body.');
    expect(us.getSkillBySlug).toHaveBeenCalledWith('user-1', 'create-plan');
  });

  it('fetch_skill: unknown slug → not_found with no partial body', async () => {
    const us = makeUserSkills();
    const { fetch_skill } = createSkillTools({ userId: 'user-1', userSkills: us });
    const out = String(await fetch_skill.execute!({ slug: 'nope' }, execOpts));
    expect(out).toMatch(/not_found/);
    expect(out).not.toContain('=== skill:');
    expect(out).not.toContain('Plaintext skill body.');
  });

  it('fetch_skill: store error → soft-fail ERROR string (never throws)', async () => {
    const us = makeUserSkills({
      getSkillBySlug: vi.fn(async () => ({
        ok: false as const,
        code: 'unavailable',
        error: 'db down',
      })),
    });
    const { fetch_skill } = createSkillTools({ userId: 'user-1', userSkills: us });
    expect(String(await fetch_skill.execute!({ slug: 'x' }, execOpts))).toContain(
      'ERROR fetch_skill',
    );
  });

  it('fetch_skill: body > SKILL_FETCH_MAX_RETURN_BYTES → truncated with marker, never partial-not-found', async () => {
    const big = makeSummary({
      slug: 'big',
      name: 'Big',
      body: 'x'.repeat(SKILL_FETCH_MAX_RETURN_BYTES + 100),
    });
    const us = makeUserSkills({
      getSkillBySlug: vi.fn(async () => ({ ok: true as const, value: big })),
    });
    const { fetch_skill } = createSkillTools({ userId: 'user-1', userSkills: us });
    const out = String(await fetch_skill.execute!({ slug: 'big' }, execOpts));
    expect(out).toContain('=== skill: big ===');
    expect(out).toContain('[truncated');
    expect(out).toContain(`${SKILL_FETCH_MAX_RETURN_BYTES}`);
    expect(out).not.toMatch(/not_found/);
  });

  it('bound identity: execute ignores any input-provided identity and uses the route userId', async () => {
    const us = makeUserSkills();
    const { fetch_skill } = createSkillTools({ userId: 'user-1', userSkills: us });
    const input = { slug: 'create-plan', userId: 'attacker', tenantId: 'evil' } as never;
    await fetch_skill.execute!(input, execOpts);
    // The bound userSkills double records whatever userId the tool passed — it
    // must be the route userId, never the hostile input identity.
    const calls = (us.getSkillBySlug as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every((c) => c[0] === 'user-1')).toBe(true);
  });

  it('read-only: combined tools never call a write path', async () => {
    const us = makeUserSkills();
    const tools = createSkillTools({ userId: 'user-1', userSkills: us });
    await tools.find_skill.execute!({ query: '' }, execOpts);
    await tools.fetch_skill.execute!({ slug: 'create-plan' }, execOpts);
    // Only read fns may be touched.
    expect(us.listUserSkills).toHaveBeenCalled();
    expect(us.getSkillBySlug).toHaveBeenCalled();
  });
});

describe('skill tool system prompts (phase 3 #516)', () => {
  it('exports a SKILL addendum and a skill-only honest system', () => {
    expect(SKILL_TOOLS_SYSTEM_ADDENDUM).toContain('find_skill');
    expect(SKILL_TOOLS_SYSTEM_ADDENDUM).toContain('fetch_skill');
    expect(SKILL_TOOLS_ONLY_SYSTEM).toContain('find_skill');
    expect(SKILL_TOOLS_ONLY_SYSTEM).not.toContain('http_get');
  });
});
