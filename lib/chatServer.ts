/**
 * Pure helpers for the Phase 1 chat API route.
 * Inference call stays in the route (generateText + gateway).
 */

import { normalizePrompt, validatePrompt } from './chatApi';

export type ParsedChatBody =
  | { ok: true; prompt: string }
  | { ok: false; error: string; status: number };

export function parseChatBody(body: unknown): ParsedChatBody {
  if (body == null || typeof body !== 'object') {
    return { ok: false, status: 400, error: 'Expected JSON body { prompt: string }.' };
  }
  const promptRaw = (body as { prompt?: unknown }).prompt;
  if (typeof promptRaw !== 'string') {
    return { ok: false, status: 400, error: 'Field "prompt" must be a string.' };
  }
  const validation = validatePrompt(promptRaw);
  if (validation) {
    return { ok: false, status: 400, error: validation };
  }
  return { ok: true, prompt: normalizePrompt(promptRaw) };
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
