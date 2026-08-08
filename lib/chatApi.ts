/**
 * Phase 1 chat client — POST prompt, receive full text.
 * Streaming lands when the Gateway route supports it (1.4+).
 */

export type ChatRequest = {
  prompt: string;
  modelId?: string;
};

export type ChatSuccess = {
  ok: true;
  text: string;
};

export type ChatFailure = {
  ok: false;
  error: string;
  status?: number;
};

export type ChatResult = ChatSuccess | ChatFailure;

/** Default model label shown in the UI (actual routing is server-side in 1.4). */
export const DEFAULT_MODEL_LABEL = 'xai/grok-4.1-fast-non-reasoning';

export function normalizePrompt(raw: string): string {
  return raw.trim();
}

/**
 * Absolute wire/body guard only — NOT model context.
 * Request body includes folded history ("please continue" + prior Tool/User/Assistant).
 * Grok-class models are token-limited by the gateway; do not invent small char budgets here.
 * ~4e6 chars ≈ under typical ~4.5 MB serverless body limits.
 */
export const PROMPT_BODY_MAX_CHARS = 4_000_000;

export function validatePrompt(raw: string): string | null {
  const prompt = normalizePrompt(raw);
  if (!prompt) return 'Enter a prompt.';
  if (prompt.length > PROMPT_BODY_MAX_CHARS) {
    return `Prompt body is too large (max ${PROMPT_BODY_MAX_CHARS.toLocaleString()} characters including history).`;
  }
  return null;
}

/**
 * Call the Phase 1 chat endpoint.
 * Expects JSON body `{ prompt, modelId? }` and response `{ text }` or `{ error }`.
 */
export async function sendChat(
  prompt: string,
  init?: { signal?: AbortSignal; path?: string; modelId?: string },
): Promise<ChatResult> {
  const path = init?.path ?? '/api/chat';
  const body: ChatRequest = { prompt: normalizePrompt(prompt) };
  const mid = init?.modelId?.trim();
  if (mid) body.modelId = mid;

  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: init?.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: 'Request cancelled.' };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network request failed.',
    };
  }

  let data: unknown = null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error:
          res.status === 404
            ? 'Chat API not available yet (Phase 1.4 wires the Gateway).'
            : text.trim() || `Request failed (${res.status}).`,
      };
    }
    return { ok: true, text };
  }

  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const errorField = record && typeof record.error === 'string' ? record.error : null;
  const textField = record && typeof record.text === 'string' ? record.text : null;

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error:
        errorField ||
        (res.status === 404
          ? 'Chat API not available yet (Phase 1.4 wires the Gateway).'
          : `Request failed (${res.status}).`),
    };
  }

  if (textField == null) {
    return { ok: false, status: res.status, error: errorField || 'Empty model response.' };
  }

  return { ok: true, text: textField };
}
