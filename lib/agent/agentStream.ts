/**
 * Agent SSE event contract (docs/agent-stream.md).
 * Maps AI SDK streamText fullStream parts → redacted host-facing events.
 */

import type { ToolTraceEntry } from './runAgent';
import { flattenToolResultText } from './toolResultText';
import { redactSecrets, truncateSummary } from './redact';
import { TOOL_TRACE_SUMMARY_MAX_CHARS } from '../sandbox/config';

export type AgentStreamEvent =
  | { type: 'tool_start'; name: string; id?: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'done'; text: string; toolTrace?: ToolTraceEntry[] }
  | { type: 'error'; error: string; status?: number };

export const AGENT_STREAM_ACCEPT = 'text/event-stream';
export const AGENT_STREAM_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

/** Live System tool lines per turn before a single overflow notice. */
export const LIVE_TOOL_LINES_MAX = 32;

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

export function summarizeToolLine(
  name: string,
  resultText: string,
  ok: boolean,
  secrets: Array<string | undefined | null> = [],
): string {
  const status = ok ? 'ok' : 'failed';
  const oneLine = redactSecrets(resultText, secrets).replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    return truncateSummary(`${name} · ${status}`, TOOL_TRACE_SUMMARY_MAX_CHARS);
  }
  const preview = oneLine.length > 200 ? oneLine.slice(0, 200) : oneLine;
  return truncateSummary(`${name} · ${status} · ${preview}`, TOOL_TRACE_SUMMARY_MAX_CHARS);
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
