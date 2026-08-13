/**
 * Host client for POST /api/agent.
 * Browser-safe — no sandbox tokens. A failed agent turn hard-fails; the host no
 * longer special-cases a sandbox 503 to fall back to /api/chat (#476/phase 3).
 * Stream path: Accept text/event-stream (docs/agent-stream.md).
 */
import { normalizePrompt } from './chatApi';
import {
  AGENT_STREAM_ACCEPT,
  type AgentStreamEvent,
} from './agent/agentStream';

export type ToolTraceEntry = {
  name: string;
  ok: boolean;
  summary: string;
  /** Confirmed `change_dir` cwd (typed field from the server; no summary parsing). */
  cwd?: string;
};

export type AgentSuccess = {
  ok: true;
  text: string;
  toolTrace?: ToolTraceEntry[];
  /** Final logical cwd when the server included it (FS tools active). */
  cwd?: string;
};

export type AgentFailure = {
  ok: false;
  error: string;
  status?: number;
};

export type AgentResult = AgentSuccess | AgentFailure;

export type SendAgentFn = (
  prompt: string,
  init?: { signal?: AbortSignal; path?: string; modelId?: string; cwd?: string },
) => Promise<AgentResult>;

export type SendAgentStreamHandlers = {
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
};

export type SendAgentStreamFn = (
  prompt: string,
  init?: {
    signal?: AbortSignal;
    path?: string;
    modelId?: string;
    /** Session logical cwd (workspace-relative); omit when unset. */
    cwd?: string;
    onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
  },
) => Promise<AgentResult>;

