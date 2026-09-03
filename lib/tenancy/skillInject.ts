/**
 * Skill attachment resolver (phase 2, #517).
 *
 * Server-side only. Turns `meta.attachedSkills` (a JSON array string of slugs)
 * into the agent-system preamble on every `/api/agent` turn, PLUS handles the
 * per-turn slash commands:
 *
 *   - `/skill-name`  → attach: resolve the skill via `userSkills.getSkillBySlug`,
 *                      add the slug to the sticky set. The body is NOT
 *                      auto-injected — the slug joins the catalog and the model
 *                      reads the body on demand via `fetch_skill`.
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
 * **Catalog inject (plan #557 / #931):** the default inject is a bounded
 * **catalog** (one line per candidate skill — slug + name + one-line
 * description), NOT the bodies. Bodies ride the on-demand `fetch_skill` tool
 * (plan #527) instead of being double-paid inside the stable system-prefix
 * block every turn. `HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES` (256 KiB) stays
 * as the inject **ceiling** (a safety rail over the catalog, never the default
 * inject); the catalog for ≤ 32 sticky + ≤ 8 always-on slugs is a few KiB.
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

/**
 * Skill-body read seam (owned rows only; null = no-row / other-user).
 * Used for attach existence checks only — bodies are never injected by the
 * catalog path (the model pulls them via `fetch_skill`).
 */
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
 * Skill-summary list seam for the catalog. Mirrors the read-only discovery
 * surface (`listUserSkills` → summaries only, no body). Fail-open on error.
 */
