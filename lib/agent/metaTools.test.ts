import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createMetaPersonaSkillTools,
  isMetaToolName,
  META_TOOLS_SYSTEM_ADDENDUM,
  SKILL_META_ONLY_SYSTEM,
  type UserPersonasLike,
  type UserSkillsLike,
} from './metaTools';
import {
  META_USER_PERSONAS_MAX,
  META_USER_SKILLS_MAX,
  SKILL_FETCH_MAX_RETURN_BYTES,
} from '../sessionCloudCaps';

/** AI SDK tool.execute options (mirrors skillTools/httpFetchTools test pattern). */
const execOpts = { toolCallId: '1', messages: [] } as never;

type PRow = {
  id: string;
  name: string;
  slug: string;
  body: string;
  isDefault: boolean;
  updatedAt: Date;
};

type SRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  body: string;
  updatedAt: Date;
};

const PERSONA_BODY_CAP = 16 * 1024;
const PERSONA_NAME_MAX = 80;
const SKILL_NAME_MAX = 200;
const SKILL_BODY_CAP = 4 * 1024 * 1024;

/** Hand-rolled persona store-fake mirroring `services.userPersonas` semantics. */
function makePersonaFake(initial: PRow[] = []) {
  const rows: PRow[] = [...initial];
  let next = 10;
  const fake: UserPersonasLike = {
    async listUserPersonas() {
      return {
        ok: true,
        value: [...rows]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((r) => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            isDefault: r.isDefault,
            updatedAt: r.updatedAt,
          })),
      };
    },
    async getPersonaById(_u, id) {
      const r = rows.find((x) => x.id === id);
      return { ok: true, value: r ? { ...r } : null };
    },
    async createUserPersona(input) {
      if (!input.name || input.name.length > PERSONA_NAME_MAX) {
        return { ok: false, code: 'invalid_name', error: 'name invalid' };
      }
      if (Buffer.byteLength(input.body, 'utf8') > PERSONA_BODY_CAP) {
        return { ok: false, code: 'invalid_body', error: `body must be ≤ ${PERSONA_BODY_CAP} bytes` };
      }
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.slug)) {
        return { ok: false, code: 'invalid_slug', error: 'slug invalid' };
      }
      if (rows.some((r) => r.slug === input.slug)) {
        return { ok: false, code: 'duplicate_slug', error: 'slug already exists for user' };
      }
      const id = `p${next++}`;
      if (input.isDefault === true) rows.forEach((r) => (r.isDefault = false));
      rows.push({
        id,
        name: input.name,
        slug: input.slug,
        body: input.body,
        isDefault: input.isDefault === true,
        updatedAt: new Date(),
      });
      return { ok: true, value: { id } };
    },
    async renameUserPersona(_u, id, name) {
      const r = rows.find((x) => x.id === id);
      if (!r) return { ok: false, code: 'not_found', error: 'persona not found' };
      r.name = name;
      r.updatedAt = new Date();
      return { ok: true, value: { id } };
    },
    async updateUserPersonaBody(_u, id, body) {
      const r = rows.find((x) => x.id === id);
      if (!r) return { ok: false, code: 'not_found', error: 'persona not found' };
      if (Buffer.byteLength(body, 'utf8') > PERSONA_BODY_CAP) {
        return { ok: false, code: 'invalid_body', error: `body must be ≤ ${PERSONA_BODY_CAP} bytes` };
      }
      r.body = body;
      r.updatedAt = new Date();
      return { ok: true, value: { id } };
    },
    async setDefaultPersona(_u, id) {
      const r = rows.find((x) => x.id === id);
      if (!r) return { ok: false, code: 'not_found', error: 'persona not found' };
      rows.forEach((x) => (x.isDefault = false));
      r.isDefault = true;
      return { ok: true, value: { id } };
    },
    async clearDefaultPersona() {
      rows.forEach((r) => (r.isDefault = false));
      return { ok: true, value: { cleared: true } };
    },
    async deleteUserPersona(_u, id) {
      const i = rows.findIndex((x) => x.id === id);
      if (i < 0) return { ok: false, code: 'not_found', error: 'persona not found' };
      rows.splice(i, 1);
      return { ok: true, value: { id } };
    },
  };
  return { fake, rows };
}

