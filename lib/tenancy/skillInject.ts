/**
 * Skill attachment resolver (phase 2, #517).
 *
 * Server-side only. Turns `meta.attachedSkills` (a JSON array string of slugs)
 * into the agent-system preamble on every `/api/agent` turn, PLUS handles the
 * per-turn slash commands:
 *
 *   - `/skill-name`  → attach: existence via catalog summary (happy path) or
 *                      `skillExistsBySlug` (list fail-open). The body is NOT
 *                      auto-injected — the slug joins the catalog and the model
 *                      reads the body on demand via `fetch_skill`.
 *   - `/unskill slug` → detach: remove the slug from the sticky set (no-op when
 *                      not-attached); the whole line is consumed (a pure
 *                      `/unskill` is a NO-MODEL turn — never forwarded empty to
 *                      the model).
 *
 * Unlike the locked persona (`meta.personaSnapshot`), skills are **staff of
 * work**, not identity: we store **slugs only** in `meta.attachedSkills` and
 * re-resolve their **summaries** from the store every turn into a catalog
 * (bodies ride on-demand `fetch_skill`). So a mid-session description edit
 * applies next turn, a body edit applies on the next fetch, and a deleted
 * skill silently drops from the catalog. `meta` stays small (slugs ≪ the
 * meta cap).
 *
 * Fail-closed / offline-safe semantics mirror `personaInject`:
 *   - unknown / foreign / malformed slug → NO inject + a `{ ok:false }` event
 *     (never a leak): `skillExistsBySlug` is tenant+user scoped and returns
 *     false for other-user rows.
 *   - store down OR no session key available → fail-open: the attach still
 *     resolves THIS turn, only the sticky `meta.attachedSkills` persist is
 *     skipped when the *envelope* is unavailable (same as persona). A catalog
 *     `listUserSkillsBySlugs` failure is also fail-open for the **full** catalog
 *     (no name/description lines) but MUST still emit a **slug-only**
 *     catalog from the in-memory set so strip-`/slug` is safe, plus persist
 *     and return the **command-applied** sticky set: omit/`[]` would either
 *     drop an in-turn `/skill-name` / `/unskill` (omit = host leave-untouched
 *     restores the pre-command set while events already said `ok: true`) or
 *     wipe the session (`[]` = host detach-all). Sticky/always-on slugs are
 *     existence-checked via `skillExistsBySlug` when exists still answers: a
 *     missing row is dropped from catalog + sticky (ghost GC); an unavailable
 *     exists keeps the slug (cannot tell missing from store-down). Returning the
 *     in-memory `set` cannot be detach-all unless that set is actually empty.
 *     Never paint attach `ok:true` with an empty catalog this turn.
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
 * **Catalog inject (plan #557 / #931):** the default inject is a bounded
 * **catalog** (one line per candidate skill — slug + name + one-line
 * description), NOT the bodies. Bodies ride the on-demand `fetch_skill` tool
 * (plan #527) instead of being double-paid inside the stable system-prefix
 * block every turn. `HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES` (256 KiB) stays
 * as the inject **ceiling** (a safety rail over the catalog, never the default
 * inject). A maxed 32 sticky + 8 always-on catalog of CJK name+description
 * lines can exceed 256 KiB, so each line is flattened (one line per skill)
 * and packed by remaining budget (occupancy 1 may use the full ceiling; the
 * 40-row count cap is the row ceiling, not a per-line tax) — every resolvable
 * slug still appears; the skip-from-preamble path is gone.
 * Because no body is injected at attach time any more, the former attach-time
 * `too_large` / `budget` body-budget rejection is **retired** for the catalog
 * path: an over-256 KiB skill can now attach and be catalog-listed; its body
 * is only ever fetched (truncated to the 256 KiB `SKILL_FETCH_MAX_RETURN_BYTES`
 * return cap). The store cap (`SKILL_BODY_MAX_BYTES`, 4 MiB) still bounds
 * storage.
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
  HARNESS_SESSION_MAX_ATTACHED_SKILLS,
  SKILL_SLUG_RE,
  USER_ALWAYS_ON_SKILLS_MAX,
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

/**
 * Lightweight existence seam (owned rows only; false = no-row / other-user).
 * Used for attach / sticky GC on catalog-list fail-open only — never hydrates
 * a body. Happy-path attach existence is a summary lookup. The store
 * implementation (`skillExistsBySlug`) SELECTs `slug` only.
 */
export type SkillExistsReader = {
  skillExistsBySlug(
    userId: string,
    slug: string,
  ): Promise<
    | { ok: true; value: boolean }
    | { ok: false; error: string }
  >;
};

