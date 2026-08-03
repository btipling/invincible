/**
 * Phase 3.8/3.9 — minimal session persistence (no local filesystem).
 *
 * Product constraint: no Node `fs` in the client; no secrets in blobs.
 * Cloud backends (KV / object storage / GH) plug in behind SessionStore later.
 *
 * Design note: docs/session-model.md
 */

export type SessionRole = 'user' | 'assistant' | 'system' | 'error';

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
};

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
      return data;
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
 */
export function formatPromptWithHistory(
  history: SessionMessage[],
  newUserPrompt: string,
  opts?: { maxTurns?: number; maxChars?: number },
): string {
  const maxTurns = opts?.maxTurns ?? 8;
  const maxChars = opts?.maxChars ?? 12_000;
  const dialogue = history.filter((m) => m.role === 'user' || m.role === 'assistant');
  const recent = dialogue.slice(-maxTurns);

  if (recent.length === 0) return newUserPrompt;

  const lines: string[] = ['Previous conversation:'];
  for (const m of recent) {
    const label = m.role === 'user' ? 'User' : 'Assistant';
    lines.push(`${label}: ${m.text}`);
  }
  lines.push('', `User: ${newUserPrompt}`, '', 'Assistant:');
  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = out.slice(out.length - maxChars);
  }
  return out;
}