/** Hand-rolled skill store-fake mirroring `services.userSkills` semantics. */
function makeSkillFake(initial: SRow[] = []) {
  const rows: SRow[] = [...initial];
  let next = 10;
  const fake: UserSkillsLike = {
    async listUserSkills() {
      return {
        ok: true,
        value: [...rows]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((r) => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            description: r.description,
            updatedAt: r.updatedAt,
          })),
      };
    },
    async getSkillBySlug(_u, slug) {
      const r = rows.find((x) => x.slug === slug);
      return { ok: true, value: r ? { ...r } : null };
    },
    async getSkillById(_u, id) {
      const r = rows.find((x) => x.id === id);
      return { ok: true, value: r ? { ...r } : null };
    },
    async createUserSkill(input) {
      if (!input.name || input.name.length > SKILL_NAME_MAX) {
        return { ok: false, code: 'invalid_name', error: 'name invalid' };
      }
      if (Buffer.byteLength(input.body, 'utf8') > SKILL_BODY_CAP) {
        return { ok: false, code: 'invalid_body', error: `body must be ≤ ${SKILL_BODY_CAP} bytes` };
      }
      if (!/^[a-z][a-z0-9_-]{0,127}$/.test(input.slug)) {
        return { ok: false, code: 'invalid_slug', error: 'slug invalid' };
      }
      if (rows.some((r) => r.slug === input.slug)) {
        return { ok: false, code: 'duplicate_slug', error: 'slug already exists for user' };
      }
      const id = `s${next++}`;
      rows.push({
        id,
        name: input.name,
        slug: input.slug,
        description: input.description ?? '',
        body: input.body,
        updatedAt: new Date(),
      });
      return { ok: true, value: { id } };
    },
    async updateUserSkillSummary(_u, id, input) {
      const r = rows.find((x) => x.id === id);
      if (!r) return { ok: false, code: 'not_found', error: 'skill not found' };
      r.name = input.name;
      if (input.description !== undefined) r.description = input.description;
      r.updatedAt = new Date();
      return { ok: true, value: { id } };
    },
    async updateUserSkillBody(_u, id, body) {
      const r = rows.find((x) => x.id === id);
      if (!r) return { ok: false, code: 'not_found', error: 'skill not found' };
      if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body, 'utf8') > SKILL_BODY_CAP) {
        return {
          ok: false,
          code: 'invalid_body',
          error: `body is required and must be ≤ ${SKILL_BODY_CAP} bytes`,
        };
      }
      r.body = body;
      r.updatedAt = new Date();
      return { ok: true, value: { id } };
    },
    async deleteUserSkill(_u, id) {
      const i = rows.findIndex((x) => x.id === id);
      if (i < 0) return { ok: false, code: 'not_found', error: 'skill not found' };
      rows.splice(i, 1);
      return { ok: true, value: { id } };
    },
  };
  return { fake, rows };
}

function extractId(msg: string, label: string): string {
  const m = msg.match(new RegExp(`${label}=([^\\s]+)`));
  if (!m) throw new Error(`no ${label} in "${msg}"`);
  return m[1];
}

