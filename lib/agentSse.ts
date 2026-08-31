/**
 * Shared SSE parse + read helpers for agent stream consumers.
 * Both `sendAgentStream` (legacy /api/agent) and `sendTurnStream` (/api/turns)
 * reuse the same parser — the SSE event format is identical.
 */
import { type AgentStreamEvent } from './agent/agentStream';
import { isProviderRefusalFinish, truncatedFinishError } from './agent/modelFinish';

export function parseSseChunk(
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
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as { type?: unknown }).type === 'string'
      ) {
        events.push(parsed);
      }
    } catch {
      // ignore malformed chunks
    }
  }
  return { events, rest };
}

export interface AgentStreamResult {
  finalText: string;
  /** Raw tool trace from the `done` event — caller parses with its own parser. */
  toolTraceRaw?: unknown;
  cwd?: string;
  sandboxId?: string;
  activeSandboxId?: string;
  /** Raw usage from the `done` event — caller sanitizes. Live usage events are
   *  dispatched via `onEvent` and handled by the caller. */
  usageRaw?: unknown;
  /** Raw resolved-provider slug from the `done` event — caller sanitizes. */
  resolvedProviderRaw?: unknown;
  error?: { ok: false; error: string; status?: number };
}

/**
 * Read a stream body from `reader`, dispatching each parsed SSE event to
 * `onEvent` and accumulating terminal fields from the `done` event.
 */
export async function readAgentStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (ev: AgentStreamEvent) => Promise<void>,
): Promise<AgentStreamResult> {
  const decoder = new TextDecoder();
  let buf = '';
  let finalText = '';
  let toolTraceRaw: unknown;
  let streamCwd: string | undefined;
  let streamSandboxId: string | undefined;
  let streamActiveSandboxId: string | undefined;
  let usageRaw: unknown;
  let resolvedProviderRaw: unknown;
  let streamError: { ok: false; error: string; status?: number } | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buf);
      buf = rest;
      for (const ev of events) {
        await onEvent(ev);
        if (ev.type === 'done') {
          // Prefer non-empty done.text; do not wipe delta accumulation with "".
          if (typeof ev.text === 'string' && ev.text.trim()) {
            finalText = ev.text;
          } else if (!finalText.trim() && typeof ev.text === 'string') {
            finalText = ev.text;
          }
          toolTraceRaw = ev.toolTrace ?? toolTraceRaw;
          if (typeof ev.cwd === 'string') {
            streamCwd = ev.cwd;
          }
          if (typeof ev.sandboxId === 'string') {
            streamSandboxId = ev.sandboxId;
          }
          if (typeof ev.activeSandboxId === 'string') {
            streamActiveSandboxId = ev.activeSandboxId;
          }
          // done.usage is the conclusive reconcile (caller sanitizes).
          usageRaw = ev.usage;
          if (typeof ev.resolvedProvider === 'string') {
            resolvedProviderRaw = ev.resolvedProvider;
          }
          if (isProviderRefusalFinish(ev.finishReason)) {
            streamError = { ok: false, error: truncatedFinishError(ev.finishReason) };
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
        await onEvent(ev);
        if (ev.type === 'done') {
          if (typeof ev.text === 'string' && ev.text.trim()) {
            finalText = ev.text;
          } else if (!finalText.trim() && typeof ev.text === 'string') {
            finalText = ev.text;
          }
          toolTraceRaw = ev.toolTrace ?? toolTraceRaw;
          if (typeof ev.cwd === 'string') {
            streamCwd = ev.cwd;
          }
          if (typeof ev.sandboxId === 'string') {
            streamSandboxId = ev.sandboxId;
          }
          if (typeof ev.activeSandboxId === 'string') {
            streamActiveSandboxId = ev.activeSandboxId;
          }
          usageRaw = ev.usage;
          if (typeof ev.resolvedProvider === 'string') {
            resolvedProviderRaw = ev.resolvedProvider;
          }
          if (isProviderRefusalFinish(ev.finishReason)) {
            streamError = { ok: false, error: truncatedFinishError(ev.finishReason) };
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
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  return {
    finalText,
    ...(toolTraceRaw !== undefined ? { toolTraceRaw } : {}),
    ...(streamCwd !== undefined ? { cwd: streamCwd } : {}),
    ...(streamSandboxId !== undefined ? { sandboxId: streamSandboxId } : {}),
    ...(streamActiveSandboxId !== undefined
      ? { activeSandboxId: streamActiveSandboxId }
      : {}),
    ...(usageRaw !== undefined ? { usageRaw } : {}),
    ...(resolvedProviderRaw !== undefined ? { resolvedProviderRaw } : {}),
    ...(streamError ? { error: streamError } : {}),
  };
}
