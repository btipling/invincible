/**
 * Built-in meta tool family — first-party persona + skill AUTHORING tools
 * (phase 1 #531, product #332). Assembled always on `/api/agent` alongside the
 * read-only `find_skill` / `fetch_skill` (`lib/agent/skillTools.ts`).
 *
 * These are **write** tools: the agent can list/read/create/update/delete its
 * OWN personas and skills, authorized as the signed-in caller (same grants as
 * Settings). They are in-process AI SDK tools (architectural decision A from
 * parent #530) — NOT a literal MCP transport — and never expose secrets.
 *
 * Layering: pure server-side tool wiring, no I/O construction. It receives the
 * DI-bound `userPersonas` / `userSkills` objects (composition root) and the
 * route-resolved `userId` at assembly time. Every operation is bound to that
 * `userId` — any identity a model passes is ignored (confused-deputy guard),
 * and the stores filter tenant+user so another user's/tenant's row never leaks
 * existence (`getPersonaById` / `getSkillBySlug` → null for foreign rows → we
 * return `not_found`, no partial).
 *
 * Model payload discipline: summaries on `*_list` (no body); bodies returned to
 * the model ONLY on an explicit `*_read`, capped (personas: store-enforced
 * `PERSONA_BODY_MAX_BYTES`; skills: `SKILL_FETCH_MAX_RETURN_BYTES` with an
 * explicit truncation marker, mirroring `fetch_skill`). Writes that exceed a
 * store cap are rejected (the store enforces the cap) — never truncated on
 * write. Tool traces stay short one-liners for the `tool_run` paint.
 *
 * Slugs: both stores REQUIRE a slug on create. If the model omits one, we
 * derive it here (Settings-style) before calling the store — the store is never
 * asked to derive.
 */
import { jsonSchema, tool } from 'ai';
import { SKILL_FETCH_MAX_RETURN_BYTES, SKILL_FIND_RESULT_MAX } from '../sessionCloudCaps';
import type {
  CreateUserPersonaInput,
  UserPersonaSummary,
  UserPersonasDeps,
  UserPersonasResult,
} from '../tenancy/userPersonas';
import type {
  CreateUserSkillInput,
  UserSkillSummary,
  UserSkillsDeps,
  UserSkillsResult,
} from '../tenancy/userSkills';

/** Reserved first-party prefix that marks this family (route soft-path guard). */
export const META_TOOL_PREFIX = 'meta_';

/** True for any first-party meta tool name (used by the route soft-path guard). */
export function isMetaToolName(name: string): boolean {
  return typeof name === 'string' && name.startsWith(META_TOOL_PREFIX);
}

/** Persona body row subset (user-scoped, already capped by the store). */
export type PersonaRow = {
  id: string;
  name: string;
  slug: string;
  body: string;
  isDefault: boolean;
};

/** Skill body row subset (user-scoped, body capped for model return). */
export type SkillRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  body: string;
};

/** Narrow persona-store surface the tools need (satisfied by composition-root service). */
export type UserPersonasLike = {
  listUserPersonas: (userId: string, o?: UserPersonasDeps) => Promise<UserPersonasResult<UserPersonaSummary[]>>;
  getPersonaById: (userId: string, id: string, o?: UserPersonasDeps) => Promise<UserPersonasResult<PersonaRow | null>>;
  createUserPersona: (input: CreateUserPersonaInput, o?: UserPersonasDeps) => Promise<UserPersonasResult<{ id: string }>>;
  renameUserPersona: (userId: string, id: string, name: string, o?: UserPersonasDeps) => Promise<UserPersonasResult<{ id: string }>>;
  updateUserPersonaBody: (userId: string, id: string, body: string, o?: UserPersonasDeps) => Promise<UserPersonasResult<{ id: string }>>;
  setDefaultPersona: (userId: string, id: string, o?: UserPersonasDeps) => Promise<UserPersonasResult<{ id: string }>>;
  clearDefaultPersona: (userId: string, o?: UserPersonasDeps) => Promise<UserPersonasResult<{ cleared: boolean }>>;
  deleteUserPersona: (userId: string, id: string, o?: UserPersonasDeps) => Promise<UserPersonasResult<{ id: string }>>;
};