describe('createMetaPersonaSkillTools — persona family', () => {
  let pFake: ReturnType<typeof makePersonaFake>;
  let tools: ReturnType<typeof createMetaPersonaSkillTools>;

  beforeEach(() => {
    pFake = makePersonaFake();
    const sFake = makeSkillFake();
    tools = createMetaPersonaSkillTools({
      userId: 'user-1',
      userPersonas: pFake.fake,
      userSkills: sFake.fake,
    });
  });

  it('lists own personas with summary only (no body) and empty case', async () => {
    expect(String(await tools.meta_persona_list.execute!({}, execOpts))).toBe(
      'No personas found.',
    );

    const c = String(
      await tools.meta_persona_create.execute!(
        { name: 'Senior Agent', body: 'be careful' },
        execOpts,
      ),
    );
    expect(c).toContain('slug=senior_agent'); // derived slug when omitted
    const listed = String(await tools.meta_persona_list.execute!({}, execOpts));
    expect(listed).toContain('id=');
    expect(listed).toContain('Senior Agent');
    expect(listed).not.toContain('be careful'); // no body in list
  });

  it('read own by id returns body; unknown id → not_found, no partial', async () => {
    const c = String(
      await tools.meta_persona_create.execute!(
        { name: 'Read Me', slug: 'read_me', body: 'secret body' },
        execOpts,
      ),
    );
    const id = extractId(c, 'id');
    const read = String(await tools.meta_persona_read.execute!({ id }, execOpts));
    expect(read).toContain('=== persona: read_me ===');
    expect(read).toContain('secret body');

    const missing = String(
      await tools.meta_persona_read.execute!({ id: 'pNOPE' }, execOpts),
    );
    expect(missing).toMatch(/^not_found: no persona with id "pNOPE"/);
    expect(missing).not.toContain('secret body'); // no-existence-leak / no partial
  });

  it('round-trips create → update_name → update_body → set_default → clear → delete', async () => {
    const c = String(
      await tools.meta_persona_create.execute!(
        { name: 'W', slug: 'w_persona', body: 'v1' },
        execOpts,
      ),
    );
    const id = extractId(c, 'id');

    const renamed = String(
      await tools.meta_persona_update_name.execute!({ id, name: 'W2' }, execOpts),
    );
    expect(renamed).toContain(`id=${id}`);

    const bodied = String(
      await tools.meta_persona_update_body.execute!({ id, body: 'v2' }, execOpts),
    );
    expect(bodied).toContain(`id=${id}`);
    expect(String(await tools.meta_persona_read.execute!({ id }, execOpts))).toContain('v2');

    const sod = String(
      await tools.meta_persona_create.execute!(
        { name: 'Def', slug: 'def_persona', body: 'd' },
        execOpts,
      ),
    );
    const defId = extractId(sod, 'id');
    const setDefault = String(
      await tools.meta_persona_set_default.execute!({ id: defId }, execOpts),
    );
    expect(setDefault).toContain(`id=${defId}`);
    expect(
      String(await tools.meta_persona_read.execute!({ id: defId }, execOpts)),
    ).toContain('[default]');
    // exactly one default: the other is no longer default
    expect(
      String(await tools.meta_persona_read.execute!({ id }, execOpts)),
    ).not.toContain('[default]');

    await tools.meta_persona_clear_default.execute!({}, execOpts);
    expect(
      String(await tools.meta_persona_read.execute!({ id: defId }, execOpts)),
    ).not.toContain('[default]');

    const del = String(await tools.meta_persona_delete.execute!({ id }, execOpts));
    expect(del).toContain(`id=${id}`);
    expect(String(await tools.meta_persona_read.execute!({ id }, execOpts))).toMatch(
      /^not_found:/,
    );
  });

  it('rejects an over-cap persona body on write (never truncates)', async () => {
    const big = 'x'.repeat(PERSONA_BODY_CAP + 1);
    const res = String(
      await tools.meta_persona_create.execute!(
        { name: 'Big', slug: 'big_persona', body: big },
        execOpts,
      ),
    );
    expect(res).toMatch(/^ERROR meta_persona_create:/);
    expect(res).toContain('body');
  });

  it('create-as-default flags it as the single default (clears siblings)', async () => {
    await tools.meta_persona_create.execute!(
      { name: 'A', slug: 'a_p', body: 'a', isDefault: true },
      execOpts,
    );
    const c = String(
      await tools.meta_persona_create.execute!(
        { name: 'B', slug: 'b_p', body: 'b', isDefault: true },
        execOpts,
      ),
    );
    expect(c).toContain('(default)');
    const listed = String(await tools.meta_persona_list.execute!({}, execOpts));
    const rows = listed.split('\n').filter((l) => l.includes('id='));
    // only one row carries [default]
    const defaults = rows.filter((r) => r.includes('[default]'));
    expect(defaults.length).toBe(1);
    expect(defaults[0]).toContain('b_p');
  });

  it('bound identity: execute ignores any model-passed identity (uses route userId)', async () => {
    const realP = makePersonaFake();
    const spy = vi.spyOn(realP.fake, 'listUserPersonas');
    const sFake = makeSkillFake();
    const t = createMetaPersonaSkillTools({
      userId: 'user-1',
      userPersonas: realP.fake,
      userSkills: sFake.fake,
    });
    const hostile = { userId: 'attacker', tenantId: 'evil' } as never;
    await t.meta_persona_list.execute!(hostile, execOpts);
    expect(spy).toHaveBeenCalledWith('user-1');
  });
});

