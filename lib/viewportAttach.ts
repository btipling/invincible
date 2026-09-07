import { normalizePrompt } from './chatApi';
import {
  AGENT_STREAM_ACCEPT,
  type AgentStreamEvent,
} from './agent/agentStream';
import type { AgentFailure } from './agentApi';
import { sanitizeUsageSummary, type UsageSummary } from './agent/usageSummary';
import {
  isRedisSafeOpaqueId,
  sanitizeResolvedProvider,
  sanitizeTurnRunId,
  sanitizeTurnStreamCursor,
} from './sessionCloudCaps';
import {
  ViewportStreamDecoder,
  type ViewportRecord,
  type ViewportSnapshot,
} from './viewportStreamProtocol';

function parseTurnRunId(res: Response): string | undefined {
  const raw = res.headers.get('x-workflow-run-id');
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export type ViewportNegotiation = 'cold' | 'indexed';

export type ViewportAttachInit = {
  sessionId: string;
  startIndex?: number;
  negotiation?: ViewportNegotiation;
  onTurnStarted?: (info: { turnRunId: string }) => Promise<void> | void;
  onEvent?: (event: ViewportRecord) => Promise<void> | void;
  signal?: AbortSignal;
};

export type ViewportAttachResult =
  | AgentFailure
  | { ok: true; text: string; turnRunId?: string; cursor?: number; snapshot?: ViewportSnapshot; usage?: UsageSummary; resolvedProvider?: string; }
  | { ok: true; text: string; turnRunId?: string; cursor?: number; snapshot?: ViewportSnapshot; usage?: UsageSummary; resolvedProvider?: string; completedAt: 'done' };

/** Read a viewport body and dispatch each decoded record to opts.onEvent. */
export async function readViewportBody(
  body: ReadableStream<Uint8Array>,
  runId: string,
  opts: ViewportAttachInit,
): Promise<{ ok: boolean; error?: string; status?: number; turnRunId?: string; cursor?: number; snapshot?: ViewportSnapshot; text?: string; usage?: UsageSummary; resolvedProvider?: string }> {
  const decoder = new ViewportStreamDecoder(runId);
  let lastError: AgentFailure | undefined;
  let lastTurnEventNextIndex: number | undefined;
  let sawViewportEnd = false;
  let doneEvent: Extract<AgentStreamEvent, { type: 'done' }> | undefined;
  let sawDoneText: string | undefined;
  let streamUsage: UsageSummary | undefined;
  let streamProvider: string | undefined;
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const rec of decoder.push(value)) {
      if (opts.onEvent) {
        await Promise.resolve(opts.onEvent(rec));
      }
      if (rec.type === 'turn_event' && !rec.skipped && rec.event) {
        const ev = rec.event;
        if (ev.type === 'done') {
          if (doneEvent === undefined) doneEvent = ev;
          if (typeof ev.text === 'string') sawDoneText = ev.text;
        } else if (ev.type === 'usage') {
          streamUsage = sanitizeUsageSummary(ev.usage) ?? streamUsage;
        } else if (ev.type === 'provider') {
          streamProvider = sanitizeResolvedProvider(ev.provider) ?? streamProvider;
        }
        lastTurnEventNextIndex = rec.nextIndex;
      } else if (rec.type === 'viewport_end') {
        sawViewportEnd = true;
      } else if (rec.type === 'viewport_error') {
        lastError = { ok: false, error: `[viewport_error ${rec.code}] Viewport attach failed.` };
      }
      if (sawViewportEnd || lastError) break;
    }
  }
  if (!sawViewportEnd && !lastError) {
    for (const rec of decoder.push(new Uint8Array(), true)) {
      if (opts.onEvent) {
        await Promise.resolve(opts.onEvent(rec));
      }
    }
  }
  if (lastError) return lastError;
  if (!sawViewportEnd) {
    return {
      ok: true,
      text: sawDoneText,
      cursor: lastTurnEventNextIndex,
      ...(doneEvent !== undefined ? { doneEvent } : {}),
      ...(streamUsage ? { usage: streamUsage } : {}),
      ...(streamProvider ? { resolvedProvider: streamProvider } : {}),
      ...(decoder.lastSnapshot !== undefined ? { snapshot: decoder.lastSnapshot } : {}),
    };
  }
  if (doneEvent !== undefined && sawDoneText !== undefined) {
    return {
      ok: true,
      text: sawDoneText,
      ...(streamUsage ? { usage: streamUsage } : {}),
      ...(streamProvider ? { resolvedProvider: streamProvider } : {}),
    };
  }
  return { ok: true };
}

/** GET `/api/turns/:runId/stream` with negotiated viewport transport. */
export async function viewportAttachTurnStream(
  runId: string,
  opts: ViewportAttachInit,
): Promise<AgentFailure | ViewportAttachResult> {
  const cleanRunId = sanitizeTurnRunId(runId);
  if (!cleanRunId) return { ok: false, status: 400, error: 'Invalid run id' };
  if (!normalizePrompt(opts.sessionId ?? '') || !isRedisSafeOpaqueId(opts.sessionId)) {
    return { ok: false, status: 400, error: 'Invalid session id' };
  }
  const params = new URLSearchParams();
  params.set('sessionId', opts.sessionId);
  params.set('viewportVersion', '1');
  if (opts.negotiation === 'indexed' || opts.startIndex !== undefined) {
    if (opts.startIndex === undefined) {
      return { ok: false, status: 400, error: 'Indexed attach needs startIndex.' };
    }
    const startIndex = sanitizeTurnStreamCursor(opts.startIndex);
    if (startIndex === undefined) {
      return { ok: false, status: 400, error: 'Invalid startIndex.' };
    }
    params.set('startIndex', String(startIndex));
  } else {
    params.set('hydrate', 'tail');
  }
  const path = `/api/turns/${encodeURIComponent(cleanRunId)}/stream?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'GET',
      headers: { Accept: AGENT_STREAM_ACCEPT },
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbortError(err)) return { ok: false, error: 'Aborted.' };
    return { ok: false, error: err instanceof Error ? err.message : 'Network request failed.' };
  }
  const headerRunId = parseTurnRunId(res) ?? cleanRunId;
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.body || !contentType.includes('text/event-stream') || res.headers.get('x-viewport-version') !== '1') {
    const status = res.status;
    const error = !contentType.includes('text/event-stream')
      ? 'View attach failed.'
      : 'Viewport negotiation not accepted.';
    return { ok: false, status, error: !res.body ? 'Empty viewport stream body.' : error, turnRunId: headerRunId };
  }
  await opts.onTurnStarted?.({ turnRunId: headerRunId });
  const bodyResult = await readViewportBody(res.body!, headerRunId, opts);
  return bodyResult as AgentFailure | ViewportAttachResult;
}