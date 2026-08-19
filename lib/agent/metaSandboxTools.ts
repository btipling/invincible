/**
 * Built-in meta tool family — first-party SANDBOX tools (phase 2 #532, product
 * #332). Assembled always on `/api/agent` alongside the persona/skill meta
 * authoring tools (`lib/agent/metaTools.ts`).
 *
 * Three tools:
 *  - `meta_sandbox_list`   — non-secret inventory of the caller's allowed
 *    sandboxes (projected from `listUserSandboxChoices`, mirroring the
 *    `projectOption` projection of `GET /api/sandboxes`). Never `base_url` /
 *    `token_ciphertext` / host inventory.
 *  - `meta_sandbox_active` — the caller's currently-bound sandbox (the
 *    persisted `meta.activeSandboxId` on the session envelope when it is a
 *    usable grant, else null) + its `describeSandboxTools` surface — mirrors the
 *    route's `active` descriptor.
 *  - `meta_sandbox_switch` — persist `meta.activeSandboxId` to the caller's
 *    session envelope via the phase-0 envelope seam, fail-closed on a
 *    set-but-unusable / ungranted / wrong-tenant id and on store-unavailable
 *    (no partial write). Returns the new `active` descriptor on success.
 *
 * Layering: pure server-side tool wiring, no I/O construction (di-gate). It
 * receives the DI-bound `userPreferredSandbox` provider and a `sessionStoreSeam`
 * (the same `resolveSessionStore()` / `resolveTenantIdForUser()` closures the
 * route already uses) so this module never constructs a store or opens a
 * connection. Everything is bound to the route-resolved `userId` (any identity a
 * model passes is ignored — confused-deputy guard) and, for switch/active, the
 * route-resolved caller-owned `sessionId`.
 *
 * Envelope write semantics mirror `resolveSkillPreamble`
 * (`lib/tenancy/skillInject.ts`): the agent mirror writes ONLY through the
 * phase-0 envelope seam (`readEnvelope` / `upsertEnvelope`, the SAME
 * `harness:envelope:*` key the host writes), reads the envelope before writing,
 * preserves its `updatedAt` unchanged, and never rewrites `transcriptPointer` /
 * `messages`. `meta.activeSandboxId` is ALSO folded by the host on the next PUT
 * (session-carrier), so this mirror can never fight the host clock.
 */
import { jsonSchema, tool } from 'ai';
import { describeSandboxTools } from '../tenancy/sandboxTools';
import type { SandboxChoice } from '../tenancy/userPreferredSandbox';
import { isRedisSafeOpaqueId } from '../sessionCloudCaps';
import {
  isEnvelopeStore,
  type EnvelopeUpsertResult,
  type ServerSessionStore,
  type SessionEnvelope,
  type SessionEnvelopeInput,
  type SessionEnvelopeStore,
  type SessionRecordKey,
} from '../sessions/sessionStore';
import { metaSandboxSwitchActiveId } from './agentStream';

/** Non-secret projection of a user's allowed sandboxes (mirrors the route). */
export function projectSandboxOption(c: SandboxChoice) {
  return {
    id: c.sandboxId,
    name: c.name,
    slug: c.slug,
    backend: c.backend,
    status: c.status,
    image: c.image,
    canRead: c.canRead,
    canWrite: c.canWrite,
    usable: c.usable,
    granted: c.granted,
  };
}

/** Narrow `listUserSandboxChoices` provider (satisfied by the composition-root service). */
export type SandboxChoiceListProvider = {
  listUserSandboxChoices(
    userId: string,
  ): Promise<
    | { ok: true; value: { preferredSandboxId: string | null; options: SandboxChoice[] } }
    | { ok: false; code: string; error: string }
  >;
};

export type MetaStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; error: string };

/**
 * Session-store seam closed over by the route (`resolveSessionStore()` +
 * `services.harnessSessionsRedis.resolveTenantIdForUser`) so this module never
 * constructs a store or resolves membership itself.
 */
export type SessionStoreSeam = {
  resolveSessionStore(): Promise<MetaStoreResult<ServerSessionStore>>;
  resolveTenantIdForUser(userId: string): Promise<MetaStoreResult<string>>;
};

export type CreateMetaSandboxToolsOptions = {
  userId: string;
  /** Caller-owned session id (Redis-safe opaque); absent → active/switch can't read/persist. */
  sessionId?: string;
  userPreferredSandbox: SandboxChoiceListProvider;
  sessionStoreSeam: SessionStoreSeam;
};

