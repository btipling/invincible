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
import { sanitizeUsageSummary, type UsageSummary } from './agent/usageSummary';
import { parseAttachedSkills } from './sessionCloudCaps';

export type ToolTraceEntry = {
  name: string;
  ok: boolean;
  summary: string;
  /** Confirmed `change_dir` cwd (typed field from the server; no summary parsing). */
  cwd?: string;
};

/**
 * Client-safe mirror of a server skill attach/detach outcome (phase 2 #517).
 * Carries ONLY the slug + status — never a skill body. Pushes the display-only
 * `Skill attached: <slug>` / `Skill detached: <slug>` rows on the JSON agent
 * path (the SSE path surfaces the same events via `AgentStreamEvent`).
 */
export type SkillAttachmentEvent = {
  action: 'attach' | 'detach';
  slug: string;
  ok: boolean;
  reason?: string;
};

export type AgentSuccess = {
  ok: true;
  text: string;
  toolTrace?: ToolTraceEntry[];
  /** Final logical cwd when the server included it (FS tools active). */
  cwd?: string;
  /** Resolved active sandbox bind the turn ran against (FS tools bound). */
  sandboxId?: string;
  /**
   * Post-turn EFFECTIVE active sandbox bind (switch target when the turn
   * switched, else `sandboxId`). The host folds THIS into the session.
   */
  activeSandboxId?: string;
  /** Skill attach/detach outcomes this turn (JSON path). */
  skillEvents?: SkillAttachmentEvent[];
  /**
   * Phase 2 (#517 / adversarial-review fix): the session-sticky attached-skill
   * set parsed from the response's top-level `attachedSkills` JSON-array string.
   * The host folds this onto `SessionSnapshot.attachedSlugs` so the next PUT
   * (via `cloudMetaFor`) persists it as the reserved `meta.attachedSkills`.
   */
  attachedSlugs?: string[];
  /**
   * Phase 3 (plan #539 / #327) — bounded provider-usage summary parsed from the
   * JSON result (or the stream `done` event). Absent (hidden) when the provider
   * reported none or the wire value is invalid/non-provider — never a guess.
   */
  usage?: UsageSummary;
};

export type AgentFailure = {
  ok: false;
  error: string;
  status?: number;
  /**
   * Phase 2 (#517 / "fold before persist incl. fail/cancel"): a failed model turn
   * still carries the current sticky set (server sends `attachedSkills` on error
   * bodies) so the host folds it before persisting.
   */
  attachedSlugs?: string[];
};

export type AgentResult = AgentSuccess | AgentFailure;

export type SendAgentFn = (
  prompt: string,
  init?: {
    signal?: AbortSignal;
    path?: string;
    modelId?: string;
    cwd?: string;
    /** Session-owned active sandbox id (Redis-safe) → resolve override. */
    sandboxId?: string;
    /**
     * Session id (Redis-safe). Parent #485 lock: lets the agent route find the
     * session's `meta.personaSnapshot` on later turns / Continue.
     */
    sessionId?: string;
    /**
     * Persona id (Redis-safe) chosen/bound for this session. Folded on the first
     * turn so the route can resolve + snapshot the body once (offline/local path
     * has no session store; the cloud path also binds personaId at mint).
     */
    personaId?: string;
  },
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
    /** Session-owned active sandbox id (Redis-safe) → resolve override. */
    sandboxId?: string;
    /** Session id (Redis-safe) → agent route finds `meta.personaSnapshot`. */
    sessionId?: string;
    /** Persona id (Redis-safe) bound for this session (first-turn resolve). */
    personaId?: string;
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

/** Wire parse for the JSON-path skill attach/detach outcomes (only slug + status). */
function parseSkillEvents(raw: unknown): SkillAttachmentEvent[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: SkillAttachmentEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.slug !== 'string' || !rec.slug) continue;
    const action = rec.action === 'detach' ? 'detach' : 'attach';
    const ok = typeof rec.ok === 'boolean' ? rec.ok : false;
    const ev: SkillAttachmentEvent = { action, slug: rec.slug, ok };
    if (typeof rec.reason === 'string') ev.reason = rec.reason;
    out.push(ev);
  }
  return out.length > 0 ? out : undefined;
}

