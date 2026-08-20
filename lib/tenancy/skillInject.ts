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
 * **Persist seam (adversarial-review H2 fix):** this module writes only through
 * the phase-0 **envelope** seam (`readEnvelope` / `upsertEnvelope`), never the
 * legacy whole-blob `get`/`put`. That keeps the agent-side best-effort mirror on
 * the SAME Redis key the host envelope carrier writes (`harness:envelope:*`),
 * and never rewrites `messages` (which would bump `updatedAt` and re-open the
 * mid-turn 409-adopt / dropped-message race). The mirror follows the persona
 * **clock rule** the other way on purpose: it writes only when `readEnvelope`
 * succeeded, keeps `updatedAt` UNCHANGED, and skips on conflict — the host PUT
 * (which now folds `attachedSlugs`) is the source of truth, so the agent mirror
 * must never fight it.
 *
 * **Inject byte budget (adversarial-review L5 fix):** the count cap
 * (`HARNESS_SESSION_MAX_ATTACHED_SKILLS`, 32) is NOT a size cap. Bodies are
 * resolved + folded into `skillsPreamble` greedily up to
 * `HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES` (256 KiB) so 32 × a 4 MiB stored
 * body can never concatenate 128 MiB into the model system prompt every turn.
 * A new **attach** whose body would exceed that budget is rejected
 * (`too_large` / `budget`) and is never added to the sticky set — so a too-big
 * skill can never sit "attached" while silently never being injected (the
 * review's "silent lie" amendment).
 *
 * The session-store seam is injected so this module never constructs I/O
 * (di-gate).
 */
import type {
  EnvelopeUpsertResult,
  SessionEnvelope,
  SessionEnvelopeInput,
  SessionRecordKey,
} from '../sessions/sessionStore';
import {
  HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES,
  SKILL_SLUG_RE,
  parseAttachedSkills,
  serializeAttachedSkills,
} from '../sessionCloudCaps';

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

/**
 * Minimal scoped session-store seam (phase-0 ENVELOPE only — adversarial-review
 * H2 fix). The agent-side best-effort mirror reads + writes the small envelope
 * (never the whole-blob record / never `messages`), so it stays on the same
 * `harness:envelope:*` Redis surface the host envelope carrier writes and never
 * bumps `updatedAt`.
 */
export type SessionStoreEnvelope = {
  readEnvelope(key: SessionRecordKey): Promise<SessionEnvelope | null>;
  upsertEnvelope(
    key: SessionRecordKey,
    input: SessionEnvelopeInput,
  ): Promise<EnvelopeUpsertResult>;
};

export type SkillEvent =
  | { action: 'attach'; slug: string; ok: true }
  | { action: 'attach'; slug: string; ok: false; reason: string }
  | { action: 'detach'; slug: string; ok: true }
  | { action: 'detach'; slug: string; ok: false; reason: string };

export type ResolveSkillCommandInput = {
  userId: string;
  command: ParsedSkillCommand;
  /**
   * Slugs of skills with `is_always_on = true` (plan #720 phase 2).
   * Prepend to the candidate set before sticky re-resolution and command
   * processing; de-duplicated so a sticky slug that's also always-on is not
   * injected twice. Resolved by the caller once per turn from the DB.
   */
  alwaysOnSlugs?: string[];
  sessionStore?: SessionStoreEnvelope;
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

/** Full-attachment preamble: one labelled `### Skill attached: <slug>` block. */
export function buildSkillBlock(slug: string, body: string): string {
  return `### Skill attached: ${slug}\n${body}`;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Resolve the skills preamble for an agent turn.
 *
 * Always re-reads `meta.attachedSkills` (sticky) + re-resolves bodies, then
 * applies the current turn's attach/detach command. Returns an events array
 * (for the display-only `skill_attached` rows) plus a `preamble` to append
 * after the persona, plus the final slug set to persist best-effort.
 *
 * Sticky re-resolves are SILENT (no event). An **attach** emits exactly one
 * event: `ok:true` when the skill is injectable, or `ok:false` with a reason
 * (`unknown skill` / `unavailable` / `too_large` / `budget`). An attach that
 * fails the inject byte budget (`too_large` > 256 KiB, or `budget` when the
 * already-attached set leaves no room) is NEVER added to the sticky set, so no
 * stored-but-never-injected "silent lie" can form.
 */
export async function resolveSkillPreamble(
  input: ResolveSkillCommandInput,
): Promise<ResolveSkillResult> {
  const { userId, command, sessionStore, sessionKey, userSkills, alwaysOnSlugs } = input;

  // 1. Read the sticky set from the envelope (mirrors personaInject's
  //    fail-open/closed store rules). `readEnvelope` rolls forward from a
  //    legacy whole-blob record when no envelope key exists yet, so this reads
  //    the same sticky value either carrier wrote.
  let attached = parseAttachedSkills(undefined);
  let envelope: SessionEnvelope | null = null;
  let storeQueried = false;
  if (sessionStore && sessionKey) {
    try {
      envelope = await sessionStore.readEnvelope(sessionKey);
      storeQueried = true;
    } catch {
      envelope = null;
      storeQueried = false;
    }
  }
  if (envelope) {
    attached = parseAttachedSkills(envelope.meta?.attachedSkills);
  } else if (storeQueried) {
    // Genuinely absent/foreign scoped session → nothing sticky to re-apply.
    attached = [];
  }

  const events: SkillEvent[] = [];
  // Ordered candidate set (insertion order preserved, de-duplicated).
  // Always-on slugs (plan #720 phase 2) are prepended BEFORE the sticky set
  // so they are resolved first in the greedy budget build — but they are
  // NEVER added to the sticky set or persisted to `meta.attachedSkills`.
  const alwaysOn = alwaysOnSlugs?.filter((s) => SKILL_SLUG_RE.test(s)) ?? [];
  const set: string[] = [];
  // Prepending always-on slugs first (order = auto-attach, then sticky).
  for (const slug of alwaysOn) {
    if (!set.includes(slug)) set.push(slug);
  }
  // Append sticky slugs second, deduped against always-on set.
  for (const slug of attached) {
    if (!set.includes(slug)) set.push(slug);
  }
  // Track always-on slugs so step 5 never persists them.
  const alwaysOnSet = new Set(alwaysOn);
  const hasSlug = (slug: string) => set.includes(slug);
  const removeSlug = (slug: string) => {
    // Always-on slugs cannot be detached by `/unskill` — they are user-global,
    // not session state.
    if (alwaysOnSet.has(slug)) return;
    const i = set.indexOf(slug);
    if (i >= 0) set.splice(i, 1);
  };

  // Pending attach resolved for this turn (slug + body); confirmed against the
  // inject budget in step 3 before being committed to the sticky set.
  let pendingAttach: { slug: string; body: string } | null = null;

  // 2. Apply the current command (attach/detach).
  if (command.type === 'attach') {
    if (!SKILL_SLUG_RE.test(command.slug)) {
      events.push({ action: 'attach', slug: command.slug, ok: false, reason: 'invalid slug' });
    } else if (hasSlug(command.slug)) {
      // Idempotent re-attach of an already-attached slug still confirms; the
      // sticky body re-resolves + budget-check below.
      pendingAttach = {
        slug: command.slug,
        body: (await readSkillBody(userId, command.slug, userSkills)).value ?? '',
      };
    } else {
      const res = await readSkillBody(userId, command.slug, userSkills);
      if (!res.value) {
        events.push({
          action: 'attach',
          slug: command.slug,
          ok: false,
          reason: res.unavailable ? 'unavailable' : 'unknown skill',
        });
      } else {
        pendingAttach = { slug: command.slug, body: res.value };
      }
    }
  } else if (command.type === 'detach') {
    // Always-on slugs cannot be detached: they are user-global, not session
    // state. Report as not_attached even though the slug is in the candidate
    // set (it was prepended from alwaysOnSlugs, not sticky).
    if (alwaysOnSet.has(command.slug)) {
      events.push({ action: 'detach', slug: command.slug, ok: false, reason: 'not attached' });
    } else if (hasSlug(command.slug)) {
      removeSlug(command.slug);
      events.push({ action: 'detach', slug: command.slug, ok: true });
    } else {
      events.push({ action: 'detach', slug: command.slug, ok: false, reason: 'not attached' });
    }
  }

  // 3. Budget-gate the pending attach BEFORE it joins the sticky set. A body
  //    alone > the inject budget → `too_large`; it fits alone but not alongside
  //    the already-attached injectable set → `budget`. Either way it is NOT
  //    added to `set` (never a silent never-injected attach).
  if (pendingAttach) {
    const bodyBytes = byteLength(pendingAttach.body);
    const slug = pendingAttach.slug;
    if (bodyBytes > HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES) {
      events.push({ action: 'attach', slug, ok: false, reason: 'too_large' });
      pendingAttach = null;
    } else {
      // The already-attached set's current bodies measure the real budget
      // already in use. When a sticky body fails to resolve, the budget is
      // unknown → commit optimistically (the greedy build below is the final
      // word on injection).
      let used = 0;
      let allResolve = true;
      for (const attachedSlug of set) {
        const res = await readSkillBody(userId, attachedSlug, userSkills);
        if (!res.value) {
          allResolve = false;
          break;
        }
        used += byteLength(res.value);
      }
      if (allResolve && used + bodyBytes > HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES) {
        events.push({ action: 'attach', slug, ok: false, reason: 'budget' });
        pendingAttach = null;
      } else {
        // Fits (or budget unknown) → commit the attach (deduped: an idempotent
        // re-attach of an already-present slug is not appended again) and
        // confirm with an ok:true event.
        if (!set.includes(slug)) set.push(slug);
        events.push({ action: 'attach', slug, ok: true });
        pendingAttach = null;
      }
    }
  }

  // 4. Re-resolve bodies for ALL candidate slugs (staff-of-work: edits
  //    re-apply; deleted skills silently stop attaching — dropped from the
  //    sticky set). The STICKY set (`finalSlugs`) is what stays attached and is
  //    persisted; the PREAMBLE (`blocks`) is the greedy-injectable subset under
  //    the byte budget. A sticky slug whose body outgrew the budget drops from
  //    THIS turn's preamble but stays attached (never a silent dis-attach); a
  //    NEW accepted attach was pre-validated to fit (step 3), so it is always
  //    in both.
  const finalSlugs: string[] = [];
  const blocks: string[] = [];
  let used = 0;
  for (const slug of set) {
    const res = await readSkillBody(userId, slug, userSkills);
    if (!res.value) continue; // deleted/stale slug silently drops from sticky
    const body = res.value;
    finalSlugs.push(slug); // resolve-able sticky slug stays attached
    const bytes = byteLength(body);
    if (used + bytes > HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES) {
      continue; // exceeds remaining inject budget → not in this turn's preamble
    }
    blocks.push(buildSkillBlock(slug, body));
    used += bytes;
  }

  // 5. Persist best-effort via the ENVELOPE seam (never legacy get/put), only
  //    when `readEnvelope` succeeded (a real envelope/record exists), with
  //    `updatedAt` left UNCHANGED, skipping on conflict. The host PUT is the
  //    source of truth; this mirror must never bump the clock or fight a newer
  //    write (adversarial-review Minor — do not copy the persona's bump).
  //    Always-on slugs (plan #720 phase 2) are NOT persisted into
  //    `meta.attachedSkills` — they are re-resolved from the DB every turn.
  const stickySlugs = finalSlugs.filter((s) => !alwaysOnSet.has(s));
  const attachedSkills = serializeAttachedSkills(stickySlugs);
  if (envelope && sessionStore && sessionKey) {
    try {
      const input: SessionEnvelopeInput = {
        id: envelope.id,
        userId: envelope.userId,
        tenantId: envelope.tenantId,
        updatedAt: envelope.updatedAt,
        // Copy-forward then override: store replaces whole meta (omit = clear).
        meta: { ...envelope.meta, attachedSkills },
      };
      const result = await sessionStore.upsertEnvelope(sessionKey, input);
      // `result.status === 'conflict'` → a newer write won; skip (host source of truth).
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
