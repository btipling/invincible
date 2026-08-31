/**
 * Plan #811 (D17) — host client for POST /api/turns (durable-turn transport).
 * Plan #813 (E19) — GET attach client `attachTurnStream`.
 * Replaces the legacy `/api/agent` transport for production `runPrompt`.
 * `/api/agent` stays reachable via the legacy `sendAgent`/`sendAgentStream`
 * exports — tests inject those via `RunHarnessTurnOptions`.
 *
 * Browser-safe — no sandbox tokens. SSE event format is identical to
 * `/api/agent` (same `AGENT_STREAM_CONTENT_TYPE`, same `AgentStreamEvent`).
 */
import { normalizePrompt } from './chatApi';
import {
  AGENT_STREAM_ACCEPT,
  type AgentStreamEvent,
} from './agent/agentStream';
import {
  parseJsonAgentBody,
  parseToolTrace,
  type AgentFailure,
  type AgentResult,
  type SendAgentFn,
  type SendAgentStreamFn,
} from './agentApi';
import { sanitizeUsageSummary, type UsageSummary } from './agent/usageSummary';
import { readAgentStream, type AgentStreamResult } from './agentSse';
import {
  isRedisSafeOpaqueId,
  sanitizeReasoningEffort,
  sanitizeTurnRunId,
  sanitizeTurnStreamCursor,
} from './sessionCloudCaps';

/**
 * Parse the `x-workflow-run-id` response header.
 * Returns the header value (trimmed) or undefined when absent/empty.
 */
function parseTurnRunId(res: Response): string | undefined {
  const raw = res.headers.get('x-workflow-run-id');
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

/**
 * Parse the `x-workflow-run-warning` response header (non-fatal PATCH warning).
 * Returns the header value (trimmed) or undefined when absent/empty.
 */
function parseTurnWarning(res: Response): string | undefined {
  const raw = res.headers.get('x-workflow-run-warning');
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function turnRequestBody(
  prompt: string,
  init?: {
    modelId?: string;
    reasoning?: string;
    cwd?: string;
    sandboxId?: string;
    sessionId?: string;
    personaId?: string;
  },
): {
  prompt: string;
  modelId?: string;
  reasoning?: string;
  cwd?: string;
  sandboxId?: string;
  sessionId?: string;
  personaId?: string;
} {
  const body: {
    prompt: string;
    modelId?: string;
    reasoning?: string;
    cwd?: string;
    sandboxId?: string;
    sessionId?: string;
    personaId?: string;
  } = { prompt: normalizePrompt(prompt) };
  const mid = init?.modelId?.trim();
  if (mid) body.modelId = mid;
  const reasoning = sanitizeReasoningEffort(init?.reasoning);
  if (reasoning) body.reasoning = reasoning;
  const cwd = init?.cwd?.trim();
  if (cwd) body.cwd = cwd;
  const sandboxId = init?.sandboxId?.trim();
  if (sandboxId) body.sandboxId = sandboxId;
  const sessionId = init?.sessionId?.trim();
  if (sessionId) body.sessionId = sessionId;
  const personaId = init?.personaId?.trim();
  if (personaId) body.personaId = personaId;
  return body;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/**
 * AbortError failure. Pre-headers omit `turnRunId` (nothing to fold). After
 * headers, carry the already-parsed id so Stop can clear this-turn `running`
 * while detach still keeps it (adversarial #844).
 */
function cancelledFailure(extra?: {
  turnRunId?: string;
  turnWarning?: string;
}): AgentFailure {
  return {
    ok: false,
    error: 'Request cancelled.',
    ...(extra?.turnRunId !== undefined ? { turnRunId: extra.turnRunId } : {}),
    ...(extra?.turnWarning !== undefined ? { turnWarning: extra.turnWarning } : {}),
  };
}

/**
 * POST /api/turns (JSON path). Used when `streamAgent` is false (tests that
 * inject only `sendAgentFn`). Production always streams.
 */
export const sendTurn: SendAgentFn = async (prompt, init) => {
  const path = init?.path ?? '/api/turns';
  const body = turnRequestBody(prompt, init);

  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: init?.signal,
    });
  } catch (err) {
    if (isAbortError(err)) return cancelledFailure();
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network request failed.',
    };
  }

  const turnRunId = parseTurnRunId(res);
  const turnWarning = parseTurnWarning(res);

  let data: unknown = null;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch (err) {
      if (isAbortError(err)) return cancelledFailure({ turnRunId, turnWarning });
      data = null;
    }
  } else {
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      if (isAbortError(err)) return cancelledFailure({ turnRunId, turnWarning });
      text = '';
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: text.trim() || `Request failed (${res.status}).`,
        ...(turnRunId !== undefined ? { turnRunId } : {}),
        ...(turnWarning !== undefined ? { turnWarning } : {}),
      };
    }
    return {
      ok: true,
      text,
      ...(turnRunId !== undefined ? { turnRunId } : {}),
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  const result = parseJsonAgentBody(res, data);

  // Blend turnRunId/turnWarning into the result (parseJsonAgentBody is shared
  // with /api/agent and doesn't know about these headers).
  if (turnRunId !== undefined) {
    (result as { turnRunId?: string }).turnRunId = turnRunId;
  }
  if (turnWarning !== undefined) {
    (result as { turnWarning?: string }).turnWarning = turnWarning;
  }

  return result;
};