describe('createMetaPersonaSkillTools — skill family', () => {
  let sFake: ReturnType<typeof makeSkillFake>;
  let tools: ReturnType<typeof createMetaPersonaSkillTools>;

  beforeEach(() => {
    const pFake = makePersonaFake();
    sFake = makeSkillFake();
    tools = createMetaPersonaSkillTools({
      userId: 'user-1',
      userPersonas: pFake.fake,
      userSkills: sFake.fake,
    });
  });

  it('round-trips create (derived hyphen slug) → read → update_summary → update_body → delete', async () => {
    const c = String(
      await tools.meta_skill_create.execute!(
        { name: 'My Skill', body: 'playbook v1 body', description: 'a test skill' },
        execOpts,
      ),
    );
    expect(c).toContain('slug=my_skill');
    const id = extractId(c, 'id');

    const read = String(await tools.meta_skill_read.execute!({ slug: 'my_skill' }, execOpts));
    expect(read).toContain('=== skill: my_skill ===');
    expect(read).toContain('playbook v1 body');

    const us = String(
      await tools.meta_skill_update_summary.execute!(
        { id, name: 'My Skill Renamed', description: 'updated desc' },
        execOpts,
      ),
    );
    expect(us).toContain(`id=${id}`);
    expect(
      String(await tools.meta_skill_read.execute!({ slug: 'my_skill' }, execOpts)),
    ).toContain('My Skill Renamed');

    const ub = String(
      await tools.meta_skill_update_body.execute!({ id, body: 'playbook v2' }, execOpts),
    );
    expect(ub).toContain(`id=${id}`);
    expect(
      String(await tools.meta_skill_read.execute!({ slug: 'my_skill' }, execOpts)),
    ).toContain('playbook v2');

    const del = String(await tools.meta_skill_delete.execute!({ id }, execOpts));
    expect(del).toContain(`id=${id}`);
    expect(
      String(await tools.meta_skill_read.execute!({ slug: 'my_skill' }, execOpts)),
    ).toMatch(/^not_found:/);
  });

  it('truncates an over-budget skill body on read with an explicit marker', async () => {
    const big = 'z'.repeat(SKILL_FETCH_MAX_RETURN_BYTES + 4096);
    const c = String(
      await tools.meta_skill_create.execute!({ name: 'Huge', slug: 'huge', body: big }, execOpts),
    );
    expect(c).toMatch(/^created skill/);
    const read = String(await tools.meta_skill_read.execute!({ slug: 'huge' }, execOpts));
    expect(read).toContain('[truncated to');
    expect(read).toContain('full body is');
  });

  it('rejects an over-cap (4 MiB) skill body on write', async () => {
    const tooBig = 'y'.repeat(SKILL_BODY_CAP + 1);
    const res = String(
      await tools.meta_skill_create.execute!({ name: 'Big', slug: 'big', body: tooBig }, execOpts),
    );
    expect(res).toMatch(/^ERROR meta_skill_create:/);
  });

  it('truncates a body at the byte cap WITHOUT splitting a UTF-8 code point', async () => {
    // A 2-byte rune that would straddle the cap boundary: prefix of (cap-1) ASCII
    // bytes puts 'é' exactly across the cut (bytes cap-1 and cap). Backoff to a
    // code-point boundary must yield cap-1 ASCII bytes — never a lone U+FFFD.
    const prefix = 'a'.repeat(SKILL_FETCH_MAX_RETURN_BYTES - 1);
    const body = prefix + 'é';
    const c = String(
      await tools.meta_skill_create.execute!({ name: 'Utf', slug: 'utf8', body }, execOpts),
    );
    expect(c).toMatch(/^created skill/);
    const read = String(await tools.meta_skill_read.execute!({ slug: 'utf8' }, execOpts));
    expect(read).toContain('[truncated to');
    expect(read).toContain('full body is');
    expect(read).not.toContain('\ufffd'); // never a split rune (no lone replacement char)
    expect(read.split('\n')[3]).toBe(prefix); // body line is exactly the clean prefix
  });
});

