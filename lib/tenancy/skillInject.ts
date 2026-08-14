/**
 * Skill attachment resolver (phase 2, #517).
 *
 * Server-side only. Turns `meta.attachedSkills` (a JSON array string of slugs)
 * into the agent-system preamble on every `/api/agent` turn, PLUS handles the
 * per-turn slash commands:
 *
 *   - `/skill-name`  → attach: resolve the body via `userSkills.getSkillBySlug`,
 *                      add the slug to the sticky set, inject its body.
 *   - `/unskill slug` → detach: remove the slug from the sticky set (no-op when
 *                      not-attached); the whole line is consumed (a pure
 *                      `/unskill` is a NO-MODEL turn — never forwarded empty to
 *                      the model).
 *
 * Unlike the locked persona (`meta.personaSnapshot`), skills are **staff of
 * work**, not identity: we store **slugs only** in `meta.attachedSkills` and
 * re-resolve their bodies from the store every turn. So a mid-session skill edit
 * applies next turn, and a deleted skill silently stops attaching. `meta` stays
 * small (slugs ≪ the meta cap).
 *
 * Fail-closed / offline-safe semantics mirror `personaInject`:
 *   - unknown / foreign / malformed slug → NO inject + a `{ ok:false }` event
 *     (never a leak): `getSkillBySlug` is tenant+user scoped and returns null
 *     for other-user rows.
 *   - store down OR no session key available → fail-open: the attach still
 *     resolves + injects THIS turn, only the sticky `meta.attachedSkills`
 *     persist is skipped (same as persona).
 *   - a malformed stored `attachedSkills` fails closed at read (defense in
 *     depth even beyond the write-side `validateMetaFields` branch).
 *
 * The session-store seam is injected so this module never constructs I/O
 * (di-gate).
 */
import type {
  HarnessSessionRecord,
  SessionRecordKey,
} from '../sessions/sessionStore';
import { SKILL_SLUG_RE } from './userSkills';

/** Attachment slash command: a bare leading `/slug` token. */
export const SKILL_COMMAND_RE = /^\/([a-z][a-z0-9_-]{0,127})(?:\s|$)/;
/** Detach slash command: `/unskill slug`. Must be checked BEFORE the attach RE. */
export const UNSKILL_COMMAND_RE = /^\/unskill\s+([a-z][a-z0-9_-]{0,127})(?:\s|$)/;

export type ParsedSkillCommand =
  | { type: 'none' }
  | { type: 'attach'; slug: string; rest: string }
  | { type: 'detach'; slug: string; rest: string };

/**
 * Parse the leading skill command from a normalized prompt. The `/unskill`
 * branch is checked first so it is never swallowed by the generic attach RE.
 * A bare (non-slug) `/`, or a message whose leading `/` isn't a valid slug
 * token, passes through as plain text. Detach consumes the WHOLE line
 * (`rest === ''`) — leftover prose after `/unskill` is never forwarded to the
 * model as a user turn.
 */
export function parseSkillCommand(prompt: string): ParsedSkillCommand {
  const text = typeof prompt === 'string' ? prompt : '';
  const detach = text.match(UNSKILL_COMMAND_RE);
  if (detach) {
    return { type: 'detach', slug: detach[1], rest: '' };
  }
  const attach = text.match(SKILL_COMMAND_RE);
  if (attach) {
    const rest = text.slice(attach[0].length).trimStart();
    return { type: 'attach', slug: attach[1], rest };
  }
  return { type: 'none' };
}

/** Minimal skill-body read seam (owned rows only; null = no-row / other-user). */
export type SkillBodyReader = {
  getSkillBySlug(
    userId: string,
    slug: string,
  ): Promise<
    | { ok: true; value: { body: string } | null }
    | { ok: false; error: string }
  >;
};

/** Minimal scoped session-store read/write seam (identity-bound, validated keys). */
export type SessionStoreLite = {
  get(key: SessionRecordKey): Promise<HarnessSessionRecord | null>;
  put(
    key: SessionRecordKey,
    record: HarnessSessionRecord,
  ): Promise<{ status: 'stored' | 'conflict' }>;
};

export type SkillEvent =
  | { action: 'attach'; slug: string; ok: true }
  | { action: 'attach'; slug: string; ok: false; reason: string }
  | { action: 'detach'; slug: string; ok: true }
  | { action: 'detach'; slug: string; ok: false; reason: string };

export type ResolveSkillCommandInput = {
  userId: string;
  command: ParsedSkillCommand;
  sessionStore?: SessionStoreLite;
  sessionKey?: SessionRecordKey;
  userSkills: SkillBodyReader;
};

