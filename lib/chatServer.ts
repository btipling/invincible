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
import { SandboxHttpError } from './sandbox/types';
import { SANDBOX_DAEMON_OUT_OF_DATE_CODE } from './sandbox/daemonVersion';

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
export function mapInferenceError(err: unknown): {
  error: string;
  status: number;
  code?: string;
} {
  // Preserve the sandbox out-of-date 426 verbatim so BYO hosts get a real 426
  // (not the inference 502) and a stable code they can key on: the sandbox is
  // configured and running, just older than the backend expects. Never degrade
  // to 503 / SANDBOX_NOT_CONFIGURED (that string means "host chat fallback").
  if (
    err instanceof SandboxHttpError &&
    err.status === 426 &&
    err.code === SANDBOX_DAEMON_OUT_OF_DATE_CODE
  ) {
    return { status: 426, error: err.message, code: SANDBOX_DAEMON_OUT_OF_DATE_CODE };
  }

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('401')) {
    return {
      status: 401,
      error: 'AI Gateway rejected the API key. Check AI_GATEWAY_API_KEY.',
    };
  }
  // Vercel AI Gateway: request-scoped BYOK requires paid team credits (not free tier).
  if (
    lower.includes('bring your own key') ||
    (lower.includes('byok') && lower.includes('paid')) ||
    lower.includes('paid credits')
  ) {
    return {
      status: 402,
      error:
        'Vercel AI Gateway BYOK requires paid AI credits on the team (provider keys alone are not enough). Top up AI Gateway credits in the Vercel dashboard, then retry.',
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