describe('createMetaPersonaSkillTools — meta_skill_str_replace', () => {
  let sFake: ReturnType<typeof makeSkillFake>;
  let tools: ReturnType<typeof createMetaPersonaSkillTools>;
  let skillId: string;

  beforeEach(async () => {
    const pFake = makePersonaFake();
    sFake = makeSkillFake();
    tools = createMetaPersonaSkillTools({
      userId: 'user-1',
      userPersonas: pFake.fake,
      userSkills: sFake.fake,
    });
    const c = String(
      await tools.meta_skill_create.execute!(
        { name: 'Patch Me', slug: 'patch_me', body: 'line one\n$& $1 x\ntail' },
        execOpts,
      ),
    );
    skillId = extractId(c, 'id');
  });

  it('single literal match replaces and writes; result one-liner, no body echo', async () => {
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'line one', new_string: 'line ONE' },
        execOpts,
      ),
    );
    expect(res).toMatch(/^replaced 1 occurrence\(s\) of old_string in skill id=/);
    expect(res).not.toContain('line ONE'); // one-liner — do not echo the new body
    expect(sFake.rows.find((r) => r.id === skillId)?.body).toContain('line ONE');
  });

  it('old_string absent → error, body unchanged (row 2)', async () => {
    const before = sFake.rows.find((r) => r.id === skillId)!.body;
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'nope', new_string: 'x' },
        execOpts,
      ),
    );
    expect(res).toMatch(/^ERROR meta_skill_str_replace:/);
    expect(res).toContain('not found');
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toBe(before);
  });

  it('multiple matches without replace_all → error, no write (row 3)', async () => {
    await tools.meta_skill_update_body.execute!({ id: skillId, body: 'ab ab ab' }, execOpts);
    const before = sFake.rows.find((r) => r.id === skillId)!.body;
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'ab', new_string: 'XY' },
        execOpts,
      ),
    );
    expect(res).toMatch(/^ERROR meta_skill_str_replace:/);
    expect(res).toContain('matched 3 times');
    expect(res).toContain('replace_all');
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toBe(before);
  });

  it('replace_all: true replaces every non-overlapping occurrence and counts N (row 4)', async () => {
    await tools.meta_skill_update_body.execute!({ id: skillId, body: 'ab ab ab' }, execOpts);
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'ab', new_string: 'XY', replace_all: true },
        execOpts,
      ),
    );
    expect(res).toMatch(/replaced 3 occurrence/);
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toBe('XY XY XY');
  });

  it('empty old_string → error (row 5)', async () => {
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: '', new_string: 'x' },
        execOpts,
      ),
    );
    expect(res).toMatch(/^ERROR meta_skill_str_replace:/);
    expect(res).toContain('old_string');
  });

  it('missing / foreign id → not_found, no partial (row 6)', async () => {
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: 'sNOPE', old_string: 'line one', new_string: 'x' },
        execOpts,
      ),
    );
    expect(res).toMatch(/^not_found: no skill with id "sNOPE"/);
    expect(res).not.toContain('line one'); // no body leak
  });

  it('fragment over 64 KiB (old or new) → rejected, no write (row 7)', async () => {
    const big = 'a'.repeat(64 * 1024 + 1);
    const resOld = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: big, new_string: 'x' },
        execOpts,
      ),
    );
    expect(resOld).toMatch(/^ERROR meta_skill_str_replace:/);
    expect(resOld).toContain('old_string exceeds');
    const resNew = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'line one', new_string: big },
        execOpts,
      ),
    );
    expect(resNew).toMatch(/^ERROR meta_skill_str_replace:/);
    expect(resNew).toContain('new_string exceeds');
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toContain('line one');
  });

  it('result body over the 4 MiB store cap → rejected, never truncated (row 8)', async () => {
    // Seed a body just under the 4 MiB store cap, then a str_replace where the
    // new_string (still under the 64 KiB fragment cap) pushes the FULL body over
    // the store cap. The store write must be rejected — never truncated.
    const nearCap = 'z'.repeat(SKILL_BODY_CAP - 100) + 'MARK';
    await tools.meta_skill_update_body.execute!({ id: skillId, body: nearCap }, execOpts);
    // new_string of max fragment size appended around the marker → total > 4 MiB.
    const grow = 'y'.repeat(64 * 1024);
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'MARK', new_string: grow },
        execOpts,
      ),
    );
    expect(res).toMatch(/^ERROR meta_skill_str_replace:/);
    expect(res).toContain('store\'s 4 MiB write cap');
    // Body unchanged (no write) — still the near-cap body with the marker.
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toBe(nearCap);
  });

  it('replace_all expansion past the store cap is rejected before split/join (no write)', async () => {
    // 32 KiB of 'x' × 64 KiB new_string would materialize ~2 GiB if split/join
    // ran. The byte pre-check must reject this in milliseconds.
    const repeated = 'x'.repeat(32 * 1024);
    await tools.meta_skill_update_body.execute!({ id: skillId, body: repeated }, execOpts);
    const grow = 'y'.repeat(64 * 1024);
    const started = Date.now();
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'x', new_string: grow, replace_all: true },
        execOpts,
      ),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res).toMatch(/^ERROR meta_skill_str_replace:/);
    expect(res).toContain('store\'s 4 MiB write cap');
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toBe(repeated);
  });

  it('empty new_string wiping the whole body → empty-body error, not over-cap', async () => {
    await tools.meta_skill_update_body.execute!({ id: skillId, body: 'hello' }, execOpts);
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'hello', new_string: '' },
        execOpts,
      ),
    );
    expect(res).toMatch(/^ERROR meta_skill_str_replace:/);
    expect(res).toContain('empty');
    expect(res).not.toContain('4 MiB');
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toBe('hello');
  });

  it('whitespace-only result is rejected with the store reason (not a 4 MiB lie)', async () => {
    await tools.meta_skill_update_body.execute!({ id: skillId, body: 'hello' }, execOpts);
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'hello', new_string: '   ' },
        execOpts,
      ),
    );
    expect(res).toMatch(/^ERROR meta_skill_str_replace:/);
    expect(res).toContain('body is required');
    expect(res).not.toMatch(/exceeds the store's 4 MiB write cap/);
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toBe('hello');
  });

  it('UTF-8 multi-byte rune in old_string matches correctly (row 9)', async () => {
    await tools.meta_skill_update_body.execute!({ id: skillId, body: 'café menü' }, execOpts);
    const res = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'é', new_string: 'E' },
        execOpts,
      ),
    );
    expect(res).toMatch(/replaced 1 occurrence/);
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toBe('cafE menü');
  });

  it('Markdown/$-template literals in new_string and regex metachars in old_string land verbatim (row 12)', async () => {
    // new_string carrying $-templates, a backtick, backslashes and regex
    // metacharacters must land EXACTLY literal — this mirrors the sandbox
    // str_replace regression tests ($& / $1 / $\' / $` / $$ are never
    // interpolated, unlike String.prototype.replace, and regex metachars in
    // EITHER string never compile to a pattern).
    const body = 'alpha BETA omega';
    await tools.meta_skill_update_body.execute!({ id: skillId, body }, execOpts);
    const resNew = String(
      await tools.meta_skill_str_replace.execute!(
        {
          id: skillId,
          old_string: 'BETA',
          new_string: '$& $1 $\' $` $$ ^[A-Za-z0-9_-]{1,128}$',
        },
        execOpts,
      ),
    );
    expect(resNew).toMatch(/replaced 1 occurrence/);
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toBe(
      // Exact-string, byte-for-byte: nothing was interpolated or treated as a
      // template/regex — 'BETA' was replaced with the literal replacement text.
      'alpha $& $1 $\' $` $$ ^[A-Za-z0-9_-]{1,128}$ omega',
    );

    // old_string that LOOKS like a regex matches ONLY the literal text, and a
    // regex-metachar-containing new_string lands verbatim again.
    const resOld = String(
      await tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: '^[A-Za-z0-9_-]{1,128}$', new_string: 'LITERAL' },
        execOpts,
      ),
    );
    expect(resOld).toMatch(/replaced 1 occurrence/);
    expect(sFake.rows.find((r) => r.id === skillId)!.body).toBe(
      'alpha $& $1 $\' $` $$ LITERAL omega',
    );
  });

  it('same-id parallel patches serialize (no silent hunk drop)', async () => {
    // Two concurrent str_replace calls on the SAME skill id. The lock must
    // serialize the read→write window — if it didn't, both would read v1 and
    // one write would be silently dropped (the #479 class). We use two
    // non-overlapping old_strings so both calls CAN succeed: each replaces a
    // distinct literal region. The second reader must see the first writer's
    // result, not a stale snapshot.
    await tools.meta_skill_update_body.execute!(
      { id: skillId, body: '[START]\nalpha\n[END]' },
      execOpts,
    );
    const [r1, r2] = await Promise.all([
      tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: 'alpha', new_string: 'ALPHA' },
        execOpts,
      ),
      tools.meta_skill_str_replace.execute!(
        { id: skillId, old_string: '[START]', new_string: '<<<' },
        execOpts,
      ),
    ]);
    const s1 = String(r1);
    const s2 = String(r2);
    // Both should succeed — replacements are on disjoint regions.
    expect(s1).toMatch(/replaced 1 occurrence/);
    expect(s2).toMatch(/replaced 1 occurrence/);
    // Final body must carry BOTH replacements — never the original, and never
    // missing one hunk.
    const final = sFake.rows.find((r) => r.id === skillId)!.body;
    expect(final).toContain('ALPHA');
    expect(final).toContain('<<<');
    expect(final).not.toContain('alpha'); // replaced by first
    expect(final).not.toContain('[START]'); // replaced by second
    // Lock: 1 occurrence each (no overlapping-match ambiguity).
  });
});

