/**
 * Agent skill tools (phase 3 #516): read-only `find_skill` / `fetch_skill`
 * assembled server-side on `/api/agent`. Both are **user-scoped** — they operate
 * on the CALLER's own skills only (tenant + user filtered by
 * `lib/tenancy/userSkills.ts`); an unknown slug or another user's/tenant's skill
 * never leaks existence (`getSkillBySlug` returns null for foreign rows).
 *
 * Layering: this module is pure server-side tool wiring. It never constructs I/O
 * — it receives the DI-bound `userSkills` object (composition root) and the
 * route-resolved `userId` at assembly time. The body a model requests is treated
 * like other file/tool reads: its `tool_result` preview (bounded, same as
 * `read_file`) is persisted as a `tool_run` and painted by the client — so the
 * playbook can appear in the tool trace, not just the model. Bodies are
 * non-secret plaintext and user-scoped (no IDOR; own content only).
 *
 * Model payload discipline (plan-review #516): `find_skill` caps the number of
 * summaries returned per call; `fetch_skill` caps the per-call model-returned
 * body (a longer one is returned truncated with an explicit marker, never
 * silently dropped). See `SKILL_FIND_RESULT_MAX` / `SKILL_FETCH_MAX_RETURN_BYTES`
 * in `lib/sessionCloudCaps.ts`.
 */
import { jsonSchema, tool } from 'ai';
import { SKILL_FETCH_MAX_RETURN_BYTES, SKILL_FIND_RESULT_MAX } from '../sessionCloudCaps';
import { SKILL_SLUG_RE } from '../sessionCloudCaps';

/** System-prompt addendum shown whenever the skill tools are on the tool surface. */
export const SKILL_TOOLS_SYSTEM_ADDENDUM =
  'You may use find_skill to locate the user\'s skills (search / catch typos) and fetch_skill to read the full body of one of the user\'s skills by slug. Skills are the user\'s own instructions/playbooks; prefer them for reference. Read-only — you cannot create or edit skills.';

/** System prompt when skill tools are the ONLY non-filesystem tools available. */
export { SKILL_TOOLS_ONLY_SYSTEM } from './agentSystem';

export type SkillSummary = {
  slug: string;
  name: string;
  description: string;
};

export type ListSkillsResult =
  | { ok: true; value: SkillSummary[] }
  | { ok: false; code: string; error: string };

export type FetchSkillValue = SkillSummary & { body: string };

export type FetchSkillResult =
  | { ok: true; value: FetchSkillValue | null }
  | { ok: false; code: string; error: string };

export type UserSkillsLike = {
  listUserSkills: (userId: string) => Promise<ListSkillsResult>;
  getSkillBySlug: (userId: string, slug: string) => Promise<FetchSkillResult>;
};

export type PersonasLike = {
  getPersonaById: (
    userId: string,
    id: string,
  ) => Promise<
    | { ok: true; value: { recommendedSkillSlugs: string[] } | null }
    | { ok: false; code: string; error: string }
  >;
};

export type CreateSkillToolsOptions = {
  userId: string;
  userSkills: UserSkillsLike;
  /** Optional persona-lookup seam (plan #720 phase 3). When set, `find_skill`
   *  accepts an optional `personaId` that boosts persona-recommended skills. */
  userPersonas?: PersonasLike;
};

function summarize(result: ListSkillsResult): string {
  const val = result.ok ? result.value : [];
  if (val.length === 0) return 'No skills found.';
  // Slug first so the model can follow up with fetch_skill; summaries only, no body.
  return val
    .slice(0, SKILL_FIND_RESULT_MAX)
    .map(
      (s) =>
        `${s.slug} — ${s.name}${s.description ? `: ${s.description}` : ''}`,
    )
    .join('\n');
}

/** Byte-safe body truncation to the model-return budget with an explicit marker. */
function boundBody(slug: string, body: string): string {
  const len = Buffer.byteLength(body, 'utf8');
  if (len <= SKILL_FETCH_MAX_RETURN_BYTES) return body;
  const buf = Buffer.from(body, 'utf8');
  const sliced = buf.subarray(0, SKILL_FETCH_MAX_RETURN_BYTES).toString('utf8');
  const marker = `\n…[truncated to ${SKILL_FETCH_MAX_RETURN_BYTES} bytes; full body is ${len} bytes — edit in Settings]`;
  return `${sliced}${marker}`;
}

