import { generateText, type JSONValue } from 'ai';
import {
  gatewayConfigured,
  mapByokResolveFailure,
  mapInferenceError,
  missingGatewayKeyError,
  parseChatBody,
} from '../../../lib/chatServer';
import { createProdServices } from '../../../lib/di';
import { redactSecrets } from '../../../lib/agent/redact';
import { requireSessionUser } from '../../../lib/tenancy/session';

export const runtime = 'nodejs';
// Vercel Pro/Enterprise Fluid extended max is 1800s (30m). 3600s is not offered.
export const maxDuration = 1800;

const { resolveInferenceForRequest } = createProdServices();

/**
 * Non-streaming chat via Vercel AI Gateway.
 *
 * POST { prompt: string, modelId?: string } → { text: string } | { error: string }
 *
 * Multi-tenant only: session user required; request-scoped BYOK
 * (modelId optional → first granted).
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

  let redactList: string[] = [];

  try {
    const userId = sessionGate.user?.id;
    if (!userId) {
      const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
      return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
    }

    const byok = await resolveInferenceForRequest.resolveByokForRequest(
      userId,
      parsed.modelId,
    );
    if (!byok.ok) {
      const { status, error } = mapByokResolveFailure(byok.reason);
      return Response.json({ error }, { status });
    }
    redactList = byok.secretsToRedact;

    // AI SDK ProviderOptions = Record<string, Record<string, JSONValue>>.
    // Credential objects are JSON from DEK decrypt; cast at the SDK boundary.
    const result = await generateText({
      model: byok.modelId,
      prompt: parsed.prompt,
      providerOptions: {
        gateway: {
          only: byok.only as JSONValue,
          byok: byok.byok as JSONValue,
        },
      },
    });

    const text = result.text?.trim() ?? '';
    if (!text) {
      return Response.json({ error: 'Empty model response.' }, { status: 502 });
    }

    return Response.json({ text });
  } catch (err) {
    const { status, error } = mapInferenceError(err);
    const safe =
      redactList.length > 0 ? redactSecrets(error, redactList) : error;
    return Response.json({ error: safe }, { status });
  }
}