describe('createMetaPersonaSkillTools — per-user authoring ceilings (L5)', () => {
  it('rejects persona create when at/over the per-user ceiling; list is bounded', async () => {
    const { fake: pFake } = makePersonaFake();
    const { fake: sFake } = makeSkillFake();
    const t = createMetaPersonaSkillTools({
      userId: 'user-1',
      userPersonas: pFake,
      userSkills: sFake,
    });

    const m = META_USER_PERSONAS_MAX;
    for (let i = 0; i < m; i++) {
      const r = String(
        await t.meta_persona_create.execute!(
          { name: `P${i}`, slug: `p_${i}`, body: 'b' },
          execOpts,
        ),
      );
      expect(r).toMatch(/^created persona/);
    }
    // One more must be rejected at the ceiling.
    const reject = String(
      await t.meta_persona_create.execute!({ name: 'Over', slug: 'over', body: 'b' }, execOpts),
    );
    expect(reject).toMatch(/^ERROR meta_persona_create:/);
    expect(reject).toContain(`ceiling`);
    expect(reject).toContain(String(m));

    // list is bounded to the ceiling (not unbounded).
    const listed = String(await t.meta_persona_list.execute!({}, execOpts));
    const rows = listed.split('\n').filter((l) => l.includes('id='));
    expect(rows.length).toBe(m);
  });

  it('rejects skill create when at/over the per-user ceiling', async () => {
    const { fake: pFake } = makePersonaFake();
    const { fake: sFake } = makeSkillFake();
    const t = createMetaPersonaSkillTools({
      userId: 'user-1',
      userPersonas: pFake,
      userSkills: sFake,
    });

    const m = META_USER_SKILLS_MAX;
    for (let i = 0; i < m; i++) {
      const r = String(
        await t.meta_skill_create.execute!({ name: `S${i}`, slug: `s_${i}`, body: 'b' }, execOpts),
      );
      expect(r).toMatch(/^created skill/);
    }
    const reject = String(
      await t.meta_skill_create.execute!({ name: 'Over', slug: 'over', body: 'b' }, execOpts),
    );
    expect(reject).toMatch(/^ERROR meta_skill_create:/);
    expect(reject).toContain('ceiling');
    expect(reject).toContain(String(m));
  });
});

