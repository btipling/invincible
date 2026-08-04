/**
 * Pure helpers for the chat / agent API routes.
 * Inference call stays in the route (generateText + gateway).
 */

import { normalizePrompt, validatePrompt } from './chatApi';
import { isValidModelId } from './gateway/byokProviders';
import {
  INFERENCE_FORBIDDEN_ERROR,
  INFERENCE_MODEL_REQUIRED_ERROR,
  INFERENCE_UNAVAILABLE_ERROR,
} from './tenancy/errors';

export type ParsedChatBody =
  | { ok: true; prompt: string; modelId?: string }
  | { ok: false; error: string; status: number };

export function parseChatBody(body: unknown): ParsedChatBody {
  if (body == null || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'Expected JSON body { prompt: string }.' };
  }
  const obj = body as { prompt?: unknown; modelId?: unknown };
  const promptRaw = obj.prompt;
  if (typeof promptRaw !== 'string') {
    return { ok: false, status: 400, error: 'Field "prompt" must be a string.' };
  }
  const validation = validatePrompt(promptRaw);
  if (validation) {
    return { ok: false, status: 400, error: validation };
  }

  let modelId: string | undefined;
  if (obj.modelId !== undefined && obj.modelId !== null) {
    if (typeof obj.modelId !== 'string') {
      return {
        ok: false,
        status: 400,
        error: INFERENCE_MODEL_REQUIRED_ERROR,
      };
    }
    const mid = obj.modelId.trim();
    if (!mid || !isValidModelId(mid)) {
      return {
        ok: false,
        status: 400,
        error: INFERENCE_MODEL_REQUIRED_ERROR,
      };
    }
    modelId = mid;
  }

  return { ok: true, prompt: normalizePrompt(promptRaw), modelId };
}

export function missingGatewayKeyError(): { error: string; status: number } {
  return {
    status: 500,
    error:
      'AI_GATEWAY_API_KEY is not set. Add it to .env.local (local) or Vercel project env (deploy).',
  };
}

export function gatewayConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.AI_GATEWAY_API_KEY?.trim());
}

/** Map AI SDK / network failures to a safe client-facing message. */
export function mapInferenceError(err: unknown): { error: string; status: number } {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('401')) {
    return {
      status: 401,
      error: 'AI Gateway rejected the API key. Check AI_GATEWAY_API_KEY.',
    };
  }
  if (lower.includes('rate') || lower.includes('429')) {
    return { status: 429, error: 'Rate limited by the model provider. Try again shortly.' };
  }
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('invalid'))) {
    return { status: 400, error: `Model error: ${message}` };
  }

  // Do not leak stack traces or secrets
  return {
    status: 502,
    error: message.length > 280 ? `${message.slice(0, 280)}…` : message || 'Inference failed.',
  };
}

/** Map resolveByokForModel failure reason to HTTP response. */
export function mapByokResolveFailure(reason: 'forbidden' | 'unavailable' | 'model_invalid'): {
  error: string;
  status: number;
} {
  switch (reason) {
    case 'model_invalid':
      return { status: 400, error: INFERENCE_MODEL_REQUIRED_ERROR };
    case 'unavailable':
      return { status: 503, error: INFERENCE_UNAVAILABLE_ERROR };
    case 'forbidden':
    default:
      return { status: 403, error: INFERENCE_FORBIDDEN_ERROR };
  }
}
