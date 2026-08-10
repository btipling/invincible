/**
 * Phase 3.8/3.9 — minimal session persistence (no local filesystem).
 *
 * Product constraint: no Node `fs` in the client; no secrets in blobs.
 * Cloud backends (KV / object storage / GH) plug in behind SessionStore later.
 *
 * Design note: docs/session-model.md
 */

export type SessionRole = 'user' | 'assistant' | 'system' | 'error' | 'tool_run';

export type SessionMessage = {
  id: string;
  role: SessionRole;
  text: string;
  at: number;
};

export type SessionSnapshot = {
  id: string;
  messages: SessionMessage[];
  updatedAt: number;
  /**
   * Logical workspace cwd (workspace-root-relative), set by successful agent turns.
   * Omitted = no remembered cwd (host omits request field; server defaults).
   */
  cwd?: string;
};


/**
 * Host-side cwd hygiene for session blobs (localStorage).
 * Keeps only non-empty workspace-relative strings; drops host-absolute,
 * drive/UNC, control characters, and non-strings. Server still re-validates.
 */
export function sanitizeSessionCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string') return undefined;
  const trimmed = cwd.trim();
  if (!trimmed) return undefined;
  // Host-absolute / UNC / Windows drive — would 400 every agent turn if sticky.
  if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
    return undefined;
  }
  // C0 controls + DEL (break annotations / SSE if ever reflected).
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

export interface SessionStore {
  readonly kind: 'memory' | 'localStorage' | string;
  load(): SessionSnapshot | null;
  save(snapshot: SessionSnapshot): void;
  clear(): void;
}

const STORAGE_KEY = 'invincible.harness.session.v1';

export function createEmptySession(id?: string): SessionSnapshot {
  const now = Date.now();
  return {
    id: id ?? `sess_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    messages: [],
    updatedAt: now,
  };
}

export function makeMessage(role: SessionRole, text: string): SessionMessage {
  return {
    id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    role,
    text,
    at: Date.now(),
  };
}

export function appendMessage(
  session: SessionSnapshot,
  role: SessionRole,
  text: string,
): SessionSnapshot {
  return {
    ...session,
    messages: [...session.messages, makeMessage(role, text)],
    updatedAt: Date.now(),
  };
}

/** In-memory only — lost on refresh. */
export class MemorySessionStore implements SessionStore {
  readonly kind = 'memory' as const;
  private snap: SessionSnapshot | null = null;

  load(): SessionSnapshot | null {
    return this.snap ? structuredClone(this.snap) : null;
  }

  save(snapshot: SessionSnapshot): void {
    this.snap = structuredClone(snapshot);
  }

  clear(): void {
    this.snap = null;
  }
}

/** Browser localStorage (UX convenience, not multi-device cloud). */
export class LocalStorageSessionStore implements SessionStore {
  readonly kind = 'localStorage' as const;

  constructor(private readonly key = STORAGE_KEY) {}

  load(): SessionSnapshot | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return null;
      const data = JSON.parse(raw) as SessionSnapshot;
      if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) return null;
      // Tolerant: only keep safe workspace-relative cwd strings (parent #270 / phase 2).
      const { cwd: _rawCwd, ...rest } = data as SessionSnapshot & { cwd?: unknown };
      const cwd = sanitizeSessionCwd(_rawCwd);
      return cwd !== undefined ? { ...rest, cwd } : (rest as SessionSnapshot);
    } catch {
      return null;
    }
  }

  save(snapshot: SessionSnapshot): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.key, JSON.stringify(snapshot));
    } catch {
      // quota / private mode — ignore
    }
  }

  clear(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(this.key);
    } catch {
      // ignore
    }
  }
}

/**
 * Prefer localStorage in the browser; fall back to memory (SSR / tests / no storage).
 */
export function createDefaultSessionStore(): SessionStore {
  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      const probe = '__inv_sess_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return new LocalStorageSessionStore();
    } catch {
      /* fall through */
    }
  }
  return new MemorySessionStore();
}

/**
 * Build a single prompt that includes recent turns for multi-turn continuity.
 * API remains Phase 1 single-shot { prompt }; history is folded into the text.
 *
 * Legacy `system` tool lines are folded as `Tool: …`. Aggregated `tool_run`
 * messages are **not** folded (display-only, plan #345), so the agent path no
 * longer re-sends tool summaries on continue — continuation context rides the
 * persisted assistant prose (see docs/harness-limits.md for the re-run caveat).
 * Prefer tail of history when over maxChars.
 */
export function formatPromptWithHistory(
  history: SessionMessage[],
  newUserPrompt: string,
  opts?: {
    /** @deprecated use maxMessages — kept for call sites */
    maxTurns?: number;
    maxMessages?: number;
    maxChars?: number;
  },
): string {
  // Generous defaults: multi-tool turns are long; 8/12k was a continuity killer.
  const maxMessages =
    opts?.maxMessages ??
    (opts?.maxTurns != null ? Math.max(opts.maxTurns * 4, opts.maxTurns) : 400);
  // Host fold budget — leave model/token limits to the gateway, not a toy 12k/32k char wall.
  const maxChars = opts?.maxChars ?? 3_500_000;

  // user + assistant + system (turn-end / legacy tool lines) + error (stall/cancel context).
  // `tool_run` is display-only (plan #345) and is intentionally NOT folded into
  // the model prompt: the aggregated payload is dense and the agent already saw
  // its own tool results this turn. Thinking is never stored in SessionStore.
  const dialogue = history.filter(
    (m) =>
      m.role === 'user' ||
      m.role === 'assistant' ||
      m.role === 'system' ||
      m.role === 'error',
  );
  const recent = dialogue.slice(-Math.max(1, maxMessages));

  if (recent.length === 0) return newUserPrompt;

  const lines: string[] = [
    'Previous conversation (Tool lines already ran this session — reuse results; do not repeat the same tool calls unless the user asks or files may have changed):',
  ];
  for (const m of recent) {
    if (m.role === 'user') lines.push(`User: ${m.text}`);
    else if (m.role === 'assistant') lines.push(`Assistant: ${m.text}`);
    else if (m.role === 'system') {
      // Skip end-of-turn markers (not tools).
      if ((m.text ?? '').startsWith('Turn ended ·')) continue;
      lines.push(`Tool: ${m.text}`);
    } else if (m.role === 'error') {
      if ((m.text ?? '').startsWith('Turn ended ·')) {
        lines.push(`Error: ${m.text}`);
        continue;
      }
      lines.push(`Error: ${m.text}`);
    }
  }
  lines.push('', `User: ${newUserPrompt}`, '', 'Assistant:');
  let out = lines.join('\n');
  if (out.length > maxChars) {
    // Keep the most recent context (tail).
    out = out.slice(out.length - maxChars);
    const nl = out.indexOf('\n');
    if (nl > 0 && nl < 240) out = out.slice(nl + 1);
  }
  return out;
}