/**
 * Skill-summary list seam for the catalog. Candidate-scoped (`slug IN`) so a
 * turn does not full-scan an unbounded Settings library. Same summary
 * projection as `listUserSkills` (no body). Fail-open on error for the
 * preamble; the command-applied sticky set is still returned.
 */
export type SkillSummaryLister = {
  listUserSkillsBySlugs(
    userId: string,
    slugs: readonly string[],
  ): Promise<
    | { ok: true; value: { slug: string; name: string; description: string }[] }
    | { ok: false; code: string; error: string }
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
  userSkills: SkillExistsReader;
  /**
   * Skill-summary lister (plan #557 / #931). REQUIRED — the inject is a bounded
   * CATALOG built from candidate-scoped summaries (no bodies). Omitting this
   * used to silently select the legacy greedy body-block inject (up to 256 KiB
   * of playbooks back in the stable prefix); that fallback is gone.
   */
  listUserSkills: SkillSummaryLister;
};

export type ResolveSkillResult = {
  /** Labelled system-preamble block(s) to append AFTER the persona preamble. */
  preamble?: string;
  /**
   * Final attached slug set (de-duplicated, insert order preserved), including
   * always-on. Always set after a successful resolve — including catalog
   * `listUserSkills` fail-open, where it is the **command-applied** candidate
   * set after skillExistsBySlug GC (missing sticky drops when exists still
   * answers; unavailable exists keeps the slug). `[]` is a
   * real empty set (host detach-all), never a "we don't know" signal.
   */
  attachedSlugs: string[];
  /**
   * JSON-array string writer value for sticky persist / host fold.
   * Always the command-applied sticky set (always-on stripped). `"[]"` is
   * explicit detach-all (the set is actually empty), never a store-error signal.
   */
  attachedSkills: string;
  /** Per-command display events (attach/detach outcomes) — sticky re-resolves are silent. */
  events: SkillEvent[];
};

/** Full-attachment preamble: one labelled `### Skill attached: <slug>` block. */
export function buildSkillBlock(slug: string, body: string): string {
  return `### Skill attached: ${slug}\n${body}`;
}

/**
 * One catalog line: `<slug> — <name>: <description>` — the same unquoted
 * shape as `find_skill`'s summary line in `lib/agent/skillTools.ts` (slug
 * first so the model can pass it to `fetch_skill` verbatim). Wrapping the
 * slug in backticks would fail `SKILL_SLUG_RE` / `getSkillBySlug`. Summaries
 * only — never a body.
 *
 * Name and description are flattened to a single line (JS `\s` plus U+0085
 * NEXT LINE, which `\s` misses) so a legal stored description cannot split
 * the catalog into extra fake entries.
 */
export function buildCatalogLine(entry: {
  slug: string;
  name: string;
  description: string;
}): string {
  const name = flattenCatalogText(entry.name);
  const description = flattenCatalogText(entry.description);
  return `${entry.slug} — ${name}${description ? `: ${description}` : ''}`;
}

/**
 * Collapse whitespace so each catalog entry is exactly one line.
 * JS `\s` is ECMA-262 WhiteSpace + LineTerminator and does not match U+0085
 * NEXT LINE (NEL). Unicode TR#14 treats NEL as a line break, so flatten it
 * too — otherwise `meta_skill_update_summary` can inject a fake second row.
 */
