import {
  gatewayConfigured,
  mapInferenceError,
  missingGatewayKeyError,
  parseChatBody,
} from '../../../lib/chatServer';
import {
  SANDBOX_NOT_CONFIGURED_ERROR,
  sandboxConfigured,
} from '../../../lib/sandbox/config';
import { runAgent } from '../../../lib/agent/runAgent';
import { tenancyEnabled } from '../../../lib/tenancy/enabled';
import { requireSessionUser } from '../../../lib/tenancy/session';
import { resolveAgentSandbox } from '../../../lib/tenancy/resolveSandbox';

export const runtime = 'nodejs';
export const maxDuration = 60;

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // DOMException AbortError + Next.js ResponseAborted
  return err.name === 'AbortError' || err.name === 'ResponseAborted';
}

/**
 * Multi-step agent with sandbox tools.
 *
 * POST { prompt: string }
 * → { text, toolTrace? } | { error }
 *
 * Tenancy on: DB-resolved sandbox + grants (403 if unauthorized).
 * Tenancy off: env SANDBOX_* (503 if unconfigured) — host chat fallback.
 */
export async function POST(req: Request): Promise<Response> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) {
    return sessionGate.response;
  }

  if (!gatewayConfigured()) {
    const { status, error } = missingGatewayKeyError();
    return Response.json({ error }, { status });
  }

  const tenancyOn = tenancyEnabled();

  if (!tenancyOn && !sandboxConfigured()) {
    return Response.json({ error: SANDBOX_NOT_CONFIGURED_ERROR }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: 'Invalid JSON body. Expected { prompt: string }.' },
      { status: 400 },
    );
  }

  const parsed = parseChatBody(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }

  try {
    let runParams: Parameters<typeof runAgent>[0] = {
      prompt: parsed.prompt,
      signal: req.signal,
    };

    if (tenancyOn) {
      const userId = sessionGate.user?.id;
      if (!userId) {
        // Defense-in-depth: requireSessionUser should have failed already
        const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
        return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
      }
      const resolved = await resolveAgentSandbox(userId);
      if (!resolved.ok) {
        return resolved.response;
      }
      runParams = {
        ...runParams,
        sandboxClient: resolved.value.client,
        secrets: resolved.value.secrets,
        permissions: resolved.value.permissions,
      };
    }

    const { text, toolTrace } = await runAgent(runParams);

    if (!text) {
      return Response.json({ error: 'Empty model response.' }, { status: 502 });
    }

    return Response.json({
      text,
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) {
      return Response.json({ error: 'Request cancelled.' }, { status: 499 });
    }
    const { status, error } = mapInferenceError(err);
    return Response.json({ error }, { status });
  }
}