/** Narrow skill-store surface the tools need (satisfied by composition-root service). */
export type UserSkillsLike = {
  listUserSkills: (userId: string, o?: UserSkillsDeps) => Promise<UserSkillsResult<UserSkillSummary[]>>;
  getSkillBySlug: (userId: string, slug: string, o?: UserSkillsDeps) => Promise<UserSkillsResult<SkillRow | null>>;
  createUserSkill: (input: CreateUserSkillInput, o?: UserSkillsDeps) => Promise<UserSkillsResult<{ id: string }>>;
  updateUserSkillSummary: (
    userId: string,
    id: string,
    input: { name: string; description?: string },
    o?: UserSkillsDeps,
  ) => Promise<UserSkillsResult<{ id: string }>>;
  updateUserSkillBody: (userId: string, id: string, body: string, o?: UserSkillsDeps) => Promise<UserSkillsResult<{ id: string }>>;
  deleteUserSkill: (userId: string, id: string, o?: UserSkillsDeps) => Promise<UserSkillsResult<{ id: string }>>;
};

export type CreateMetaPersonaSkillToolsOptions = {
  userId: string;
  userPersonas: UserPersonasLike;
  userSkills: UserSkillsLike;
};

/** System-prompt addendum shown whenever the meta authoring tools are on the surface. */
export const META_TOOLS_SYSTEM_ADDENDUM =
  'First-party authoring tools exist under the meta_* namespace: meta_persona_* (list/read/create/update_name/update_body/set_default/clear_default/delete the user\'s own personas) and meta_skill_* (list/read/create/update_summary/update_body/delete the user\'s own skills). Bodies are non-secret user content returned only on an explicit read and are capped. Authoring runs as the signed-in user (no separate confirm), same as Settings. Use these to manage the user\'s persona/skill configuration; find_skill / fetch_skill remain for quick read-only reference.';

/** System prompt when skill + meta tools are the ONLY non-filesystem tools available. */
export const SKILL_META_ONLY_SYSTEM =
  'You are the Invincible agent. Workspace filesystem tools are unavailable this turn. Use find_skill / fetch_skill to read the user\'s skills, and meta_persona_* / meta_skill_* to manage the user\'s personas and skills. Be concise.';

/**
 * Settings-style slug derivation, applied in the TOOL layer (never the store).
 * `hyphen` selects the skill charset (hyphen allowed) vs the persona charset
 * (underscore only). Result always starts with a lowercase letter and is capped
 * at `max` chars to satisfy the store slug REs.
 */
function slugify(input: string, max: number, hyphen: boolean): string {
  let s = String(input ?? '').trim().toLowerCase();
  s = s.replace(hyphen ? /[^a-z0-9_-]+/g : /[^a-z0-9_]+/g, '_');
  s = s.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) s = 'x';
  if (!/^[a-z]/.test(s)) s = `x_${s}`;
  if (s.length > max) s = s.slice(0, max);
  if (!/^[a-z]/.test(s)) s = 'x';
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function derivePersonaSlug(name: string): string {
  return slugify(name, 64, false);
}

function deriveSkillSlug(name: string): string {
  return slugify(name, 128, true);
}

/** Byte-safe skill body truncation to the model-return budget with an explicit marker. */
function boundSkillBody(slug: string, body: string): string {
  const len = Buffer.byteLength(body, 'utf8');
  if (len <= SKILL_FETCH_MAX_RETURN_BYTES) return body;
  const buf = Buffer.from(body, 'utf8');
  const sliced = buf.subarray(0, SKILL_FETCH_MAX_RETURN_BYTES).toString('utf8');
  const marker =
    `\n…[truncated to ${SKILL_FETCH_MAX_RETURN_BYTES} bytes; full body is ${len} bytes — edit in Settings]`;
  return `${sliced}${marker}`;
}

function errText(name: string, err: unknown): string {
  return `ERROR ${name}: ${err instanceof Error ? err.message : String(err)}`;
}