export function flattenCatalogText(s: string): string {
  return s.replace(/[\u0085\s]+/g, ' ').trim();
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Catalog row ceiling: sticky + always-on. Existing count caps, not a new cap. */
const CATALOG_ROW_MAX =
  HARNESS_SESSION_MAX_ATTACHED_SKILLS + USER_ALWAYS_ON_SKILLS_MAX;

/** Candidate IN list: catalog rows + one pending attach. Existing count caps. */
const CATALOG_IN_MAX = CATALOG_ROW_MAX + 1;

/**
 * Worst-case per-line UTF-8 share at full occupancy (40 slots). Used as a
 * ceiling invariant, not as the occupancy-1 truncate. Packing uses
 * `packCatalogLines` (remaining budget / remaining slots).
 */
export function catalogLineMaxBytes(): number {
  return catalogLineBudget(HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES, CATALOG_ROW_MAX);
}

/** Fair-share UTF-8 budget for `slotsLeft` lines inside `remainingBytes` (`\n\n` reserved). */
function catalogLineBudget(remainingBytes: number, slotsLeft: number): number {
  if (slotsLeft <= 0) return 0;
  const joinOverhead = 2 * Math.max(0, slotsLeft - 1);
  return Math.max(0, Math.floor((remainingBytes - joinOverhead) / slotsLeft));
}

/**
 * Pack catalog lines by remaining budget so occupancy 1 is not truncated to
 * the 40-slot worst-case share. Each line's UTF-8 budget is remaining / slots
 * left (join `\n\n` reserved). Truncate only when a line exceeds that share.
 * At most `CATALOG_ROW_MAX` rows.
 */
export function packCatalogLines(
  lines: readonly string[],
  ceilingBytes: number = HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES,
): string[] {
  const packed = lines.slice(0, CATALOG_ROW_MAX);
  if (packed.length === 0) return [];
  const out: string[] = [];
  let remaining = ceilingBytes;
  for (let i = 0; i < packed.length; i++) {
    const slotsLeft = packed.length - i;
    const joinThis = out.length > 0 ? 2 : 0;
    const remainingAfterJoin = remaining - joinThis;
    const lineBudget = catalogLineBudget(remainingAfterJoin, slotsLeft);
    let line = packed[i]!;
    if (byteLength(line) > lineBudget) {
      line = truncateUtf8(line, lineBudget);
    }
    out.push(line);
    remaining -= joinThis + byteLength(line);
  }
  return out;
}

/**
 * Candidate IN order: pending attach first, then the in-memory set (always-on
 * already capped + prepended, then sticky). First-N slice in the store cannot
 * drop the pending slug ahead of sticky/always-on.
 */
function wantedCatalogSlugs(
  set: readonly string[],
  pendingSlug: string | null,
): string[] {
  const wanted: string[] = [];
  if (pendingSlug) wanted.push(pendingSlug);
  for (const slug of set) {
    if (wanted.length >= CATALOG_IN_MAX) break;
    if (!wanted.includes(slug)) wanted.push(slug);
  }
  return wanted;
}

/** Prefix-preserving UTF-8 truncate (never splits a code point). */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = new TextEncoder().encode(s);
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(buf.subarray(0, end));
}

/**
 * Resolve the skills preamble for an agent turn.
 *
 * Always re-reads `meta.attachedSkills` (sticky), then applies the current
 * turn's attach/detach command. Returns an events array (for the display-only
 * `skill_attached` rows) plus a `preamble` to append after the persona, plus
 * the final slug set to persist best-effort.
 *
 * **Catalog inject (plan #557 / #931):** the preamble is a bounded CATALOG of
 * the candidate set (sticky ∪ always-on, exactly the slugs that used to be
 * body-injected): one line per skill (slug + name + one-line description),
 * built from `listUserSkillsBySlugs` summaries only — bodies are pulled on demand
 * via `fetch_skill`. A sticky/always-on slug whose skill was deleted has no
 * summary and silently drops from the catalog (same as it silently stopped
 * body-injecting). A store error → fail-open for the **full** catalog (no
 * name/description) but still emit a **slug-only** catalog from the
 * in-memory set so the model keeps identity this turn after strip-`/slug`.
 * The **command-applied candidate set is persisted and returned** so an
 * in-turn `/skill-name` / `/unskill` is not undone by host leave-untouched,
 * and so `[]` is only ever a real empty set (host detach-all). On that path,
 * missing sticky/always-on slugs are dropped when `skillExistsBySlug` still
 * answers (ghost GC); an unavailable exists keeps the slug. Each catalog line
 * is flattened to one line and packed by remaining budget (not the worst-case
 * 40-slot share) so occupancy 1 is not chopped while bytes remain; the 32+8
 * count caps are the row ceiling. A maxed CJK library cannot skip a
 * resolvable slug off the preamble while keeping it sticky (the retired
 * silent-lie class). The joined catalog stays under
 * `HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES`.
 *
 * Sticky re-resolves are SILENT (no event). An **attach** emits exactly one
 * event: `ok:true` when the skill is catalog-listable (or existence-confirmed
 * via `skillExistsBySlug` on list fail-open), or `ok:false` with a reason
 * (`unknown skill` / `unavailable` / `invalid slug` / `sticky limit reached
 * (N)`). A new slug is refused when sticky is already at
 * `HARNESS_SESSION_MAX_ATTACHED_SKILLS` (the envelope write cap): otherwise
 * `ok:true` plus a 41st catalog line (32 sticky + 8 always-on + pending) is
 * dropped by `CATALOG_ROW_MAX`, and persist of 33 sticky slugs fails
 * `validateMetaFields` (catch fail-opens; next turn the attach is gone).
 * Re-attach of an already-sticky or always-on slug at the cap stays `ok:true`
 * (the set does not grow). No body is injected at attach time, so the former
 * `too_large` / `budget` body-budget rejections no longer fire: an over-256 KiB
 * skill can attach and be catalog-listed (its body is reachable via
 * `fetch_skill`, truncated to the 256 KiB return cap).
 */