export type ResolveSkillResult = {
  /** Labelled system-preamble block(s) to append AFTER the persona preamble. */
  preamble?: string;
  /** Final attached slug set (de-duplicated, insert order preserved). */
  attachedSlugs: string[];
  /** JSON-array string writer value for sticky persist (undefined = nothing to write). */
  attachedSkills: string | undefined;
  /** Per-command display events (attach/detach outcomes) — sticky re-resolves are silent. */
  events: SkillEvent[];
};

/** Parse a stored `meta.attachedSkills` (JSON array string). Fail-closed → []. */
export function parseAttachedSkills(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const s of parsed) {
    if (typeof s === 'string' && SKILL_SLUG_RE.test(s) && !out.includes(s)) {
      out.push(s);
    }
  }
  return out;
}

/** Serialize a slug set to the sticky JSON-array string writable form. */
export function serializeAttachedSkills(slugs: string[]): string {
  return JSON.stringify(slugs);
}

/** Full-attachment preamble: one labelled `### Skill attached: <slug>` block. */
export function buildSkillBlock(slug: string, body: string): string {
  return `### Skill attached: ${slug}\n${body}`;
}

/**
 * Resolve the skills preamble for an agent turn.
 *
 * Always re-reads `meta.attachedSkills` (sticky) + re-resolves bodies, then
 * applies the current turn's attach/detach command. Returns an events array
 * (for the display-only `skill_attached` rows) plus a `preamble` to append
 * after the persona, plus the final slug set to persist best-effort.
 */
export async function resolveSkillPreamble(
  input: ResolveSkillCommandInput,
): Promise<ResolveSkillResult> {
  const { userId, command, sessionStore, sessionKey, userSkills } = input;

  // 1. Read the sticky set (mirrors personaInject's fail-open/closed store rules).
  let attached = parseAttachedSkills(undefined);
  let storeQueried = false;
  let record: HarnessSessionRecord | null = null;
  if (sessionStore && sessionKey) {
    try {
      record = await sessionStore.get(sessionKey);
      storeQueried = true;
    } catch {
      record = null;
      storeQueried = false;
    }
  }
  if (record) {
    attached = parseAttachedSkills(record.meta?.attachedSkills);
  } else if (storeQueried) {
    // Genuinely absent/foreign scoped session → nothing sticky to re-apply.
    attached = [];
  }

  const events: SkillEvent[] = [];
  const set = new Set(attached);

  // 2. Apply the current command (attach/detach).
  if (command.type === 'attach') {
    if (!SKILL_SLUG_RE.test(command.slug)) {
      events.push({ action: 'attach', slug: command.slug, ok: false, reason: 'invalid slug' });
    } else {
      const res = await readSkillBody(userId, command.slug, userSkills);
      if (res.value) {
        set.add(command.slug);
        events.push({ action: 'attach', slug: command.slug, ok: true });
      } else {
        events.push({
          action: 'attach',
          slug: command.slug,
          ok: false,
          reason: res.unavailable ? 'unavailable' : 'unknown skill',
        });
      }
    }
  } else if (command.type === 'detach') {
    if (set.has(command.slug)) {
      set.delete(command.slug);
      events.push({ action: 'detach', slug: command.slug, ok: true });
    } else {
      events.push({ action: 'detach', slug: command.slug, ok: false, reason: 'not attached' });
    }
  }

  // 3. Re-resolve bodies for ALL attached slugs (staff-of-work: edits re-apply;
  //    deleted skills silently stop attaching — dropped from the sticky set).
  const finalSlugs: string[] = [];
  const blocks: string[] = [];
  for (const slug of set) {
    const res = await readSkillBody(userId, slug, userSkills);
    if (res.value) {
      finalSlugs.push(slug);
      blocks.push(buildSkillBlock(slug, res.value));
    }
  }

  const attachedSkills = serializeAttachedSkills(finalSlugs);

  // 4. Persist best-effort (store down / no session → skip; still inject THIS turn).
  if (record && sessionStore && sessionKey) {
    try {
      const next: HarnessSessionRecord = {
        ...record,
        meta: { ...record.meta, attachedSkills },
        updatedAt: Date.now(),
      };
      await sessionStore.put(sessionKey, next);
    } catch {
      /* fail-open: skip sticky persist */
    }
  }

  return {
    preamble: blocks.length > 0 ? blocks.join('\n\n') : undefined,
    attachedSlugs: finalSlugs,
    attachedSkills,
    events,
  };
}

async function readSkillBody(
  userId: string,
  slug: string,
  userSkills: SkillBodyReader,
): Promise<{ value: string | null; unavailable: boolean }> {
  try {
    const res = await userSkills.getSkillBySlug(userId, slug);
    if (!res.ok) return { value: null, unavailable: true };
    return { value: res.value?.body ?? null, unavailable: false };
  } catch {
    return { value: null, unavailable: true };
  }
}
