/**
 * Phase 3.8/3.9 — minimal session persistence (no local filesystem).
 *
 * Product constraint: no Node `fs` in the client; no secrets in blobs.
 * Cloud backends (KV / object storage / GH) plug in behind SessionStore later.
 *
 * Design note: docs/session-model.md
 */

export type SessionRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'error'
  | 'tool_run'
  | 'skill_attached';

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
   * P1/GAP-1 (#452): this now rides the cloud session record as `meta.logicalCwd`.
   */
  cwd?: string;
  /**
   * P1/GAP-1 (#452): server/origin sandbox id, carried-but-not-resolved on the session.
   * Omitted or empty = unset (agent resolves from the user's preferred sandbox).
   * Stored on the cloud record as `meta.activeSandboxId`; not yet used for execution.
   */
  activeSandboxId?: string;
  /**
   * Phase 3 (#488): the persona bound to this session (Redis-safe opaque).
   * Chosen at New session (explicit, default from `GET /api/personas`, or None).
   * Folded into the agent body / mint so the server snapshots it on first use.
   * Omitted = no persona (behaviour identical to a persona-less session).
   */
  personaId?: string;
  /**
   * Phase 2 (#517 / adversarial-review fix): the session-sticky attached-skill
   * set (slugs). This is the **host-carrier** so a host PUT can never wipe the
   * set: the server folds the final set back to the host on every
   * `skill_attached` event / JSON `attachedSkills`, the host persists it here,
   * and `cloudMetaFor` writes it back as the reserved `meta.attachedSkills`
   * JSON-array string. `meta.attachedSkills` is the server's read/write surface;
   * this field is the local session's mirror of it.
   *
   * `undefined` (omitted) = never carried / no event seen — the host PUT omits
   * the reserved key so it never clears what it doesn't know (omitted ≠ []).
   * `[]` (empty array) = an explicit detach-all the host MUST persist as `[]`.
   * Slugs are validated with `SKILL_SLUG_RE` on the wire; fail-closed to [] at
   * read (`parseCloudSessionSnapshot`).
   */
  attachedSlugs?: string[];
  /**
   * Phase 3 (plan #539 / #327) — host-side mirror of the last COMPLETED turn's
   * bounded provider-usage summary. `undefined`/absent = the context slot HIDES
   * (the locked default on missing usage). Cleared on a completed turn whose
   * provider reported no usage and on New/Clear; KEPT (carried forward) on an
   * aborted/cancelled turn so the slot never repaints a fake value. Host-local
   * only — not a reserved cloud `meta` key (does not ride the envelope).
   */
  usage?: import('./agent/usageSummary').UsageSummary;
  /**
   * Plan #616 (source #610) — the selected model id (a non-secret catalog
   * string, e.g. `provider/model`), carried as the session-owned carrier on the
   * cloud record as the reserved `meta.selectedModel` (mirrors `personaId`).
   * Omitted = unset (restore falls back to the default first-granted model).
   * Sanitized with `sanitizeModelId` on read (drop-to-unset on poison) so a
   * poisoned value never sticks or bricks the session.
   */
  selectedModel?: string;
};

import {
  MAX_MODEL_ID_LEN,
  SKILL_SLUG_RE,
  isRedisSafeOpaqueId,
  sanitizeModelId,
  sanitizeSessionCwd,
} from './sessionCloudCaps';
import { sanitizeUsageSummary } from './agent/usageSummary';
export { MAX_MODEL_ID_LEN, isRedisSafeOpaqueId, sanitizeSessionCwd } from './sessionCloudCaps';

/**
 * Sanitize a locally-persisted `attachedSlugs` array. LocalStorage is a plain
 * JSON mirror of the snapshot (no server meta wire form), so unlike the cloud
 * parse (which reads the JSON-array-string `meta.attachedSkills`), this must
 * validate an already-array value directly: keep only slugs matching
 * `SKILL_SLUG_RE`, de-duplicate (insertion order preserved), drop poison.
 * Returns `undefined` for a non-array / invalid array so the host never mirrors
 * a poisoned local set (`review #526 re-run 3` local-parse residual).
 */
export function sanitizeAttachedSlugs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const s of value) {
    if (typeof s === 'string' && SKILL_SLUG_RE.test(s) && !out.includes(s)) {
      out.push(s);
    }
  }
  return out;
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
      const data = JSON.parse(raw) as SessionSnapshot & {
        cwd?: unknown;
        activeSandboxId?: unknown;
        personaId?: unknown;
        attachedSlugs?: unknown;
        usage?: unknown;
        selectedModel?: unknown;
      };
      if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) return null;
      // Tolerant: keep only safe workspace-relative cwd strings (parent #270 / phase 2),
      // a Redis-safe `activeSandboxId` (P1/GAP-1, #452), a Redis-safe `personaId`
      // (phase 3 #488), a slug-set-valid `attachedSlugs` (phase 2 #517), a
      // bounded provider-sourced `usage` (phase 3 #539), and a printable-ASCII
      // ≤ `MAX_MODEL_ID_LEN` `selectedModel` (plan #616); a bad local value can't
      // pin. `attachedSlugs` is sanitized so a poisoned local array is dropped
      // rather than spread raw (review #526 re-run 3 residual); a poisoned `usage`
      // (non-provider / over-cap) sanitizes to `undefined` → slot hides; a poisoned
      // `selectedModel` sanitizes to `undefined` → model restore falls back to default.
      const {
        cwd: rawCwd,
        activeSandboxId: rawSandbox,
        personaId: rawPersona,
        attachedSlugs: rawAttachedSlugs,
        usage: rawUsage,
        selectedModel: rawSelectedModel,
        ...rest
      } = data;
      const cwd = sanitizeSessionCwd(rawCwd);
      const activeSandboxId =
        typeof rawSandbox === 'string' && rawSandbox && isRedisSafeOpaqueId(rawSandbox)
          ? rawSandbox
          : undefined;
      const personaId =
        typeof rawPersona === 'string' && rawPersona && isRedisSafeOpaqueId(rawPersona)
          ? rawPersona
          : undefined;
      const attachedSlugs = sanitizeAttachedSlugs(rawAttachedSlugs);
      const usage = sanitizeUsageSummary(rawUsage);
      const selectedModel = sanitizeModelId(rawSelectedModel);
      const out: SessionSnapshot = { ...rest } as SessionSnapshot;
      if (cwd !== undefined) out.cwd = cwd;
      if (activeSandboxId !== undefined) out.activeSandboxId = activeSandboxId;
      if (personaId !== undefined) out.personaId = personaId;
      if (attachedSlugs !== undefined) out.attachedSlugs = attachedSlugs;
      else delete out.attachedSlugs;
      if (usage !== undefined) out.usage = usage;
      else delete out.usage;
      if (selectedModel !== undefined) out.selectedModel = selectedModel;
      else delete out.selectedModel;
      return out;
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