/** System-prompt addendum whenever the sandbox tools are on the surface. */
export const META_SANDBOX_SYSTEM_ADDENDUM =
  'Sandbox bind tools exist under the meta_sandbox_* namespace: meta_sandbox_list (non-secret inventory of the user\'s allowed sandboxes), meta_sandbox_active (the currently-bound sandbox + its tool surface), and meta_sandbox_switch (persist meta.activeSandboxId to the session envelope so this session binds that sandbox; fail-closed on an unusable/ungranted id or an unavailable session store — no partial write). Sandbox secrets are never exposed.';

function prefixToolDescriptions<T extends Record<string, unknown>>(
  tools: T,
  prefix: string,
): T {
  for (const key of Object.keys(tools) as Array<keyof T>) {
    const toolObj = tools[key];
    if (!toolObj || typeof toolObj !== 'object') continue;
    const slot = toolObj as { description?: unknown };
    const text = typeof slot.description === 'string' ? slot.description : '';
    slot.description = text ? `${prefix}${text}` : prefix;
  }
  return tools;
}

/** Readable one-line summary of one projected option. */
function optionLine(o: ReturnType<typeof projectSandboxOption>): string {
  const flags: string[] = [];
  if (o.usable) flags.push('usable');
  if (o.canRead) flags.push('read');
  if (o.canWrite) flags.push('write');
  if (!o.granted) flags.push('no-grant');
  return `id=${o.id} slug=${o.slug} name=${o.name || '-'} backend=${o.backend} status=${o.status || '-'} [${flags.join(',') || 'none'}]`;
}

/** Build the `active` descriptor for a usable choice (mirrors the route). */
function activeDescriptor(c: SandboxChoice): {
  sandboxId: string;
  tools: ReturnType<typeof describeSandboxTools>;
} {
  return {
    sandboxId: c.sandboxId,
    tools: describeSandboxTools(c.backend === 'vercel' ? 'vercel' : 'byo', {
      canRead: c.canRead,
      canWrite: c.canWrite,
    }),
  };
}

/** A choice is a usable grant (active + read or write), mirroring the route. */
function isUsable(c: SandboxChoice): boolean {
  return c.usable && (c.canRead || c.canWrite);
}

/**
 * Persist `meta.activeSandboxId = activeId` onto the session envelope with a
 * bounded conflict retry (adversarial-review Block, bug B2). The mirror never
 * bumps the host clock: it preserves the stored `updatedAt` (a fresh envelope —
 * none exists yet — seeds the clock so the write persists). When the store
 * returns `conflict` (a concurrent host PUT advanced `updatedAt` between our
 * read and write), re-read the live envelope once and retry with its clock so
 * the switch still lands. Returns `true` ONLY for a stored write — any other
 * result (a still-conflicting retry, an unexpected status) fails closed and the
 * caller reports the honest error, never a false "switched" success.
 */
async function retryPersistActiveSandbox(
  store: SessionEnvelopeStore,
  key: SessionRecordKey,
  identity: { id: string; userId: string; tenantId: string; activeId: string },
): Promise<boolean> {
  const attempt = async (): Promise<EnvelopeUpsertResult> => {
    const envelope = await store.readEnvelope(key);
    const updatedAt = envelope?.updatedAt ?? Date.now();
    // Mirror `resolveSkillPreamble`: preserve the stored `updatedAt` (never bump
    // the host clock); `createdAt` is preserved by the store.
    const input: SessionEnvelopeInput = {
      id: identity.id,
      userId: identity.userId,
      tenantId: identity.tenantId,
      updatedAt,
      // Copy-forward then override: store replaces whole meta (omit = clear).
      meta: { ...(envelope?.meta ?? {}), activeSandboxId: identity.activeId },
    };
    return store.upsertEnvelope(key, input);
  };

  const first = await attempt();
  if (first.status === 'stored') return true;
  // Bound retry once for a concurrent host-bumped clock (LWW conflict).
  const retried = await attempt();
  return retried.status === 'stored';
}

/** A tool's full text — the model-return + preview (no secrets, bounded). */
function renderOptions(options: SandboxChoice[]): string {
  const proj = options.map(projectSandboxOption);
  return proj.length === 0
    ? 'No sandboxes found for this user.'
    : proj.map(optionLine).join('\n');
}