describe('createMetaPersonaSkillTools — separation + surface shape', () => {
  it('exposes only meta_* authoring tools (no find_skill/fetch_skill here)', () => {
    const { fake: pFake } = makePersonaFake();
    const { fake: sFake } = makeSkillFake();
    const tools = createMetaPersonaSkillTools({
      userId: 'user-1',
      userPersonas: pFake,
      userSkills: sFake,
    });
    const keys = Object.keys(tools).sort();
    expect(keys).toContain('meta_persona_list');
    expect(keys).toContain('meta_skill_list');
    expect(keys).toContain('meta_skill_read');
    expect(keys.every((k) => k.startsWith('meta_'))).toBe(true);
    expect(keys).not.toContain('find_skill');
    expect(keys).not.toContain('fetch_skill');
    expect(keys).toEqual(
      [
        'meta_persona_list',
        'meta_persona_read',
        'meta_persona_create',
        'meta_persona_update_name',
        'meta_persona_update_body',
        'meta_persona_set_default',
        'meta_persona_clear_default',
        'meta_persona_delete',
        'meta_skill_list',
        'meta_skill_read',
        'meta_skill_create',
        'meta_skill_update_summary',
        'meta_skill_update_body',
        'meta_skill_str_replace',
        'meta_skill_delete',
      ].sort(),
    );
  });

  it('isMetaToolName gates the reserved prefix for the route soft-path guard', () => {
    expect(isMetaToolName('meta_persona_list')).toBe(true);
    expect(isMetaToolName('meta_skill_read')).toBe(true);
    expect(isMetaToolName('find_skill')).toBe(false);
    expect(isMetaToolName('fetch_skill')).toBe(false);
    expect(isMetaToolName('mcp_foo')).toBe(false);
    expect(isMetaToolName('')).toBe(false);
  });

  it('carries a non-empty system addendum and a meta+skill-only honest system', () => {
    expect(META_TOOLS_SYSTEM_ADDENDUM.length).toBeGreaterThan(0);
    expect(META_TOOLS_SYSTEM_ADDENDUM).toContain('meta_persona_*');
    expect(SKILL_META_ONLY_SYSTEM).toContain('meta_persona_*');
    expect(SKILL_META_ONLY_SYSTEM).not.toContain('http_get');
  });
});
