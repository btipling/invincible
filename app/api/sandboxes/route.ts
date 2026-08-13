import { createProdServices } from '../../../lib/di';
import { requireSessionUser } from '../../../lib/tenancy/session';
import { describeSandboxTools } from '../../../lib/tenancy/sandboxTools';
import type { SandboxChoice } from '../../../lib/tenancy/userPreferredSandbox';
import { isRedisSafeOpaqueId } from '../../../lib/sessionCloudCaps';

export const runtime = 'nodejs';

const services = createProdServices();

/**
 * Non-secret inventory projection of a user's allowed sandboxes (multi-tenant
 * only). `id` is projected from `SandboxChoice.sandboxId`; never `base_url` /
 * `token_ciphertext` / host inventory.
 */
function projectOption(c: SandboxChoice) {
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

/**
 * Redis-safe opaque id guard for the `?sandboxId=` query param (session-carry).
 * Omitted/empty → undefined (no override). A PRESENT but non-Redis-safe value →
 * 400, matching `parseAgentBody`'s `sandboxId` rule (the two parsers must never
 * disagree — silently treating garbage as "no active" would mask a corrupt
 * session id). Adversarial review #484 Minor.
 */
function parseQuerySandboxId(
  raw: string | null,
):
  | { ok: true; value: string | undefined }
  | { ok: false; response: Response } {
  if (raw == null || raw === '') {
    return { ok: true, value: undefined };
  }
  if (isRedisSafeOpaqueId(raw)) {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    response: Response.json(
      {
        error:
          'sandboxId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,128}$).',
      },
      { status: 400 },
    ),
  };
}

/**
 * GET /api/sandboxes — user's allowed sandboxes (non-secret) + an active-bind
 * tool-surface descriptor.
 *
 * Query: optional `?sandboxId=` = the session-owned active binding (Redis-safe).
 * - omitted → `active: null`.
 * - present + a usable grant → `active: { sandboxId, tools }`.
 * - present but unusable/ungranted/wrong-tenant → 403 (selection-required when
 *   alternatives exist, else forbidden) — mirrors `resolveAgentSandbox`.
 *
 * Auth: middleware matcher + in-route `requireSessionUser` (mirror /api/agent).
 */
export async function GET(
  req: Request,
): Promise<Response> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) {
    return sessionGate.response;
  }
  const userId = sessionGate.user?.id;
  if (!userId) {
    const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
    return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
  }

  const url = new URL(req.url);
  const parsedRequested = parseQuerySandboxId(url.searchParams.get('sandboxId'));
  if (!parsedRequested.ok) {
    return parsedRequested.response;
  }
  const requested = parsedRequested.value;

  try {
    const result = await services.userPreferredSandbox.listUserSandboxChoices(
      userId,
    );
    if (!result.ok) {
      if (result.code === 'unavailable') {
        return Response.json(
          { error: 'Could not list sandboxes.' },
          { status: 503 },
        );
      }
      return Response.json({ error: result.error }, { status: 403 });
    }

    const options = result.value.options.map(projectOption);

    // Active descriptor: only when a usable grant matches the requested id.
    let active: { sandboxId: string; tools: ReturnType<typeof describeSandboxTools> } | null = null;
    if (requested) {
      const usable = result.value.options.find(
        (c) =>
          c.sandboxId === requested &&
          c.usable &&
          (c.canRead || c.canWrite),
      );
      if (usable) {
        active = {
          sandboxId: usable.sandboxId,
          tools: describeSandboxTools(
            usable.backend === 'vercel' ? 'vercel' : 'byo',
            { canRead: usable.canRead, canWrite: usable.canWrite },
          ),
        };
      } else {
        // Fail closed: a provided-but-unusable active id → 403 class (mirrors
        // resolve). Never a stubbed `active`.
        return Response.json(
          {
            error:
              options.length > 1
                ? 'Multiple sandboxes available — choose one under Settings → Sandbox.'
                : 'Sandbox access denied.',
          },
          { status: 403 },
        );
      }
    }

    return Response.json({ options, active });
  } catch {
    return Response.json({ error: 'Could not list sandboxes.' }, { status: 503 });
  }
}
