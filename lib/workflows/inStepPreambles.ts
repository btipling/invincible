/**
 * In-step system-preamble resolution (persona + skills + working-notes).
 *
 * Lives in its OWN module — not `modelGenerateStep.ts` — because that file is a
 * `'use step'` file the `'use workflow'` entry (`turnWorkflow.ts`) statically
 * imports. Workflow-mode SWC DCE **keeps exported non-step functions** in the
 * canvas bundle: exporting `resolveInStepPreambles` from the step file pulled
 * `harnessSessionsRedis` → Blob `node:crypto` and `sessionStore` → `postgres`
 * into the workflow VM (Vercel `workflow-node-module-error`, prod deploy of
 * #940). The step file must dynamically import THIS module from inside the
 * `'use step'` function so the workflow transform stubs the import away.
 *
 * Tests import this file directly (no `'use step'` wrapper).
 */
import type {
  SessionEnvelopeStore,
  SessionRecordKey,
} from '../sessions/sessionStore';
import type { SessionStoreLite } from '../tenancy/personaInject';

/**
 * Envelope-backed `SessionStoreLite` for `resolvePersonaPreamble`.
 *
 * Production sessions live on `harness:envelope:*` (`readEnvelope` /
 * `upsertEnvelope`). The persona helper still speaks legacy `get`/`put` on
 * `harness:session:*`. Passing the raw store here miss-reads envelope-only
 * sessions (fail-closed → no persona) and `mergePersonaMeta` bumps
 * `updatedAt` on `put` (the 409-adopt race skillInject already forbids).
 *
 * `get` roll-forwards via `readEnvelope` (envelope key, else legacy blob).
 * `put` locks `personaSnapshot` onto the envelope with `updatedAt` unchanged
 * and never touches the whole-blob key.
 */
function envelopePersonaSeam(store: SessionEnvelopeStore): SessionStoreLite {
  return {
    async get(key: SessionRecordKey) {
      const env = await store.readEnvelope(key);
      if (!env) return null;
      return {
        id: env.id,
        userId: env.userId,
        tenantId: env.tenantId,
        createdAt: env.createdAt,
        updatedAt: env.updatedAt,
        messages: [],
        meta: env.meta,
      };
    },
    async put(key: SessionRecordKey, record) {
      const env = await store.readEnvelope(key);
      if (!env) return { status: 'stored' as const };
      const snap = record.meta?.personaSnapshot;
      if (typeof snap !== 'string' || !snap.trim()) {
        return { status: 'stored' as const };
      }
      const pid = record.meta?.personaId;
      try {
        await store.upsertEnvelope(key, {
          id: env.id,
          userId: env.userId,
          tenantId: env.tenantId,
          updatedAt: env.updatedAt,
          meta: {
            ...env.meta,
            ...(typeof pid === 'string' ? { personaId: pid } : {}),
            personaSnapshot: snap,
          },
        });
      } catch {
        /* fail-open: snapshot still injects this turn */
      }
      return { status: 'stored' as const };
    },
  };
}

/**
 * Persona snapshot + sticky/always-on skills + the session working-notes block
 * (plan #938). Fail-open independently: a store/inject error on one preamble
 * does not drop the others; any total failure → no preamble (the round still
 * runs with the base system). Slash commands are `none` — attach/detach is
 * `/api/agent` route work, not a replayable step write.
 *
 * Plan #938: the working-notes fold reads the SAME envelope the
 * persona/skills preambles resolve through and must run even when the
 * persona/skills stores are ABSENT — the early-return guard is widened: the
 * notes fold below only needs the envelope, so the previous
 * "no persona/skills stores → `{}`" early return is retired.
 */