/** Parse the session-sticky set from a `{ attachedSkills: '["slug",...]' }` body field. */
function attachedSlugsFromRecord(record: Record<string, unknown> | null): string[] | undefined {
  if (!record) return undefined;
  const raw = record.attachedSkills;
  // `attachedSkills` is a JSON-array string; `parseAttachedSkills` also covers
  // the `'[]'` (detach-all) case (a non-empty string → present, NOT omitted).
  if (typeof raw !== 'string') return undefined;
  return parseAttachedSkills(raw);
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
  const attachedSlugs = attachedSlugsFromRecord(record);
  return {
    ok: false,
    status: res.status,
    error,
    ...(attachedSlugs !== undefined ? { attachedSlugs } : {}),
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
  const sandboxField =
    record && typeof record.sandboxId === 'string' ? record.sandboxId : undefined;
  const activeSandboxField =
    record && typeof record.activeSandboxId === 'string'
      ? record.activeSandboxId
      : undefined;
  const skillEvents = parseSkillEvents(record?.skillEvents);
  const attachedSlugs = attachedSlugsFromRecord(record);
  const usage = sanitizeUsageSummary(record?.usage);
  return {
    ok: true,
    text: textField,
    ...(toolTrace ? { toolTrace } : {}),
    ...(cwdField !== undefined ? { cwd: cwdField } : {}),
    ...(sandboxField !== undefined ? { sandboxId: sandboxField } : {}),
    ...(activeSandboxField !== undefined
      ? { activeSandboxId: activeSandboxField }
      : {}),
    ...(skillEvents ? { skillEvents } : {}),
    ...(attachedSlugs !== undefined ? { attachedSlugs } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * Call the multi-step agent endpoint (JSON body).
 * Expects JSON `{ prompt, modelId? }` and `{ text, toolTrace? }` or `{ error }`.
 */
function agentRequestBody(
  prompt: string,
  init?: {
    modelId?: string;
    cwd?: string;
    sandboxId?: string;
    sessionId?: string;
    personaId?: string;
  },
): {
  prompt: string;
  modelId?: string;
  cwd?: string;
  sandboxId?: string;
  sessionId?: string;
  personaId?: string;
} {
  const body: {
    prompt: string;
    modelId?: string;
    cwd?: string;
    sandboxId?: string;
    sessionId?: string;
    personaId?: string;
  } = { prompt: normalizePrompt(prompt) };
  const mid = init?.modelId?.trim();
  if (mid) body.modelId = mid;
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
  let streamSandboxId: string | undefined;
  let streamActiveSandboxId: string | undefined;
  let streamUsage: UsageSummary | undefined;
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
          if (typeof ev.sandboxId === 'string') {
            streamSandboxId = ev.sandboxId;
          }
          if (typeof ev.activeSandboxId === 'string') {
            streamActiveSandboxId = ev.activeSandboxId;
          }
          // Phase 3 (plan #539 + #628) — `done.usage` is the conclusive
          // reconcile that REPLACES any live mid-stream value (absent → clear,
          // the completed-turn rule; never falls back to a prior live value).
          streamUsage = sanitizeUsageSummary(ev.usage);
        } else if (ev.type === 'error') {
          streamError = {
            ok: false,
            error: ev.error || 'Stream error.',
            ...(typeof ev.status === 'number' ? { status: ev.status } : {}),
          };
        } else if (ev.type === 'usage') {
          // Phase 3 (plan #628) — live provider usage mid-stream. Last honest
          // wins; never step back to empty on a finish part that reported none
          // (such parts never emit a `usage` event).
          streamUsage =
            sanitizeUsageSummary(ev.usage) ?? streamUsage;
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
          if (typeof ev.sandboxId === 'string') {
            streamSandboxId = ev.sandboxId;
          }
          if (typeof ev.activeSandboxId === 'string') {
            streamActiveSandboxId = ev.activeSandboxId;
          }
          // Phase 3 (plan #539 + #628) — `done.usage` is the conclusive
          // reconcile that REPLACES any live mid-stream value (absent → clear,
          // the completed-turn rule; never falls back to a prior live value).
          streamUsage = sanitizeUsageSummary(ev.usage);
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
    ...(streamSandboxId !== undefined ? { sandboxId: streamSandboxId } : {}),
    ...(streamActiveSandboxId !== undefined
      ? { activeSandboxId: streamActiveSandboxId }
      : {}),
    ...(streamUsage ? { usage: streamUsage } : {}),
  };
};
