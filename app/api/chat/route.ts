import { generateText } from 'ai';
import {
  gatewayConfigured,
  mapInferenceError,
  missingGatewayKeyError,
  parseChatBody,
} from '../../../lib/chatServer';
import { resolveModelId } from '../../../lib/model';
import { requireSessionUser } from '../../../lib/tenancy/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Phase 1.4 — non-streaming chat via Vercel AI Gateway.
 *
 * POST { prompt: string } → { text: string } | { error: string }
 *
 * Requires `AI_GATEWAY_API_KEY`. Optional `DEFAULT_MODEL` (provider/model).
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

  const model = resolveModelId();

  try {
    const result = await generateText({
      model,
      prompt: parsed.prompt,
    });

    const text = result.text?.trim() ?? '';
    if (!text) {
      return Response.json({ error: 'Empty model response.' }, { status: 502 });
    }

    return Response.json({ text });
  } catch (err) {
    const { status, error } = mapInferenceError(err);
    return Response.json({ error }, { status });
  }
}