export type SkillSummaryLister = {
  listUserSkills(
    userId: string,
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
  userSkills: SkillBodyReader;
  /**
   * Skill-summary lister (plan #557 / #931). When set, the inject is a bounded
   * CATALOG built from `listUserSkills` summaries (no bodies). When omitted,
   * the resolver falls back to the legacy body-block build (callers without a
   * lister — kept so the seam stays optional and tests can exercise both).
   */
  listUserSkills?: SkillSummaryLister;
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

/**
 * One catalog line: `` `<slug>` — <name>: <description> `` — the same shape as
 * `find_skill`'s summary line in `lib/agent/skillTools.ts` (slug first so the
 * model can follow up with `fetch_skill`). Summaries only — never a body.
 */
export function buildCatalogLine(entry: {
  slug: string;
  name: string;
  description: string;
}): string {
  return `\`${entry.slug}\` — ${entry.name}${entry.description ? `: ${entry.description}` : ''}`;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Resolve the skills preamble for an agent turn.
 *
 * Always re-reads `meta.attachedSkills` (sticky), then applies the current
 * turn's attach/detach command. Returns an events array (for the display-only
 * `skill_attached` rows) plus a `preamble` to append after the persona, plus
 * the final slug set to persist best-effort.
 *
 * **Catalog inject (plan #557 / #931):** when `listUserSkills` is provided the
 * preamble is a bounded CATALOG of the candidate set (sticky ∪ always-on,
 * exactly the slugs that used to be body-injected): one line per skill
 * (slug + name + one-line description), built from summaries only — bodies are
 * pulled on demand via `fetch_skill`. A sticky/always-on slug whose skill was
 * deleted has no summary and silently drops from the catalog (same as it
 * silently stopped body-injecting). A store error → fail-open: no catalog
 * block, the round still runs with the base system. The catalog is bounded by
 * the `HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES` ceiling as a safety rail (a
 * catalog of ≤ 32 + 8 entries is a few KiB — far under 256 KiB).
 *
 * When `listUserSkills` is NOT provided the legacy greedy body-block build is
 * kept (256 KiB inject budget) so callers without a lister still work.
 *
 * Sticky re-resolves are SILENT (no event). An **attach** emits exactly one
 * event: `ok:true` when the skill is catalog-listable, or `ok:false` with a
 * reason (`unknown skill` / `unavailable` / `invalid slug`). No body is
 * injected at attach time, so the former `too_large` / `budget` body-budget
 * rejections no longer fire: an over-256 KiB skill can attach and be
 * catalog-listed (its body is reachable via `fetch_skill`, truncated to the
 * 256 KiB return cap).
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

  // Pending attach resolved for this turn (slug); confirmed against the store
  // (existence only) before being committed to the sticky set. No body is read
  // for injection — the catalog path never injects bodies.
  let pendingAttach: { slug: string } | null = null;
  // Set when a catalog store error must skip the sticky rewrite (fail-open).
  let skipStickyPersist = false;

  // 2. Apply the current command (attach/detach).
  if (command.type === 'attach') {
    if (!SKILL_SLUG_RE.test(command.slug)) {
      events.push({ action: 'attach', slug: command.slug, ok: false, reason: 'invalid slug' });
    } else if (hasSlug(command.slug)) {
      // Idempotent re-attach of an already-attached slug still confirms.
      pendingAttach = { slug: command.slug };
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

  // 3. Commit the pending attach. The former `too_large` / `budget` attach-time
  //    body-budget rejection is RETIRED (plan #557 / #931): no body is injected
  //    any more, so a 4 MiB stored body is no longer a prompt-size hazard at
  //    attach time — the slug joins the catalog and the body is only ever
  //    fetched on demand (truncated to the 256 KiB `fetch_skill` return cap).
  //    The store cap (`SKILL_BODY_MAX_BYTES`, 4 MiB) still bounds storage.
  if (pendingAttach) {
    if (!set.includes(pendingAttach.slug)) set.push(pendingAttach.slug);
    events.push({ action: 'attach', slug: pendingAttach.slug, ok: true });
    pendingAttach = null;
  }

  // 4. Build the inject.
  //    - Catalog path (default, plan #557 / #931): with a `listUserSkills`
  //      seam the inject is the bounded CATALOG of the candidate set
  //      (sticky ∪ always-on) — one line per skill (slug + name + one-line
  //      description), NO bodies (the model pulls bodies on demand via
  //      `fetch_skill`). A slug whose skill was deleted has no summary →
  //      silently drops from the catalog AND from the sticky set
  //      (staff-of-work semantics: the sticky set stays resolvable-only). The
  //      catalog is bounded by the `HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES`
  //      inject ceiling as a safety rail — unreachable in practice at ≤ 32
  //      sticky + 8 always-on entries (a few KiB), never unbounded.
  //    - Legacy fallback (no lister seam): greedy body blocks under the same
  //      inject budget — the pre-catalog behavior, kept for callers without
  //      the seam (the attach-time `too_large` / `budget` rejections live on
  //      this path only).
  const finalSlugs: string[] = [];
  const blocks: string[] = [];
  let used = 0;
  if (listUserSkills) {
    let summaries: { slug: string; name: string; description: string }[] = [];
    let storeError = false;
    try {
      const listed = await listUserSkills.listUserSkills(userId);
      if (listed.ok) {
        summaries = listed.value;
      } else {
        storeError = true;
      }
    } catch {
      storeError = true;
    }
    const bySlug = new Map(summaries.map((s) => [s.slug, s]));
    for (const slug of set) {
      const summary = bySlug.get(slug);
      if (!summary) continue; // deleted/stale slug silently drops from sticky
      finalSlugs.push(slug); // resolvable candidate slug stays attached
      const line = buildCatalogLine(summary);
      const bytes = byteLength(line);
      if (used + bytes > HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES) {
        continue; // inject-ceiling safety rail — unreachable at ≤ 32 + 8 entries
      }
      blocks.push(line);
      used += bytes;
    }
    if (storeError && set.length > 0) {
      // Fail-open on a catalog store error: no inject this turn (the round
      // still runs with the base system); also skip the sticky rewrite below
      // so a store outage can never rewrite `meta.attachedSkills` from a
      // half-resolved candidate set.
      finalSlugs.length = 0;
      blocks.length = 0;
      skipStickyPersist = true;
    }
  } else {
    // Legacy fallback (no lister seam): greedy body blocks under the inject
    // budget — the pre-catalog behavior, kept for callers without the seam.
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
  if (envelope && sessionStore && sessionKey && !skipStickyPersist) {
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