export function createSkillTools(opts: CreateSkillToolsOptions) {
  const { userId, userSkills, userPersonas } = opts;

  const findSkill = tool({
    description:
      'Find the user\'s skills whose slug, name, or description match a query. Returns user-scoped summaries (slug, name, description) — never bodies. Use find_skill to locate the user\'s skills (search / catch typos) and fetch_skill to read the full body of one of the user\'s skills by slug. Optionally pass personaId to boost persona-recommended skills to the top.',
    inputSchema: jsonSchema<{ query?: string; personaId?: string }>({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Case-insensitive substring to match against the skill slug, name, or description. Omit or leave empty to list your skills (bounded).',
        },
        personaId: {
          type: 'string',
          description:
            'Optional persona id to boost its recommended skill slugs to the top of the results.',
        },
      },
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        // Bound identity: any identity the model passes is ignored — we always
        // operate on the route-resolved userId closed over at assembly.
        const query = (input?.query ?? '').trim().toLowerCase();
        const result = await userSkills.listUserSkills(userId);
        if (!result.ok) {
          return `ERROR find_skill: ${result.error}`;
        }
        let matched = query
          ? result.value.filter((s) => {
              const hay = `${s.slug} ${s.name} ${s.description ?? ''}`.toLowerCase();
              return hay.includes(query);
            })
          : result.value;

        // Phase 3 (#720): persona boost — resolve personaId against the caller's
        // own personas. A foreign/unknown/other-user personaId → no boost.
        if (userPersonas && input?.personaId) {
          const personaId = String(input.personaId).trim();
          if (personaId) {
            try {
              const pres = await userPersonas.getPersonaById(userId, personaId);
              if (pres.ok && pres.value && Array.isArray(pres.value.recommendedSkillSlugs)) {
                const recSet = new Set<string>();
                for (const s of pres.value.recommendedSkillSlugs) {
                  if (typeof s === 'string' && SKILL_SLUG_RE.test(s)) {
                    recSet.add(s);
                  }
                }
                if (recSet.size > 0) {
                  // Stable sort: recommended slugs first (order in the rec array is
                  // preserved), then the rest in original order.
                  const recSlugs = pres.value.recommendedSkillSlugs.filter(
                    (s: unknown) => typeof s === 'string' && recSet.has(s),
                  );
                  const rec: typeof matched = [];
                  const rest: typeof matched = [];
                  const seen = new Set<string>();
                  for (const slug of recSlugs) {
                    const s = matched.find(
                      (m) => m.slug === slug && !seen.has(m.slug),
                    );
                    if (s) {
                      seen.add(s.slug);
                      rec.push(s);
                    }
                  }
                  for (const m of matched) {
                    if (!seen.has(m.slug)) {
                      seen.add(m.slug);
                      rest.push(m);
                    }
                  }
                  matched = [...rec, ...rest];
                }
              }
            } catch {
              // Foreign/unknown personaId → no boost (never error).
            }
          }
        }

        const bounded = matched.slice(0, SKILL_FIND_RESULT_MAX);
        const body = summarize({ ok: true as const, value: bounded });
        const over = matched.length - bounded.length;
        return over > 0 ? `${body}\n…[${over} more match${over === 1 ? '' : 'es'}]` : body;
      } catch (err) {
        return `ERROR find_skill: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  const fetchSkill = tool({
    description:
      'Read the full body of one of the user\'s own skills by slug (user-scoped; unknown or another user\'s skill returns not_found, no partial). The body is bounded to the model-return budget and truncated with a marker when larger. Use find_skill to locate the user\'s skills (search / catch typos) and fetch_skill to read the full body of one of the user\'s skills by slug.',
    inputSchema: jsonSchema<{ slug: string }>({
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Skill slug (lowercase start; digits, underscore, hyphen; ≤128 chars).',
        },
      },
      required: ['slug'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const slug = (input?.slug ?? '').trim();
        const result = await userSkills.getSkillBySlug(userId, slug);
        if (!result.ok) {
          return `ERROR fetch_skill: ${result.error}`;
        }
        if (!result.value) {
          return `not_found: no skill with slug "${slug}" (user-scoped). No partial body.`;
        }
        const s = result.value;
        return [
          `=== skill: ${s.slug} ===`,
          `${s.name}${s.description ? ` — ${s.description}` : ''}`,
          '---',
          boundBody(s.slug, s.body),
          '---',
        ].join('\n');
      } catch (err) {
        return `ERROR fetch_skill: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });

  return { find_skill: findSkill, fetch_skill: fetchSkill };
}