/** Wire parse: accept all toolTrace entries (no host-side product cap). */
function parseToolTrace(raw: unknown): ToolTraceEntry[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ToolTraceEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const summary = typeof rec.summary === 'string' ? rec.summary : '';
    const name = typeof rec.name === 'string' ? rec.name : 'tool';
    const ok = typeof rec.ok === 'boolean' ? rec.ok : false;
    const cwd = typeof rec.cwd === 'string' ? rec.cwd : undefined;
    out.push({ name, ok, summary, ...(cwd !== undefined ? { cwd } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

function failureFromJson(
  res: Response,
  record: Record<string, unknown> | null,
): AgentFailure {
  const errorField = record && typeof record.error === 'string' ? record.error : null;
  const error =
    errorField ||
    (res.status === 404
      ? 'Agent API not available.'
      : `Request failed (${res.status}).`);
  return {
    ok: false,
    status: res.status,
    error,
  };
}

function parseJsonAgentBody(res: Response, data: unknown): AgentResult {
  const record =
    data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const errorField = record && typeof record.error === 'string' ? record.error : null;
  const textField = record && typeof record.text === 'string' ? record.text : null;

  if (!res.ok) {
    return failureFromJson(res, record);
  }

  if (textField == null) {
    return { ok: false, status: res.status, error: errorField || 'Empty model response.' };
  }

  const toolTrace = parseToolTrace(record?.toolTrace);
  const cwdField =
    record && typeof record.cwd === 'string' ? record.cwd : undefined;
  return {
    ok: true,
    text: textField,
    ...(toolTrace ? { toolTrace } : {}),
    ...(cwdField !== undefined ? { cwd: cwdField } : {}),
  };
}

/**
 * Call the multi-step agent endpoint (JSON body).
 * Expects JSON `{ prompt, modelId? }` and `{ text, toolTrace? }` or `{ error }`.
 */
function agentRequestBody(
  prompt: string,
  init?: { modelId?: string; cwd?: string },
): { prompt: string; modelId?: string; cwd?: string } {
  const body: { prompt: string; modelId?: string; cwd?: string } = {
    prompt: normalizePrompt(prompt),
  };
  const mid = init?.modelId?.trim();
  if (mid) body.modelId = mid;
  const cwd = init?.cwd?.trim();
  if (cwd) body.cwd = cwd;
  return body;
}

export const sendAgent: SendAgentFn = async (prompt, init) => {
  const path = init?.path ?? '/api/agent';
  const body = agentRequestBody(prompt, init);

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

  return parseJsonAgentBody(res, data);
};

function parseSseChunk(
  buffer: string,
): { events: AgentStreamEvent[]; rest: string } {
  const events: AgentStreamEvent[] = [];
  // Normalize CRLF so proxies that emit \r\n still frame correctly.
  let rest = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // SSE events separated by blank line
  for (;;) {
    const idx = rest.indexOf('\n\n');
    if (idx < 0) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n').trimEnd();
    if (!raw || raw === '[DONE]') continue;
    try {
      const parsed = JSON.parse(raw) as AgentStreamEvent;
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        events.push(parsed);
      }
    } catch {
      // ignore malformed chunks
    }
  }
  return { events, rest };
}

/**
 * Stream agent endpoint (Accept: text/event-stream).
 * Early JSON errors (503 sandbox, 401, …) are handled like sendAgent.
 */
export const sendAgentStream: SendAgentStreamFn = async (prompt, init) => {
  const path = init?.path ?? '/api/agent';
  const body = agentRequestBody(prompt, init);

  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: AGENT_STREAM_ACCEPT,
      },
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

  const contentType = res.headers.get('content-type') ?? '';

  // Pre-stream JSON errors (or JSON success if server ignored Accept).
  if (contentType.includes('application/json') || !contentType.includes('text/event-stream')) {
    if (contentType.includes('application/json')) {
      let data: unknown = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      return parseJsonAgentBody(res, data);
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: text.trim() || `Request failed (${res.status}).`,
      };
    }
    // Non-SSE success without JSON — treat as plain text (unlikely).
    return { ok: true, text: text.trim() };
  }

  if (!res.ok) {
    // SSE error status without JSON body
    return {
      ok: false,
      status: res.status,
      error: `Request failed (${res.status}).`,
    };
  }

  if (!res.body) {
    return { ok: false, status: res.status, error: 'Empty stream body.' };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finalText = '';
  let toolTrace: ToolTraceEntry[] | undefined;
  let streamCwd: string | undefined;
  let streamError: AgentFailure | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buf);
      buf = rest;
      for (const ev of events) {
        if (init?.onEvent) {
          await init.onEvent(ev);
        }
        if (ev.type === 'done') {
          // Prefer non-empty done.text; do not wipe delta accumulation with "".
          if (typeof ev.text === 'string' && ev.text.trim()) {
            finalText = ev.text;
          } else if (!finalText.trim() && typeof ev.text === 'string') {
            finalText = ev.text;
          }
          toolTrace = parseToolTrace(ev.toolTrace) ?? toolTrace;
          if (typeof ev.cwd === 'string') {
            streamCwd = ev.cwd;
          }
        } else if (ev.type === 'error') {
          streamError = {
            ok: false,
            error: ev.error || 'Stream error.',
            ...(typeof ev.status === 'number' ? { status: ev.status } : {}),
          };
        } else if (ev.type === 'text_delta' && typeof ev.text === 'string') {
          // Host may grow assistant; keep a fallback accumulation.
          finalText += ev.text;
        }
      }
      if (streamError) break;
    }
    // Flush trailing buffer
    if (buf.trim()) {
      const { events } = parseSseChunk(buf + '\n\n');
      for (const ev of events) {
        if (init?.onEvent) await init.onEvent(ev);
        if (ev.type === 'done') {
          if (typeof ev.text === 'string' && ev.text.trim()) {
            finalText = ev.text;
          } else if (!finalText.trim() && typeof ev.text === 'string') {
            finalText = ev.text;
          }
          toolTrace = parseToolTrace(ev.toolTrace) ?? toolTrace;
          if (typeof ev.cwd === 'string') {
            streamCwd = ev.cwd;
          }
        } else if (ev.type === 'error') {
          streamError = {
            ok: false,
            error: ev.error || 'Stream error.',
            ...(typeof ev.status === 'number' ? { status: ev.status } : {}),
          };
        }
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: 'Request cancelled.' };
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: 'Request cancelled.' };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Stream read failed.',
    };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  if (streamError) return streamError;
  if (!finalText.trim()) {
    return { ok: false, status: res.status, error: 'Empty model response.' };
  }
  return {
    ok: true,
    text: finalText.trim(),
    ...(toolTrace ? { toolTrace } : {}),
    ...(streamCwd !== undefined ? { cwd: streamCwd } : {}),
  };
};
