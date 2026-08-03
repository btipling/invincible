/**
 * Host client for POST /api/agent (phase 3 / #48).
 * Browser-safe — no sandbox tokens; matches server 503 contract for chat fallback.
 */
import { normalizePrompt } from './chatApi';
import { SANDBOX_NOT_CONFIGURED_ERROR } from './sandbox/config';

export type ToolTraceEntry = {
  name: string;
  ok: boolean;
  summary: string;
};

export type AgentSuccess = {
  ok: true;
  text: string;
  toolTrace?: ToolTraceEntry[];
};

export type AgentFailure = {
  ok: false;
  error: string;
  status?: number;
  /**
   * True only when status is 503 and error is the exact sandbox-not-configured
   * string. Host must fall back to /api/chat only in this case.
   */
  sandboxNotConfigured?: boolean;
};

export type AgentResult = AgentSuccess | AgentFailure;

export type SendAgentFn = (
  prompt: string,
  init?: { signal?: AbortSignal; path?: string },
) => Promise<AgentResult>;

/** Soft cap on raw toolTrace entries accepted from the wire (host still displays ≤6). */
const TOOL_TRACE_PARSE_MAX = 32;

function parseToolTrace(raw: unknown): ToolTraceEntry[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ToolTraceEntry[] = [];
  for (const item of raw) {
    if (out.length >= TOOL_TRACE_PARSE_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const summary = typeof rec.summary === 'string' ? rec.summary : '';
    const name = typeof rec.name === 'string' ? rec.name : 'tool';
    const ok = typeof rec.ok === 'boolean' ? rec.ok : false;
    out.push({ name, ok, summary });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Call the multi-step agent endpoint.
 * Expects JSON `{ prompt }` and `{ text, toolTrace? }` or `{ error }`.
 */
export const sendAgent: SendAgentFn = async (prompt, init) => {
  const path = init?.path ?? '/api/agent';
  const body = { prompt: normalizePrompt(prompt) };

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
    if (err instanceof Error && err.name === 'AbortError') {
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
        error: text.trim() || `Request failed (${res.status}).`,
      };
    }
    return { ok: true, text };
  }

  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const errorField = record && typeof record.error === 'string' ? record.error : null;
  const textField = record && typeof record.text === 'string' ? record.text : null;

  if (!res.ok) {
    const error =
      errorField ||
      (res.status === 404
        ? 'Agent API not available.'
        : `Request failed (${res.status}).`);
    const sandboxNotConfigured =
      res.status === 503 && error === SANDBOX_NOT_CONFIGURED_ERROR;
    return {
      ok: false,
      status: res.status,
      error,
      ...(sandboxNotConfigured ? { sandboxNotConfigured: true } : {}),
    };
  }

  if (textField == null) {
    return { ok: false, status: res.status, error: errorField || 'Empty model response.' };
  }

  const toolTrace = parseToolTrace(record?.toolTrace);
  return {
    ok: true,
    text: textField,
    ...(toolTrace ? { toolTrace } : {}),
  };
};

export { SANDBOX_NOT_CONFIGURED_ERROR };