/** Read the persisted active sandbox id from the caller's session envelope. */
async function readPersistedActive(
  opts: CreateMetaSandboxToolsOptions,
): Promise<{ active: string | undefined; envelope: SessionEnvelope | null; storeAvailable: boolean }> {
  const { userId, sessionId, sessionStoreSeam } = opts;
  if (!sessionId) return { active: undefined, envelope: null, storeAvailable: false };
  try {
    const tenantRes = await sessionStoreSeam.resolveTenantIdForUser(userId);
    if (!tenantRes.ok) return { active: undefined, envelope: null, storeAvailable: false };
    const storeRes = await sessionStoreSeam.resolveSessionStore();
    if (!storeRes.ok) return { active: undefined, envelope: null, storeAvailable: false };
    const store = storeRes.value;
    if (!isEnvelopeStore(store)) return { active: undefined, envelope: null, storeAvailable: false };
    const key: SessionRecordKey = { tenantId: tenantRes.value, userId, sessionId };
    const envelope = await store.readEnvelope(key);
    const raw = envelope?.meta?.activeSandboxId;
    const active = typeof raw === 'string' && raw !== '' ? raw : undefined;
    return { active, envelope: envelope ?? null, storeAvailable: true };
  } catch {
    return { active: undefined, envelope: null, storeAvailable: false };
  }
}