/**
 * POST /api/turns (SSE stream path). Production always uses this path.
 * Reuses `readAgentStream` — the SSE event format is identical to `/api/agent`.
 */
export const sendTurnStream: SendAgentStreamFn = async (prompt, init) => {
  const path = init?.path ?? '/api/turns';
  const body = turnRequestBody(prompt, init);

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
    if (isAbortError(err)) return cancelledFailure();
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network request failed.',
    };
  }

  const turnRunId = parseTurnRunId(res);
  const turnWarning = parseTurnWarning(res);
  const contentType = res.headers.get('content-type') ?? '';

  // Pre-stream JSON errors (or JSON success if server ignored Accept).
  if (
    contentType.includes('application/json') ||
    !contentType.includes('text/event-stream')
  ) {
    if (contentType.includes('application/json')) {
      let data: unknown = null;
      try {
        data = await res.json();
      } catch (err) {
        if (isAbortError(err)) return cancelledFailure({ turnRunId, turnWarning });
        data = null;
      }
      const result = parseJsonAgentBody(res, data);
      if (turnRunId !== undefined) {
        (result as { turnRunId?: string }).turnRunId = turnRunId;
      }
      if (turnWarning !== undefined) {
        (result as { turnWarning?: string }).turnWarning = turnWarning;
      }
      return result;
    }
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      if (isAbortError(err)) return cancelledFailure({ turnRunId, turnWarning });
      text = '';
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: text.trim() || `Request failed (${res.status}).`,
        ...(turnRunId !== undefined ? { turnRunId } : {}),
        ...(turnWarning !== undefined ? { turnWarning } : {}),
      };
    }
    return {
      ok: true,
      text: text.trim(),
      ...(turnRunId !== undefined ? { turnRunId } : {}),
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: `Request failed (${res.status}).`,
      ...(turnRunId !== undefined ? { turnRunId } : {}),
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  if (!res.body) {
    return {
      ok: false,
      status: res.status,
      error: 'Empty stream body.',
      ...(turnRunId !== undefined ? { turnRunId } : {}),
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  if (turnRunId !== undefined) {
    try {
      await init?.onTurnStarted?.({ turnRunId });
    } catch {
      // Fold is best-effort — never fail the stream because the host patch threw.
    }
  }

  const reader = res.body.getReader();

  // Accumulate live usage events mid-stream (dispatched through onEvent).
  let streamUsage: UsageSummary | undefined;

  let streamResult: AgentStreamResult;
  try {
    streamResult = await readAgentStream(reader, async (ev) => {
      if (init?.onEvent) await init.onEvent(ev);
      if (ev.type === 'usage') {
        streamUsage = sanitizeUsageSummary(ev.usage) ?? streamUsage;
      }
    });
  } catch (err) {
    if (isAbortError(err)) return cancelledFailure({ turnRunId, turnWarning });
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Stream read failed.',
      ...(turnRunId !== undefined ? { turnRunId } : {}),
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  if (streamResult.error) {
    return {
      ok: false,
      error: streamResult.error.error,
      ...(streamResult.error.status !== undefined
        ? { status: streamResult.error.status }
        : {}),
      ...(turnRunId !== undefined ? { turnRunId } : {}),
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  const finalText = streamResult.finalText;
  const toolTrace = parseToolTrace(streamResult.toolTraceRaw);

  // done.usage is the conclusive reconcile.
  const doneUsage = sanitizeUsageSummary(streamResult.usageRaw);
  const usage = doneUsage ?? streamUsage;

  if (!finalText.trim()) {
    return {
      ok: false,
      status: res.status,
      error: 'Empty model response.',
      ...(turnRunId !== undefined ? { turnRunId } : {}),
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  return {
    ok: true,
    text: finalText.trim(),
    ...(toolTrace ? { toolTrace } : {}),
    ...(streamResult.cwd !== undefined ? { cwd: streamResult.cwd } : {}),
    ...(streamResult.sandboxId !== undefined
      ? { sandboxId: streamResult.sandboxId }
      : {}),
    ...(streamResult.activeSandboxId !== undefined
      ? { activeSandboxId: streamResult.activeSandboxId }
      : {}),
    ...(usage ? { usage } : {}),
    ...(turnRunId !== undefined ? { turnRunId } : {}),
    ...(turnWarning !== undefined ? { turnWarning } : {}),
  };
};

export type AttachTurnStreamOpts = {
  sessionId: string;
  startIndex?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
  /**
   * Fired when the GET returns a 200 SSE body. The run id is the path param
   * (already known); this marks “we actually opened a readable” so 4xx JSON
   * is not classified as durable-incomplete detach.
   */
  onTurnStarted?: (info: { turnRunId: string }) => void | Promise<void>;
};

/**
 * Plan #813 (E19) — GET `/api/turns/:runId/stream?sessionId=&startIndex=`.
 * Reuses `readAgentStream`. Abort closes **this reader only** (D18: never a
 * server cancel). Empty `done.text` is OK (cold replay may be all-dedup /
 * thinking-only / still-running).
 */
export async function attachTurnStream(
  runId: string,
  opts: AttachTurnStreamOpts,
): Promise<AgentResult> {
  const cleanRunId = sanitizeTurnRunId(runId);
  if (cleanRunId === undefined) {
    return { ok: false, status: 400, error: 'Invalid runId' };
  }
  if (!isRedisSafeOpaqueId(opts.sessionId)) {
    return { ok: false, status: 400, error: 'Invalid sessionId.' };
  }
  const rawIndex = opts.startIndex ?? 0;
  const startIndex = sanitizeTurnStreamCursor(rawIndex);
  if (startIndex === undefined) {
    return { ok: false, status: 400, error: 'Invalid startIndex' };
  }

  const params = new URLSearchParams();
  params.set('sessionId', opts.sessionId);
  params.set('startIndex', String(startIndex));
  const path = `/api/turns/${encodeURIComponent(cleanRunId)}/stream?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(path, {
      method: 'GET',
      headers: { Accept: AGENT_STREAM_ACCEPT },
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbortError(err)) return cancelledFailure();
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network request failed.',
    };
  }

  const headerRunId = parseTurnRunId(res) ?? cleanRunId;
  const turnWarning = parseTurnWarning(res);
  const contentType = res.headers.get('content-type') ?? '';

  if (
    contentType.includes('application/json') ||
    !contentType.includes('text/event-stream')
  ) {
    if (contentType.includes('application/json')) {
      let data: unknown = null;
      try {
        data = await res.json();
      } catch (err) {
        if (isAbortError(err)) return cancelledFailure({ turnRunId: headerRunId, turnWarning });
        data = null;
      }
      const result = parseJsonAgentBody(res, data);
      if (!result.ok) {
        return {
          ...result,
          turnRunId: headerRunId,
          ...(turnWarning !== undefined ? { turnWarning } : {}),
        };
      }
      return {
        ...result,
        turnRunId: headerRunId,
        ...(turnWarning !== undefined ? { turnWarning } : {}),
      };
    }
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      if (isAbortError(err)) return cancelledFailure({ turnRunId: headerRunId, turnWarning });
      text = '';
    }
    return {
      ok: false,
      status: res.status,
      error: text.trim() || `Request failed (${res.status}).`,
      turnRunId: headerRunId,
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: `Request failed (${res.status}).`,
      turnRunId: headerRunId,
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  if (!res.body) {
    return {
      ok: false,
      status: res.status,
      error: 'Empty stream body.',
      turnRunId: headerRunId,
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  try {
    await opts.onTurnStarted?.({ turnRunId: headerRunId });
  } catch {
    // Fold is best-effort.
  }

  const reader = res.body.getReader();
  let streamUsage: UsageSummary | undefined;
  let streamResult: AgentStreamResult;
  try {
    streamResult = await readAgentStream(reader, async (ev) => {
      if (opts.onEvent) await opts.onEvent(ev);
      if (ev.type === 'usage') {
        streamUsage = sanitizeUsageSummary(ev.usage) ?? streamUsage;
      }
    });
  } catch (err) {
    if (isAbortError(err)) {
      return cancelledFailure({ turnRunId: headerRunId, turnWarning });
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Stream read failed.',
      turnRunId: headerRunId,
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  if (streamResult.error) {
    return {
      ok: false,
      error: streamResult.error.error,
      ...(streamResult.error.status !== undefined
        ? { status: streamResult.error.status }
        : {}),
      turnRunId: headerRunId,
      ...(turnWarning !== undefined ? { turnWarning } : {}),
    };
  }

  const finalText = streamResult.finalText;
  const toolTrace = parseToolTrace(streamResult.toolTraceRaw);
  const doneUsage = sanitizeUsageSummary(streamResult.usageRaw);
  const usage = doneUsage ?? streamUsage;

  // Attach may legitimately have empty text (thinking-only, all-dedup, or a
  // still-running producer that EOFs). Do not map that to "Empty model response."
  return {
    ok: true,
    text: (finalText ?? '').trim(),
    ...(toolTrace ? { toolTrace } : {}),
    ...(streamResult.cwd !== undefined ? { cwd: streamResult.cwd } : {}),
    ...(streamResult.sandboxId !== undefined
      ? { sandboxId: streamResult.sandboxId }
      : {}),
    ...(streamResult.activeSandboxId !== undefined
      ? { activeSandboxId: streamResult.activeSandboxId }
      : {}),
    ...(usage ? { usage } : {}),
    turnRunId: headerRunId,
    ...(turnWarning !== undefined ? { turnWarning } : {}),
  };
}