export async function resolveInStepPreambles(args: {
  userId: string;
  sessionId: string;
  tenantId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  services: any;
}): Promise<{
  personaPreamble?: string;
  skillsPreamble?: string;
  notesPreamble?: string;
}> {
  let envelopeStore: SessionEnvelopeStore | undefined;
  let sessionKey: SessionRecordKey | undefined;
  try {
    const { resolveSessionStore, sessionKeyFor } = await import(
      '../tenancy/harnessSessionsRedis'
    );
    const { isEnvelopeStore } = await import('../sessions/sessionStore');
    const storeRes = await resolveSessionStore();
    if (storeRes.ok && isEnvelopeStore(storeRes.value)) {
      envelopeStore = storeRes.value;
      sessionKey = sessionKeyFor(args.tenantId, args.userId, args.sessionId);
    }
  } catch {
    envelopeStore = undefined;
    sessionKey = undefined;
  }

  // Plan #938: the session's working-notes block — read from the envelope
  // `meta.workingNotes` (the SAME envelope read persona/skills already do),
  // sanitized through the shared client-safe predicate (poison → unset, never
  // a failed round). Fail-open: any read problem → no notes block.
  let notesPreamble: string | undefined;
  if (envelopeStore && sessionKey) {
    try {
      const envelope = await envelopeStore.readEnvelope(sessionKey);
      const { sanitizeWorkingNotes } = await import('../sessionCloudCaps');
      notesPreamble = sanitizeWorkingNotes(envelope?.meta?.workingNotes);
    } catch {
      notesPreamble = undefined;
    }
  }

  let personaPreamble: string | undefined;
  if (args.services.userPersonas) {
    try {
      const { resolvePersonaPreamble } = await import(
        '../tenancy/personaInject'
      );
      personaPreamble = await resolvePersonaPreamble({
        userId: args.userId,
        sessionId: args.sessionId,
        userPersonas: args.services.userPersonas,
        ...(envelopeStore && sessionKey
          ? {
              sessionStore: envelopePersonaSeam(envelopeStore),
              sessionKey,
            }
          : {}),
      });
    } catch {
      personaPreamble = undefined;
    }
  }

  let skillsPreamble: string | undefined;
  try {
    let alwaysOnSlugs: string[] | undefined;
    try {
      const listed = await args.services.userSkills?.listAlwaysOnSkills?.(
        args.userId,
      );
      if (listed?.ok && Array.isArray(listed.value) && listed.value.length > 0) {
        alwaysOnSlugs = listed.value;
      }
    } catch {
      alwaysOnSlugs = undefined;
    }

    if (args.services.userSkills && (envelopeStore || alwaysOnSlugs)) {
      const { resolveSkillPreamble } = await import('../tenancy/skillInject');
      const skills = await resolveSkillPreamble({
        userId: args.userId,
        command: { type: 'none' },
        userSkills: args.services.userSkills,
        // Catalog seam REQUIRED (plan #557/#931): the inject is summaries
        // only. listUserSkills (SkillSummaryLister) is required on
        // ResolveSkillCommandInput so dropping it is a type error, not a
        // silent body-block revert. Happy path is listUserSkillsBySlugs.
        listUserSkills: args.services.userSkills,
        alwaysOnSlugs,
        ...(envelopeStore && sessionKey
          ? { sessionStore: envelopeStore, sessionKey }
          : {}),
      });
      const preamble = skills.preamble?.trim();
      if (preamble) skillsPreamble = preamble;
    }
  } catch {
    skillsPreamble = undefined;
  }

  return {
    ...(personaPreamble ? { personaPreamble } : {}),
    ...(skillsPreamble ? { skillsPreamble } : {}),
    ...(notesPreamble ? { notesPreamble } : {}),
  };
}

/**
 * In-step read of the per-turn freshness reminder (plan #941, source #693).
 *
 * Lives here (NOT `modelGenerateStep.ts`) for the same #940 reason as
 * `resolveInStepPreambles`: workflow-mode SWC keeps exported non-step
 * functions in the canvas bundle, and this helper reaches
 * `harnessSessionsRedis` / `blobStore` — a graph illegal in the workflow VM.
 * The step file dynamically imports THIS module from inside the `'use step'`
 * body; tests import it directly.
 *
 * Given the sanitized pointer (the route passed it through `start()` args —
 * never the text, never a Blob read in the route): resolve the session
 * envelope store + key (same seam as the persona/notes preambles), enforce
 * `isObjectIdBoundTo` (confused-deputy, fail-closed), read the bound Blob
 * object, parse the `{paths}` shape, and render the volatile reminder copy.
 * ANY failure at any step → `undefined` (no row; the turn proceeds fail-open
 * — the reminder is advisory memory, never a 5xx). Never throws.
 */
export async function resolveInStepFreshnessReminder(args: {
  pointer: string;
  scope: { tenantId: string; userId: string; sessionId: string };
}): Promise<string | undefined> {
  try {
    const { resolveSessionStore, sessionKeyFor, resolveBlobStore } = await import(
      '../tenancy/harnessSessionsRedis'
    );
    const { isEnvelopeStore } = await import('../sessions/sessionStore');
    const { isObjectIdBoundTo } = await import('../sessions/blobStore');
    const { renderFreshnessReminder } = await import('../agent/freshnessReminder');
    const storeRes = await resolveSessionStore();
    if (!storeRes.ok || !isEnvelopeStore(storeRes.value)) return undefined;
    void sessionKeyFor; // key derivation is scope-equality via isObjectIdBoundTo
    // Confused-deputy guard (fail-closed): the pointer must re-bind to THIS
    // session scope — a planted/foreign id renders nothing, never a 5xx.
    if (!isObjectIdBoundTo(args.pointer, args.scope)) return undefined;
    const blobRes = await resolveBlobStore();
    if (!blobRes.ok) return undefined;
    const raw = await blobRes.value.read(args.pointer);
    if (raw === null) return undefined; // missing object → fail-open
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined; // not the `{paths}` shape → no row
    }
    const rawPaths = (parsed as { paths?: unknown }).paths;
    if (!Array.isArray(rawPaths)) return undefined;
    const paths: string[] = [];
    for (const p of rawPaths) {
      if (typeof p === 'string' && p) paths.push(p);
    }
    const rawOmitted = (parsed as { omitted?: unknown }).omitted;
    const persistedOmitted =
      typeof rawOmitted === 'number' &&
      Number.isFinite(rawOmitted) &&
      rawOmitted > 0
        ? Math.floor(rawOmitted)
        : 0;
    if (paths.length === 0 && persistedOmitted === 0) return undefined; // zero-read prior turn → no fold
    return renderFreshnessReminder(paths, persistedOmitted);
  } catch {
    // Fail-open: any read/parse problem → no reminder row, turn unaffected.
    return undefined;
  }
}