function errText(name: string, err: unknown): string {
  return `ERROR ${name}: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Extract the post-turn EFFECTIVE active sandbox id from an AI-SDK step result
 * set when a `meta_sandbox_switch` SUCCEEDED during the turn. The tool emits
 * `switched active sandbox to id=<id> tools=[...]` only on a persisted write;
 * `undefined` when no switch (or only failed/EARLY-return switch) ran. This is
 * the structured carrier runAgent folds back to the host on `done` / the JSON
 * result: the host must persist the SWITCHED bind, never the pre-turn
 * `params.sandboxId` (which would otherwise overwrite the envelope write the
 * switch just made — blocker B1). Mirrors the `change_dir`/`cwd` typed-carrier
 * pattern (#470) — never re-derived from the truncated display summary.
 */
export function metaSandboxSwitchTargetId(
  result: {
    steps?: Array<{
      toolResults?: Array<{
        toolName?: string;
        result?: unknown;
        output?: unknown;
      }>;
    }>;
  },
): string | undefined {
  const steps = result.steps ?? [];
  let lastId: string | undefined;
  for (const step of steps) {
    const results = step.toolResults ?? [];
    for (const r of results) {
      if (r.toolName !== 'meta_sandbox_switch') continue;
      const raw =
        r.output != null
          ? r.output
          : 'result' in r
            ? r.result
            : undefined;
      const id = metaSandboxSwitchActiveId(
        typeof raw === 'string' ? raw : undefined,
      );
      if (id) lastId = id;
    }
  }
  return lastId;
}

export function createMetaSandboxTools(opts: CreateMetaSandboxToolsOptions) {
  const { userId, sessionId, userPreferredSandbox, sessionStoreSeam } = opts;

  const metaSandboxList = tool({
    description:
      "List the user's allowed sandboxes (non-secret: id, name, slug, backend, status, canRead, canWrite, usable, granted). Returns only the signed-in user's sandboxes within their tenant. Never exposes base_url or tokens.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      try {
        const res = await userPreferredSandbox.listUserSandboxChoices(userId);
        if (!res.ok) {
          return res.code === 'unavailable'
            ? 'ERROR meta_sandbox_list: could not list sandboxes (unavailable).'
            : `ERROR meta_sandbox_list: ${res.error}`;
        }
        return renderOptions(res.value.options);
      } catch (err) {
        return errText('meta_sandbox_list', err);
      }
    },
  });

  const metaSandboxActive = tool({
    description:
      "Read the currently-bound sandbox of this session (the persisted meta.activeSandboxId when it is a usable grant, else null) plus its tool surface, and list the user's allowed sandboxes. Mirrors GET /api/sandboxes. Never exposes secrets.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      try {
        const res = await userPreferredSandbox.listUserSandboxChoices(userId);
        if (!res.ok) {
          return res.code === 'unavailable'
            ? 'ERROR meta_sandbox_active: could not list sandboxes (unavailable).'
            : `ERROR meta_sandbox_active: ${res.error}`;
        }
        const options = res.value.options;
        const { active: activeId } = await readPersistedActive(opts);
        let activeLine: string;
        if (activeId) {
          const usable = options.find((c) => c.sandboxId === activeId && isUsable(c));
          if (usable) {
            const desc = activeDescriptor(usable);
            const toolNames = desc.tools.map((t) => t.name).join(', ');
            activeLine = `active: sandboxId=${desc.sandboxId} tools=[${toolNames}]`;
          } else {
            // Set-but-unusable → fail closed (honest): report it, no fake descriptor.
            activeLine = `active: sandboxId=${activeId} is set but NOT a usable grant (fail-closed; will 403 until re-selected)`;
          }
        } else {
          activeLine = 'active: null (no persisted override; resolution falls back to preferred/single/default)';
        }
        const listed = renderOptions(options);
        return `${activeLine}\n--- options ---\n${listed}`;
      } catch (err) {
        return errText('meta_sandbox_active', err);
      }
    },
  });

  const metaSandboxSwitch = tool({
    description:
      "Switch the session's active sandbox: persist meta.activeSandboxId = sandboxId to the session envelope so subsequent turns bind that sandbox. The id must be a usable grant to the signed-in user (fail-closed otherwise, no write) and the session store must be available (no partial write). Returns the new active descriptor. Requires a sessionId on the request.",
    inputSchema: jsonSchema<{ sandboxId: string }>({
      type: 'object',
      properties: {
        sandboxId: {
          type: 'string',
          description: 'Sandbox id (from meta_sandbox_list / meta_sandbox_active). Must be a Redis-safe opaque id that is a usable grant to the signed-in user.',
        },
      },
      required: ['sandboxId'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const id = (input?.sandboxId ?? '').trim();
      if (!id) return 'ERROR meta_sandbox_switch: sandboxId is required';
      if (!isRedisSafeOpaqueId(id)) {
        return 'ERROR meta_sandbox_switch: sandboxId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$)';
      }
      try {
        const res = await userPreferredSandbox.listUserSandboxChoices(userId);
        if (!res.ok) {
          return res.code === 'unavailable'
            ? 'ERROR meta_sandbox_switch: could not list sandboxes (unavailable).'
            : `ERROR meta_sandbox_switch: ${res.error}`;
        }
        const options = res.value.options;
        const usable = options.find((c) => c.sandboxId === id && isUsable(c));
        if (!usable) {
          const otherCount = options.filter(isUsable).length;
          return otherCount > 1
            ? 'ERROR meta_sandbox_switch: sandbox is not a usable grant to you (multiple usable sandboxes available — pick one from the list).'
            : 'ERROR meta_sandbox_switch: sandbox access denied or not a usable grant (fail-closed, no write).';
        }
        if (!sessionId) {
          return 'ERROR meta_sandbox_switch: no sessionId on the request — cannot persist active sandbox to a session (no write).';
        }

        let tenantId: string;
        let store: ServerSessionStore;
        try {
          const tenantRes = await sessionStoreSeam.resolveTenantIdForUser(userId);
          if (!tenantRes.ok) {
            return 'ERROR meta_sandbox_switch: cannot resolve tenant (session store unavailable?) — active sandbox not switched (no write).';
          }
          tenantId = tenantRes.value;
          const storeRes = await sessionStoreSeam.resolveSessionStore();
          if (!storeRes.ok) {
            return 'ERROR meta_sandbox_switch: session store unavailable — active sandbox not switched (no partial write).';
          }
          store = storeRes.value;
        } catch {
          return 'ERROR meta_sandbox_switch: session store unavailable — active sandbox not switched (no partial write).';
        }
        if (!isEnvelopeStore(store)) {
          return 'ERROR meta_sandbox_switch: session store does not support the envelope seam — active sandbox not switched (no partial write).';
        }

        const key: SessionRecordKey = { tenantId, userId, sessionId };
        try {
          const persisted = await retryPersistActiveSandbox(store, key, {
            id: sessionId,
            userId,
            tenantId,
            activeId: id,
          });
          if (!persisted) {
            return 'ERROR meta_sandbox_switch: active sandbox not switched — the session envelope changed concurrently and could not be re-stored (no partial write; no false success).';
          }
        } catch {
          return 'ERROR meta_sandbox_switch: failed to persist active sandbox (no partial write).';
        }

        const desc = activeDescriptor(usable);
        const toolNames = desc.tools.map((t) => t.name).join(', ');
        return `switched active sandbox to id=${desc.sandboxId} tools=[${toolNames}]`;
      } catch (err) {
        return errText('meta_sandbox_switch', err);
      }
    },
  });

  return prefixToolDescriptions(
    {
      meta_sandbox_list: metaSandboxList,
      meta_sandbox_active: metaSandboxActive,
      meta_sandbox_switch: metaSandboxSwitch,
    },
    'Sandbox bind tool. Sandbox secrets are never exposed. ',
  );
}
