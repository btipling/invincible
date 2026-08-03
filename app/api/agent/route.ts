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
import { requireSessionUser } from '../../../lib/tenancy/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // DOMException AbortError + Next.js ResponseAborted
  return err.name === 'AbortError' || err.name === 'ResponseAborted';
}

/**
 * Phase 2 — multi-step agent with sandbox tools.
 *
 * POST { prompt: string }
 * → { text, toolTrace? } | { error }
 *
 * 503 when SANDBOX_URL / SANDBOX_TOKEN unset (stable string for host fallback).
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

  if (!sandboxConfigured()) {
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
    const { text, toolTrace } = await runAgent({
      prompt: parsed.prompt,
      signal: req.signal,
    });

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