export function createMetaPersonaSkillTools(
  opts: CreateMetaPersonaSkillToolsOptions,
) {
  const { userId, userPersonas, userSkills } = opts;

  // --- persona family ------------------------------------------------------

  const metaPersonaList = tool({
    description:
      "List the user's own personas (summaries: id, name, slug, isDefault — never body). Returns all personas belonging to the signed-in user only.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      try {
        const res = await userPersonas.listUserPersonas(userId);
        if (!res.ok) return `ERROR meta_persona_list: ${res.error}`;
        if (res.value.length === 0) return 'No personas found.';
        return res.value
          .map((p) =>
            `id=${p.id} slug=${p.slug} name=${p.name}${p.isDefault ? ' [default]' : ''}`,
          )
          .join('\n');
      } catch (err) {
        return errText('meta_persona_list', err);
      }
    },
  });

  const metaPersonaRead = tool({
    description:
      "Read the full body of the user's own persona by id (user-scoped; unknown or another user's/tenant's persona returns not_found, no partial). Body is capped by the store's persona cap.",
    inputSchema: jsonSchema<{ id: string }>({
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Persona id (from meta_persona_list).' },
      },
      required: ['id'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const id = (input?.id ?? '').trim();
      if (!id) return 'ERROR meta_persona_read: id is required';
      try {
        const res = await userPersonas.getPersonaById(userId, id);
        if (!res.ok) return `ERROR meta_persona_read: ${res.error}`;
        if (!res.value) {
          return `not_found: no persona with id "${id}" (user-scoped). No partial body.`;
        }
        const p = res.value;
        return [
          `=== persona: ${p.slug} ===`,
          `${p.name}${p.isDefault ? ' [default]' : ''}`,
          '---',
          p.body,
          '---',
        ].join('\n');
      } catch (err) {
        return errText('meta_persona_read', err);
      }
    },
  });

  const metaPersonaCreate = tool({
    description:
      "Create a new persona for the signed-in user. slug is optional — when omitted it is derived from name. Optional isDefault=true sets it as the single default. Body must be under the store cap (rejected otherwise, never truncated). Overwrites nothing (duplicate slug → error).",
    inputSchema: jsonSchema<{
      name: string;
      slug?: string;
      body: string;
      isDefault?: boolean;
    }>({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name (1–80 chars).' },
        slug: {
          type: 'string',
          description: 'Optional slug (^[a-z][a-z0-9_]{0,63}$). Derived from name when omitted.',
        },
        body: { type: 'string', description: 'Persona body (≤ 16 KiB).' },
        isDefault: {
          type: 'boolean',
          description: 'Optional: set as the single default persona.',
        },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const name = (input?.name ?? '').trim();
      const body = input?.body ?? '';
      const supplied = (input?.slug ?? '').trim();
      const slug = supplied || derivePersonaSlug(name);
      try {
        const res = await userPersonas.createUserPersona({
          userId,
          name,
          slug,
          body,
          ...(input?.isDefault ? { isDefault: true } : {}),
        });
        if (!res.ok) return `ERROR meta_persona_create: ${res.error}`;
        return `created persona id=${res.value.id} slug=${slug}${input?.isDefault ? ' (default)' : ''}`;
      } catch (err) {
        return errText('meta_persona_create', err);
      }
    },
  });

  const metaPersonaUpdateName = tool({
    description: "Rename the user's own persona by id (keeps body, slug, default flag).",
    inputSchema: jsonSchema<{ id: string; name: string }>({
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string', description: 'New display name (1–80 chars).' },
      },
      required: ['id', 'name'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const id = (input?.id ?? '').trim();
      if (!id) return 'ERROR meta_persona_update_name: id is required';
      try {
        const res = await userPersonas.renameUserPersona(userId, id, input?.name ?? '');
        if (!res.ok) return `ERROR meta_persona_update_name: ${res.error}`;
        return `renamed persona id=${res.value.id}`;
      } catch (err) {
        return errText('meta_persona_update_name', err);
      }
    },
  });

  const metaPersonaUpdateBody = tool({
    description:
      "Replace the body of the user's own persona by id (keeps name, slug, default flag). Body must be under the store cap (rejected otherwise, never truncated).",
    inputSchema: jsonSchema<{ id: string; body: string }>({
      type: 'object',
      properties: {
        id: { type: 'string' },
        body: { type: 'string', description: 'New persona body (≤ 16 KiB).' },
      },
      required: ['id', 'body'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const id = (input?.id ?? '').trim();
      if (!id) return 'ERROR meta_persona_update_body: id is required';
      try {
        const res = await userPersonas.updateUserPersonaBody(userId, id, input?.body ?? '');
        if (!res.ok) return `ERROR meta_persona_update_body: ${res.error}`;
        return `updated body of persona id=${res.value.id}`;
      } catch (err) {
        return errText('meta_persona_update_body', err);
      }
    },
  });

  const metaPersonaSetDefault = tool({
    description: "Set the user's own persona by id as the single default (clears all others).",
    inputSchema: jsonSchema<{ id: string }>({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const id = (input?.id ?? '').trim();
      if (!id) return 'ERROR meta_persona_set_default: id is required';
      try {
        const res = await userPersonas.setDefaultPersona(userId, id);
        if (!res.ok) return `ERROR meta_persona_set_default: ${res.error}`;
        return `set default persona id=${res.value.id}`;
      } catch (err) {
        return errText('meta_persona_set_default', err);
      }
    },
  });

  const metaPersonaClearDefault = tool({
    description: "Clear the default-persona flag for the user (no current default → no-op, still ok).",
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      try {
        const res = await userPersonas.clearDefaultPersona(userId);
        if (!res.ok) return `ERROR meta_persona_clear_default: ${res.error}`;
        return 'cleared default persona';
      } catch (err) {
        return errText('meta_persona_clear_default', err);
      }
    },
  });

  const metaPersonaDelete = tool({
    description: "Delete the user's own persona by id (removes the row, including if it was the default).",
    inputSchema: jsonSchema<{ id: string }>({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const id = (input?.id ?? '').trim();
      if (!id) return 'ERROR meta_persona_delete: id is required';
      try {
        const res = await userPersonas.deleteUserPersona(userId, id);
        if (!res.ok) return `ERROR meta_persona_delete: ${res.error}`;
        return `deleted persona id=${res.value.id}`;
      } catch (err) {
        return errText('meta_persona_delete', err);
      }
    },
  });

  // --- skill family --------------------------------------------------------

  const metaSkillList = tool({
    description:
      "List the user's own skills (summaries: id, slug, name, description — never body). Returns only the signed-in user's skills, bounded.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      try {
        const res = await userSkills.listUserSkills(userId);
        if (!res.ok) return `ERROR meta_skill_list: ${res.error}`;
        const rows = res.value.slice(0, SKILL_FIND_RESULT_MAX);
        if (rows.length === 0) return 'No skills found.';
        const body = rows
          .map((s) =>
            `id=${s.id} slug=${s.slug} name=${s.name}${s.description ? `: ${s.description}` : ''}`,
          )
          .join('\n');
        const over = res.value.length - rows.length;
        return over > 0 ? `${body}\n…[${over} more]` : body;
      } catch (err) {
        return errText('meta_skill_list', err);
      }
    },
  });

  const metaSkillRead = tool({
    description:
      "Read the full body of the user's own skill by slug (user-scoped; unknown or another user's/tenant's skill returns not_found, no partial). Body is capped to the model-return budget and truncated with a marker when larger.",
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
      const slug = (input?.slug ?? '').trim();
      if (!slug) return 'ERROR meta_skill_read: slug is required';
      try {
        const res = await userSkills.getSkillBySlug(userId, slug);
        if (!res.ok) return `ERROR meta_skill_read: ${res.error}`;
        if (!res.value) {
          return `not_found: no skill with slug "${slug}" (user-scoped). No partial body.`;
        }
        const s = res.value;
        return [
          `=== skill: ${s.slug} ===`,
          `${s.name}${s.description ? ` — ${s.description}` : ''}`,
          '---',
          boundSkillBody(s.slug, s.body),
          '---',
        ].join('\n');
      } catch (err) {
        return errText('meta_skill_read', err);
      }
    },
  });

  const metaSkillCreate = tool({
    description:
      "Create a new skill for the signed-in user. slug is optional — when omitted it is derived from name. Body must be under the store cap (rejected otherwise, never truncated). Duplicate slug → error.",
    inputSchema: jsonSchema<{
      name: string;
      slug?: string;
      body: string;
      description?: string;
    }>({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name (1–200 chars).' },
        slug: {
          type: 'string',
          description: 'Optional slug (^[a-z][a-z0-9_-]{0,127}$). Derived from name when omitted.',
        },
        body: { type: 'string', description: 'Skill body (≤ 4 MiB).' },
        description: { type: 'string', description: 'Optional short summary (≤ 2000 chars).' },
      },
      required: ['name', 'body'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const name = (input?.name ?? '').trim();
      const body = input?.body ?? '';
      const supplied = (input?.slug ?? '').trim();
      const slug = supplied || deriveSkillSlug(name);
      const description = input?.description ?? undefined;
      try {
        const res = await userSkills.createUserSkill({
          userId,
          name,
          slug,
          body,
          ...(description !== undefined ? { description } : {}),
        });
        if (!res.ok) return `ERROR meta_skill_create: ${res.error}`;
        return `created skill id=${res.value.id} slug=${slug}`;
      } catch (err) {
        return errText('meta_skill_create', err);
      }
    },
  });

  const metaSkillUpdateSummary = tool({
    description:
      "Update the name (and optional description) of the user's own skill by id. Keeps slug and body; slug is immutable.",
    inputSchema: jsonSchema<{ id: string; name: string; description?: string }>({
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string', description: 'New display name (1–200 chars).' },
        description: { type: 'string', description: 'Optional short summary (≤ 2000 chars).' },
      },
      required: ['id', 'name'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const id = (input?.id ?? '').trim();
      if (!id) return 'ERROR meta_skill_update_summary: id is required';
      try {
        const res = await userSkills.updateUserSkillSummary(userId, id, {
          name: input?.name ?? '',
          ...(input?.description !== undefined ? { description: input.description } : {}),
        });
        if (!res.ok) return `ERROR meta_skill_update_summary: ${res.error}`;
        return `updated summary of skill id=${res.value.id}`;
      } catch (err) {
        return errText('meta_skill_update_summary', err);
      }
    },
  });

  const metaSkillUpdateBody = tool({
    description:
      "Replace the body of the user's own skill by id (keeps name, slug, description). Body must be under the store cap (rejected otherwise, never truncated).",
    inputSchema: jsonSchema<{ id: string; body: string }>({
      type: 'object',
      properties: {
        id: { type: 'string' },
        body: { type: 'string', description: 'New skill body (≤ 4 MiB).' },
      },
      required: ['id', 'body'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const id = (input?.id ?? '').trim();
      if (!id) return 'ERROR meta_skill_update_body: id is required';
      try {
        const res = await userSkills.updateUserSkillBody(userId, id, input?.body ?? '');
        if (!res.ok) return `ERROR meta_skill_update_body: ${res.error}`;
        return `updated body of skill id=${res.value.id}`;
      } catch (err) {
        return errText('meta_skill_update_body', err);
      }
    },
  });

  const metaSkillDelete = tool({
    description: "Delete the user's own skill by id.",
    inputSchema: jsonSchema<{ id: string }>({
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const id = (input?.id ?? '').trim();
      if (!id) return 'ERROR meta_skill_delete: id is required';
      try {
        const res = await userSkills.deleteUserSkill(userId, id);
        if (!res.ok) return `ERROR meta_skill_delete: ${res.error}`;
        return `deleted skill id=${res.value.id}`;
      } catch (err) {
        return errText('meta_skill_delete', err);
      }
    },
  });

  return {
    meta_persona_list: metaPersonaList,
    meta_persona_read: metaPersonaRead,
    meta_persona_create: metaPersonaCreate,
    meta_persona_update_name: metaPersonaUpdateName,
    meta_persona_update_body: metaPersonaUpdateBody,
    meta_persona_set_default: metaPersonaSetDefault,
    meta_persona_clear_default: metaPersonaClearDefault,
    meta_persona_delete: metaPersonaDelete,
    meta_skill_list: metaSkillList,
    meta_skill_read: metaSkillRead,
    meta_skill_create: metaSkillCreate,
    meta_skill_update_summary: metaSkillUpdateSummary,
    meta_skill_update_body: metaSkillUpdateBody,
    meta_skill_delete: metaSkillDelete,
  };
}