export async function resolveSkillPreamble(
  input: ResolveSkillCommandInput,
): Promise<ResolveSkillResult> {
  const { userId, command, sessionStore, sessionKey, userSkills, alwaysOnSlugs, listUserSkills } = input;

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
  // so they are listed first — but they are NEVER added to the sticky set or
  // persisted to `meta.attachedSkills`. Cap on read so a concurrent
  // setAlwaysOn race cannot overflow the IN slice and GC sticky.
  const alwaysOnRaw =
    alwaysOnSlugs?.filter((s) => SKILL_SLUG_RE.test(s)) ?? [];
  const alwaysOn = alwaysOnRaw.slice(0, USER_ALWAYS_ON_SKILLS_MAX);
  const set: string[] = [];
  // Prepending always-on slugs first (order = auto-attach, then sticky).
  for (const slug of alwaysOn) {
    if (!set.includes(slug)) set.push(slug);
  }
  // Append sticky slugs second, deduped against always-on set.
  for (const slug of attached) {
    if (!set.includes(slug)) set.push(slug);
  }
  // Track always-on slugs so persist never writes them.
  const alwaysOnSet = new Set(alwaysOn);
  const hasSlug = (slug: string) => set.includes(slug);
  const removeSlug = (slug: string) => {
    // Always-on slugs cannot be detached by `/unskill` — they are user-global,
    // not session state.
    if (alwaysOnSet.has(slug)) return;
    const i = set.indexOf(slug);
    if (i >= 0) set.splice(i, 1);
  };

  // Pending attach: existence is confirmed AFTER the catalog list (summaries
  // already prove the row exists — no body read and no exists lookup on the
  // happy path). On list fail-open we fall back to skillExistsBySlug.
  let pendingAttach: { slug: string } | null = null;

  // 2. Apply the current command (attach/detach). Detach is applied now;
  //    attach waits on the list so existence is a summary lookup.
  if (command.type === 'attach') {
    if (!SKILL_SLUG_RE.test(command.slug)) {
      events.push({ action: 'attach', slug: command.slug, ok: false, reason: 'invalid slug' });
    } else {
      // Envelope `meta.attachedSkills` is capped at 32 sticky slugs. Refuse a
      // 33rd before catalog IN / paint so we never emit ok:true for a line
      // CATALOG_ROW_MAX then drops, and never serialize 33 slugs that
      // `assertValidSessionEnvelope` rejects (catch fail-opens).
      const stickyCount = set.filter((s) => !alwaysOnSet.has(s)).length;
      if (
        !hasSlug(command.slug) &&
        stickyCount >= HARNESS_SESSION_MAX_ATTACHED_SKILLS
      ) {
        events.push({
          action: 'attach',
          slug: command.slug,
          ok: false,
          reason: `sticky limit reached (${HARNESS_SESSION_MAX_ATTACHED_SKILLS})`,
        });
      } else {
        pendingAttach = { slug: command.slug };
      }
    }
  } else if (command.type === 'detach') {
    // Always-on slugs cannot be detached: they are user-global, not session
    // state. Report as always-on so the operator sees WHY detach was refused
    // (the slug IS in this turn's catalog, just from alwaysOnSlugs, not sticky).
    if (alwaysOnSet.has(command.slug)) {
      events.push({ action: 'detach', slug: command.slug, ok: false, reason: 'always-on' });
    } else if (hasSlug(command.slug)) {
      removeSlug(command.slug);
      events.push({ action: 'detach', slug: command.slug, ok: true });
    } else {
      events.push({ action: 'detach', slug: command.slug, ok: false, reason: 'not attached' });
    }
  }

  // 3. List candidate summaries, then commit a pending attach + build the
  //    catalog. Candidate-scoped (`slug IN`) so this turn does not full-scan
  //    an unbounded Settings library. The former `too_large` / `budget`
  //    attach-time body-budget rejection is RETIRED (plan #557 / #931): no
  //    body is injected any more, so a 4 MiB stored body is no longer a
  //    prompt-size hazard at attach time — the slug joins the catalog and the
  //    body is only ever fetched on demand (truncated to the 256 KiB
  //    `fetch_skill` return cap). The store cap (`SKILL_BODY_MAX_BYTES`, 4 MiB)
  //    still bounds storage.
  const finalSlugs: string[] = [];
  const blocks: string[] = [];
  let summaries: { slug: string; name: string; description: string }[] = [];
  let storeError = false;
  const candidateSlugs = wantedCatalogSlugs(
    set,
    pendingAttach ? pendingAttach.slug : null,
  );
  const queried = new Set(candidateSlugs);
  try {
    const listed = await listUserSkills.listUserSkillsBySlugs(
      userId,
      candidateSlugs,
    );
    if (listed.ok) {
      summaries = listed.value;
    } else {
      storeError = true;
    }
  } catch {
    storeError = true;
  }

  if (storeError) {
    // Fail-open for the full catalog (no name/description this turn). Honor
    // the command-applied set: confirm a pending attach via skillExistsBySlug
    // (slug-only SELECT, never the body), then existence-check remaining
    // sticky/always-on slugs the same way when exists still answers. A missing
    // row is dropped from catalog + sticky (ghost GC); an unavailable exists
    // keeps the slug. Persist and return that set. Still emit a slug-only
    // catalog so strip-/slug is safe — attach ok:true never pairs with an
    // empty preamble while the set is non-empty. `[]` here is a real empty
    // set. Existence results are cached per slug so a pending attach is not
    // fetched twice in the GC loop.
    const existenceCache = new Map<string, { present: boolean; unavailable: boolean }>();
    const checkExists = async (slug: string) => {
      const cached = existenceCache.get(slug);
      if (cached) return cached;
      const result = await skillExists(userId, slug, userSkills);
      existenceCache.set(slug, result);
      return result;
    };
    if (pendingAttach) {
      const res = await checkExists(pendingAttach.slug);
      if (!res.present) {
        events.push({
          action: 'attach',
          slug: pendingAttach.slug,
          ok: false,
          reason: res.unavailable ? 'unavailable' : 'unknown skill',
        });
      } else {
        if (!set.includes(pendingAttach.slug)) set.push(pendingAttach.slug);
        events.push({ action: 'attach', slug: pendingAttach.slug, ok: true });
      }
      pendingAttach = null;
    }
    for (const slug of set) {
      const exists = await checkExists(slug);
      // exists answered missing → drop. Present or exists-unavailable → keep.
      if (!exists.unavailable && !exists.present) continue;
      finalSlugs.push(slug);
      // Unquoted slug token — same fetch_skill-safe shape as catalog lines.
      blocks.push(slug);
    }
  } else {
    const bySlug = new Map(summaries.map((s) => [s.slug, s]));
    if (pendingAttach) {
      const summary = bySlug.get(pendingAttach.slug);
      if (!summary) {
        // Missing only counts as unknown when the IN actually queried it.
        // A slice miss must not look like a deleted skill.
        if (queried.has(pendingAttach.slug)) {
          events.push({
            action: 'attach',
            slug: pendingAttach.slug,
            ok: false,
            reason: 'unknown skill',
          });
        }
      } else {
        if (!set.includes(pendingAttach.slug)) set.push(pendingAttach.slug);
        events.push({ action: 'attach', slug: pendingAttach.slug, ok: true });
      }
      pendingAttach = null;
    }
    const rawLines: string[] = [];
    const rawSlugs: string[] = [];
    for (const slug of set) {
      const summary = bySlug.get(slug);
      if (!summary) {
        if (!queried.has(slug)) {
          // Slice miss: keep sticky/always-on; do not GC as deleted.
          finalSlugs.push(slug);
        }
        continue;
      }
      finalSlugs.push(slug);
      if (rawLines.length < CATALOG_ROW_MAX) {
        rawLines.push(buildCatalogLine(summary));
        rawSlugs.push(slug);
      }
    }
    const packed = packCatalogLines(rawLines);
    for (let i = 0; i < packed.length; i++) {
      let line = packed[i]!;
      if (!line) line = rawSlugs[i]!;
      blocks.push(line);
    }
  }

  // 4. Persist best-effort via the ENVELOPE seam (never legacy get/put), only
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
      const persistInput: SessionEnvelopeInput = {
        id: envelope.id,
        userId: envelope.userId,
        tenantId: envelope.tenantId,
        updatedAt: envelope.updatedAt,
        // Copy-forward then override: store replaces whole meta (omit = clear).
        meta: { ...envelope.meta, attachedSkills },
      };
      const result = await sessionStore.upsertEnvelope(sessionKey, persistInput);
      // `result.status === 'conflict'` → a newer write won; skip (host source of truth).
      void result;
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

async function skillExists(
  userId: string,
  slug: string,
  userSkills: SkillExistsReader,
): Promise<{ present: boolean; unavailable: boolean }> {
  try {
    const res = await userSkills.skillExistsBySlug(userId, slug);
    if (!res.ok) return { present: false, unavailable: true };
    return { present: res.value === true, unavailable: false };
  } catch {
    return { present: false, unavailable: true };
  }
}
