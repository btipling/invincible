/**
 * Agent SSE event contract (docs/agent-stream.md).
 * Maps AI SDK streamText fullStream parts → redacted host-facing events.
 */

import type { ToolTraceEntry } from './runAgent';
import { flattenToolResultText } from './toolResultText';
import { redactSecrets, truncateSummary } from './redact';

export type AgentStreamEvent =
  | { type: 'tool_start'; name: string; id?: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'done'; text: string; toolTrace?: ToolTraceEntry[] }
  | { type: 'error'; error: string; status?: number };

export const AGENT_STREAM_ACCEPT = 'text/event-stream';
export const AGENT_STREAM_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

/** @deprecated No host live-tool cap — kept for test import stability (Infinity). */
export const LIVE_TOOL_LINES_MAX = Number.POSITIVE_INFINITY;

export function wantsAgentStream(req: Request): boolean {
  const accept = req.headers.get('accept') ?? '';
  return accept
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .some((p) => p === 'text/event-stream' || p.startsWith('text/event-stream;'));
}

export function encodeSseData(event: AgentStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Host canvas tool lines only — never dump full tool payloads (read_file bodies,
 * exec stdout, http bodies). Model still receives full results via the tool path.
 */
export const TOOL_LINE_SALIENT_MAX = 160;

/**
 * Extract short, tool-aware highlights for the harness System line.
 * Full `resultText` is for the model; this is display-only.
 */
export function salientToolBits(name: string, resultText: string): string {
  const text = (resultText ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  // Errors / timeouts: first line only (no body after ERROR).
  if (/^ERROR\b/i.test(text) || /\bTIMED_OUT\b/.test(text.split('\n')[0] ?? '')) {
    return text.split('\n')[0]!.replace(/\s+/g, ' ').trim();
  }

  // read_file path (truncated)?:\n<body>
  const readM = text.match(
    /^read_file\s+(\S+)((?:\s*\(truncated\))?)\s*:\s*\n?([\s\S]*)$/i,
  );
  if (readM || name === 'read_file' || /(^|_)read_file$/i.test(name)) {
    if (readM) {
      const path = readM[1]!;
      const trunc = (readM[2] ?? '').includes('truncated') ? ' truncated' : '';
      const body = readM[3] ?? '';
      const lineCount = body.length === 0 ? 0 : body.split('\n').length;
      return `${path}${trunc} · ${lineCount} lines · ${body.length} B`;
    }
    // Unknown shape — stats only
    const lineCount = text.split('\n').length;
    return `${lineCount} lines · ${text.length} B`;
  }

  // list_dir path: N entries — names…
  const listM = text.match(
    /^list_dir\s+(\S+):\s+(\d+)\s+entries(?:\s+[—\-]\s+([\s\S]*))?$/i,
  );
  if (listM || name === 'list_dir') {
    if (listM) {
      const path = listM[1]!;
      const n = listM[2]!;
      const names = (listM[3] ?? '').replace(/\s+/g, ' ').trim();
      if (names && names.length <= 72) return `${path}: ${n} entries — ${names}`;
      return `${path}: ${n} entries`;
    }
  }

  // write_file path: ok bytes=N
  const writeM = text.match(/^write_file\s+(\S+):\s+ok\s+bytes=(\d+)/i);
  if (writeM || name === 'write_file') {
    if (writeM) return `${writeM[1]} · ${writeM[2]} B written`;
  }

  // str_replace path: ok replacements=N bytes=M
  const repM = text.match(
    /^str_replace\s+(\S+):\s+ok\s+replacements=(\d+)\s+bytes=(\d+)/i,
  );
  if (repM || name === 'str_replace') {
    if (repM) {
      const n = repM[2]!;
      const unit = n === '1' ? 'replacement' : 'replacements';
      return `${repM[1]} · ${n} ${unit} · ${repM[3]} B`;
    }
  }

  // exec cmd\nexit=N|TIMED_OUT\nstdout:\n…\nstderr:\n…
  if (/^exec\s+/i.test(text) || name === 'exec') {
    const head = (text.split('\n')[0] ?? 'exec').replace(/\s+/g, ' ').trim();
    const timedOut = /\bTIMED_OUT\b/.test(text);
    const exit = text.match(/\bexit=(-?\d+)/);
    const stdoutPart = text.includes('stdout:\n')
      ? text.split('stdout:\n')[1]?.split(/stderr:\n/)[0] ?? ''
      : '';
    const stderrPart = text.includes('stderr:\n')
      ? text.split('stderr:\n')[1] ?? ''
      : '';
    const outL = stdoutPart.trim() ? stdoutPart.replace(/\n$/, '').split('\n').length : 0;
    const errL = stderrPart.trim() ? stderrPart.replace(/\n$/, '').split('\n').length : 0;
    const bits: string[] = [head];
    if (timedOut) bits.push('TIMED_OUT');
    else if (exit) bits.push(`exit=${exit[1]}`);
    if (outL) bits.push(`stdout ${outL}L`);
    if (errL) bits.push(`stderr ${errL}L`);
    if (errL && exit && exit[1] !== '0') {
      const errFirst = stderrPart.trim().split('\n')[0]?.slice(0, 48);
      if (errFirst) bits.push(errFirst);
    }
    return bits.join(' · ');
  }

  // http_get URL → status flags\nbody
  const httpGet = text.match(
    /^http_get\s+(\S+)\s+→\s+(\d+)([^\n]*)\n?([\s\S]*)$/i,
  );
  if (httpGet || name === 'http_get') {
    if (httpGet) {
      let url = httpGet[1]!;
      if (url.length > 56) url = `${url.slice(0, 53)}…`;
      const status = httpGet[2]!;
      const flag = (httpGet[3] ?? '').trim();
      const body = httpGet[4] ?? '';
      return `${url} → ${status}${flag ? ` ${flag}` : ''} · ${body.length} B`;
    }
  }

  // http_head already one-line metadata
  if (/^http_head\b/i.test(text) || name === 'http_head') {
    return text.replace(/\s+/g, ' ').trim();
  }

  // Generic / MCP: no multi-line dumps — count + short first-line clip
  const lines = text.split('\n');
  if (lines.length > 1 || text.length > 100) {
    const first = lines[0]!.replace(/\s+/g, ' ').trim().slice(0, 72);
    const ellip = lines[0]!.replace(/\s+/g, ' ').trim().length > 72 ? '…' : '';
    return `${lines.length} lines · ${text.length} B · ${first}${ellip}`;
  }

  return text.replace(/\s+/g, ' ').trim();
}

export function summarizeToolLine(
  name: string,
  resultText: string,
  ok: boolean,
  secrets: Array<string | undefined | null> = [],
): string {
  // System kind only — do not use Error/EMBER for routine tool failures.
  const status = ok ? '✓ ok' : '✗ failed';
  const redacted = redactSecrets(resultText ?? '', secrets);
  const bits = salientToolBits(name, redacted);
  if (!bits) {
    return truncateSummary(`${name} · ${status}`, TOOL_LINE_SALIENT_MAX);
  }
  return truncateSummary(`${name} · ${status} · ${bits}`, TOOL_LINE_SALIENT_MAX);
}

function toolNameOf(part: { toolName?: unknown }): string {
  return typeof part.toolName === 'string' && part.toolName ? part.toolName : 'tool';
}

function toolIdOf(part: { toolCallId?: unknown }): string | undefined {
  return typeof part.toolCallId === 'string' && part.toolCallId
    ? part.toolCallId
    : undefined;
}

/**
 * Map one AI SDK fullStream part to zero or more agent events.
 * Reasoning: reasoning-delta / reasoning text parts → reasoning_delta.
 * reasoning-start / reasoning-end / reasoning-file are ignored (v1).
 */
export function mapFullStreamPart(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  part: any,
  secrets: Array<string | undefined | null> = [],
): AgentStreamEvent[] {
  if (!part || typeof part !== 'object') return [];
  const type = part.type;

  // Prefer tool-call (complete). tool-input-start is noisier and often duplicates.
  if (type === 'tool-call') {
    const name = toolNameOf(part);
    const id = toolIdOf(part);
    const ev: AgentStreamEvent = { type: 'tool_start', name: redactSecrets(name, secrets) };
    if (id) ev.id = id;
    return [ev];
  }

  if (type === 'tool-result') {
    const name = toolNameOf(part);
    const raw =
      part.output != null
        ? part.output
        : 'result' in part
          ? part.result
          : undefined;
    const asText = flattenToolResultText(raw);
    const redacted = redactSecrets(asText, secrets);
    const ok = !/^\s*ERROR\b/i.test(redacted) && !/\bTIMED_OUT\b/.test(redacted);
    return [
      {
        type: 'tool_result',
        name: redactSecrets(name, secrets),
        ok,
        summary: summarizeToolLine(name, redacted || '', ok, secrets),
      },
    ];
  }

  if (type === 'tool-error') {
    const name = toolNameOf(part);
    const raw =
      part.error != null
        ? part.error
        : part.output != null
          ? part.output
          : 'tool error';
    const asText = flattenToolResultText(raw);
    const redacted = redactSecrets(asText || 'ERROR tool-error', secrets);
    return [
      {
        type: 'tool_result',
        name: redactSecrets(name, secrets),
        ok: false,
        summary: summarizeToolLine(name, redacted, false, secrets),
      },
    ];
  }

  if (type === 'reasoning-delta' || type === 'reasoning') {
    const text =
      typeof part.text === 'string'
        ? part.text
        : typeof part.delta === 'string'
          ? part.delta
          : '';
    if (!text) return [];
    return [{ type: 'reasoning_delta', text: redactSecrets(text, secrets) }];
  }

  if (type === 'text-delta') {
    const text =
      typeof part.text === 'string'
        ? part.text
        : typeof part.delta === 'string'
          ? part.delta
          : '';
    if (!text) return [];
    return [{ type: 'text_delta', text: redactSecrets(text, secrets) }];
  }

  if (type === 'error') {
    const err = part.error;
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Stream error.';
    return [{ type: 'error', error: redactSecrets(msg, secrets) }];
  }

  return [];
}

/**
 * Consume fullStream + final text/steps into a complete event list (tests / collect).
 */
export async function collectAgentStreamEvents(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fullStream: AsyncIterable<any>;
  getFinalText: () => PromiseLike<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSteps?: () => PromiseLike<any[] | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  collectToolTrace: (result: { steps?: any[] }, secrets: Array<string | undefined | null>) => ToolTraceEntry[];
  secrets?: Array<string | undefined | null>;
}): Promise<AgentStreamEvent[]> {
  const secrets = opts.secrets ?? [];
  const events: AgentStreamEvent[] = [];
  try {
    for await (const part of opts.fullStream) {
      events.push(...mapFullStreamPart(part, secrets));
    }
    let text = redactSecrets(((await opts.getFinalText()) ?? '').trim(), secrets);
    const steps = opts.getSteps ? await opts.getSteps() : undefined;
    const toolTrace = opts.collectToolTrace({ steps }, secrets);
    events.push({
      type: 'done',
      text,
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'ResponseAborted')) {
      events.push({ type: 'error', error: 'Request cancelled.', status: 499 });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      events.push({ type: 'error', error: redactSecrets(msg, secrets) });
    }
  }
  return events;
}
