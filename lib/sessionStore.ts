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
   * Absent = clear (RESERVED_META_KEYS replace contract); `[]` = explicit
   * detach-all value. Slugs are validated with `SKILL_SLUG_RE` on the wire;
   * fail-closed to [] at read (`parseCloudSessionSnapshot`).
   */
  attachedSlugs?: string[];
  /**
   * Phase 3 (plan #539 / #327) — last COMPLETED turn's bounded provider-usage
   * summary. `undefined`/absent = the context slot HIDES. Cleared on a completed
   * turn whose provider reported no usage and on New/Clear; KEPT on abort/cancel.
   * Cloud carrier: reserved `meta.usage` (JSON string, drop-to-unset).
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
  /**
   * Plan #898 — selected reasoning-effort token (Gateway value, e.g. `low` /
   * `high` / `max`). Session-owned carrier `meta.reasoningEffort`. Omitted =
   * unset (restore uses `defaultEffortFromOptions` for the current model).
   * Sanitized with `sanitizeReasoningEffort` on read (drop-to-unset on poison).
   */
  reasoningEffort?: string;
  /**
   * Plan #906 — last-served Gateway-resolved provider slug (e.g. `togetherai`).
   * Worker-owned reserved `meta.resolvedProvider`. Omitted = hide the line-1
   * label. Sanitized with `sanitizeResolvedProvider` on read (drop-to-unset).
   */
  resolvedProvider?: string;
  /**
   * Plan #795 (backend-agents A1) — the Workflow **run id** carrier, mirrored on
   * the local session as the reserved `meta.turnRunId`. Omitted = no run id on the
   * session. Sanitized with `sanitizeTurnRunId` on read (drop-to-unset on poison)
   * so a poisoned value never sticks or bricks the session.
   */
  turnRunId?: string;
  /**
   * Plan #796 (backend-agents A2) — the turn-status enum carrier, mirrored on the
   * local session as the reserved `meta.turnStatus`. `completed` is a **first-class
   * terminal member**, preserved exactly (never dropped as poison) so the later C15
   * 409 stays live-only (A2 lock). Sanitized with `sanitizeTurnStatus` on read.
   */
  turnStatus?: import('./sessionCloudCaps').TurnStatus;
  /**
   * Plan #797 (backend-agents A3) — the attach/replay **stream cursor** carrier,
   * mirrored on the local session as the reserved `meta.turnStreamCursor`. Omitted
   * = no cursor. Sanitized with `sanitizeTurnStreamCursor` on read (drop-to-unset
   * on poison; `0` is a valid value, preserved).
   */
  turnStreamCursor?: number;
  /**
   * Plan #936 (source #549) — the model-messages pointer carrier, mirrored on
   * the local session as the reserved `meta.modelMessagesPointer`. Omitted = no
   * pointer observed yet. Sanitized with `isRedisSafeOpaqueId` on read
   * (drop-to-unset on poison). The host NEVER uses this to fetch the Blob
   * (Wasm/DOM never talk to Blob directly — feature-divide); it exists only so
   * the host knows to stop sending the `promptHistory` roll-forward fold once
   * a pointer exists server-side.
   */
  modelMessagesPointer?: string;
  /**
   * Plan #938 (source #550) — the session-owned agent working-notes block,
   * mirrored on the local session as the reserved `meta.workingNotes`. The
   * agent authors it via the `working_notes_*` tools (worker overlay writes
   * the envelope); the host mirror is the RESTORE carrier for
   * refresh/device-switch — the envelope is truth (same contract as every
   * reserved key). Omitted = no notes (fold omitted = zero tokens). Sanitized
   * with `sanitizeWorkingNotes` on read (drop-to-unset on poison).
   */
  workingNotes?: string;
  /**
   * backend-agents F21 (plan #815) — the persisted submit-queue MIRROR: an
   * ordered list of host-known prompts not yet durably started (composer
   * submits made while a turn is live). Oldest first. Rides the existing
   * transcript blob (localStorage JSON locally; the transcript object on the
   * envelope+Blob carrier) — never a reserved `meta` key, never a secret.
   * Absent = no queue. Sanitized on read via `sanitizeQueue` (lib/turnQueue.ts;
   * drop blanks / over-cap items, cap depth — a poisoned value never sticks).
   * AS-BUILT scope: host-known items only; Wasm-internal band enqueues are not
   * host-observable without a protocol bump (documented residual on #815).
   */
  queue?: string[];
};

import {
  MAX_MODEL_ID_LEN,
  MODEL_MSG_SEED_MAX_ROWS,
  SKILL_SLUG_RE,
  isRedisSafeOpaqueId,
  sanitizeModelId,
  sanitizeReasoningEffort,
  sanitizeResolvedProvider,
  sanitizeSessionCwd,
  sanitizeTurnRunId,
  sanitizeTurnStatus,
  sanitizeTurnStreamCursor,
  sanitizeWorkingNotes,
} from './sessionCloudCaps';
import { estimateTokens, foldBudgetTokens } from './agent/contextBudget';
import { sanitizeUsageSummary } from './agent/usageSummary';
import { sanitizeQueue } from './turnQueue';
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

/**
 * Browser quota (`QuotaExceededError`, Safari/Firefox `code` 22 / 1014).
 * Not `SecurityError` / private-mode denial.
 */
export function isQuotaExceededError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const rec = err as { name?: unknown; code?: unknown };
  if (rec.name === 'QuotaExceededError') return true;
  return rec.code === 22 || rec.code === 1014;
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
        reasoningEffort?: unknown;
        resolvedProvider?: unknown;
        turnRunId?: unknown;
        turnStatus?: unknown;
        turnStreamCursor?: unknown;
        modelMessagesPointer?: unknown;
        workingNotes?: unknown;
        queue?: unknown;
      };
      if (!data || typeof data !== 'object' || !Array.isArray(data.messages)) return null;
      // Tolerant: keep only safe workspace-relative cwd strings (parent #270 / phase 2),
      // a Redis-safe `activeSandboxId` (P1/GAP-1, #452), a Redis-safe `personaId`
      // (phase 3 #488), a slug-set-valid `attachedSlugs` (phase 2 #517), a
      // bounded provider-sourced `usage` (phase 3 #539), a printable-ASCII
      // ≤ `MAX_MODEL_ID_LEN` `selectedModel` (plan #616), and a Gateway
      // effort token `reasoningEffort` (plan #898); a bad local value can't
      // pin. `attachedSlugs` is sanitized so a poisoned local array is dropped
      // rather than spread raw (review #526 re-run 3 residual); a poisoned `usage`
      // (non-provider / over-cap) sanitizes to `undefined` → slot hides; a poisoned
      // `selectedModel` sanitizes to `undefined` → model restore falls back to default;
      // a poisoned `reasoningEffort` sanitizes to `undefined` → defaultEffortFromOptions.
      const {
        cwd: rawCwd,
        activeSandboxId: rawSandbox,
        personaId: rawPersona,
        attachedSlugs: rawAttachedSlugs,
        usage: rawUsage,
        selectedModel: rawSelectedModel,
        reasoningEffort: rawReasoningEffort,
        resolvedProvider: rawResolvedProvider,
        turnRunId: rawTurnRunId,
        turnStatus: rawTurnStatus,
        turnStreamCursor: rawTurnStreamCursor,
        modelMessagesPointer: rawModelMessagesPointer,
        workingNotes: rawWorkingNotes,
        queue: rawQueue,
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
      const reasoningEffort = sanitizeReasoningEffort(rawReasoningEffort);
      const resolvedProvider = sanitizeResolvedProvider(rawResolvedProvider);
      // backend-agents A1–A3: the three turn carriers mirror the reserved meta keys
      // and are re-sanitized on local load (drop-to-unset on poison) so a stale/
      // hand-edited localStorage value never sticks. `turnStatus='completed'` is a
      // first-class terminal member, preserved; `turnStreamCursor=0` is valid.
      const turnRunId = sanitizeTurnRunId(rawTurnRunId);
      const turnStatus = sanitizeTurnStatus(rawTurnStatus);
      const turnStreamCursor = sanitizeTurnStreamCursor(rawTurnStreamCursor);
      // Plan #936: the model-messages pointer mirrors the reserved meta key and
      // is re-sanitized on local load (drop-to-unset on poison) so a stale or
      // hand-edited localStorage value never sticks. Host never fetches the Blob.
      const modelMessagesPointer =
        typeof rawModelMessagesPointer === 'string' &&
        rawModelMessagesPointer &&
        isRedisSafeOpaqueId(rawModelMessagesPointer)
          ? rawModelMessagesPointer
          : undefined;
      // backend-agents F21 (plan #815): the persisted queue mirror re-sanitizes
      // on local load (drop blanks/over-cap items, cap depth) so a stale or
      // hand-edited localStorage value never sticks. An EMPTY sanitized list
      // drops to unset (absent carrier), matching removeQueuedText.
      const queue = sanitizeQueue(rawQueue);
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
      if (reasoningEffort !== undefined) out.reasoningEffort = reasoningEffort;
      else delete out.reasoningEffort;
      if (resolvedProvider !== undefined) out.resolvedProvider = resolvedProvider;
      else delete out.resolvedProvider;
      if (turnRunId !== undefined) out.turnRunId = turnRunId;
      else delete out.turnRunId;
      if (turnStatus !== undefined) out.turnStatus = turnStatus;
      else delete out.turnStatus;
      if (turnStreamCursor !== undefined) out.turnStreamCursor = turnStreamCursor;
      else delete out.turnStreamCursor;
      if (modelMessagesPointer !== undefined) out.modelMessagesPointer = modelMessagesPointer;
      else delete out.modelMessagesPointer;
      // Plan #938: the working-notes mirror re-sanitizes on local load
      // (drop-to-unset on poison) so a stale or hand-edited localStorage value
      // never sticks. The envelope is truth; this is the restore carrier.
      const workingNotes = sanitizeWorkingNotes(rawWorkingNotes);
      if (workingNotes !== undefined) out.workingNotes = workingNotes;
      else delete out.workingNotes;
      if (queue !== undefined && queue.length > 0) out.queue = queue;
      else delete out.queue;
      return out;
    } catch {
      return null;
    }
  }

  save(snapshot: SessionSnapshot): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.key, JSON.stringify(snapshot));
    } catch (err) {
      if (isQuotaExceededError(err)) throw err;
      // private mode / SecurityError — ignore
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
 *
 * Plan #944 (source #551): the fold budget is the **window-derived token
 * budget** — `window − reserve` in tokens (documented estimator ratio, not a
 * tokenizer). The caller passes the model's `contextWindow` (from the
 * `/api/models` catalog push); when omitted the conservative default window
 * applies — never a fabricated large number. The former 400-message default
 * is NO LONGER an intelligence cap: a generous row rail
 * (`MODEL_MSG_SEED_MAX_ROWS`) remains only as a safety rail against
 * pathological message count. `maxChars` is demoted to a transport BACKSTOP
 * (never the product rule): token trim first, char slice only as the
 * last-resort wire guard.
 *
 * The budget trims HISTORY, never the current ask: `newUserPrompt` always
 * survives, and at least the newest history row is kept. A single oversized
 * ask is sent anyway (never block the turn).
 */
export function formatPromptWithHistory(
  history: SessionMessage[],
  newUserPrompt: string,
  opts?: {
    /** @deprecated row-rail clamp only — kept for call sites */
    maxTurns?: number;
    /** @deprecated the 400 intelligence cap is retired (plan #944); row rail only. */
    maxMessages?: number;
    /** @deprecated transport backstop only (plan #944) — token budget is the rule. */
    maxChars?: number;
    /** The model's context window in tokens (catalog push). Omit → conservative default. */
    contextWindow?: number;
  },
): string {
  // Row safety rail (pathological count bound, plan #944) — no longer an
  // intelligence cap. Legacy `maxTurns`/`maxMessages` opts still tighten the
  // rail for call-site compatibility; never below 1, never above the rail cap.
  const railFromOpts =
    opts?.maxMessages ??
    (opts?.maxTurns != null
      ? Math.max(opts.maxTurns * 4, opts.maxTurns)
      : undefined);
  const maxMessages = Math.max(
    1,
    Math.min(railFromOpts ?? MODEL_MSG_SEED_MAX_ROWS, MODEL_MSG_SEED_MAX_ROWS),
  );
  // Transport backstop only (plan #944) — the token budget is the product rule.
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
  const recent = dialogue.slice(-maxMessages);

  if (recent.length === 0) return newUserPrompt;

  const HEADER =
    'Previous conversation (Tool lines already ran this session — reuse results; do not repeat the same tool calls unless the user asks or files may have changed):';
  const linesFor = (rows: typeof recent): string[] => {
    const lines: string[] = [HEADER];
    for (const m of rows) {
      if (m.role === 'user') lines.push(`User: ${m.text}`);
      else if (m.role === 'assistant') lines.push(`Assistant: ${m.text}`);
      else if (m.role === 'system') {
        // Skip end-of-turn markers (not tools).
        if ((m.text ?? '').startsWith('Turn ended ·')) continue;
        lines.push(`Tool: ${m.text}`);
      } else if (m.role === 'error') {
        lines.push(`Error: ${m.text}`);
      }
    }
    lines.push('', `User: ${newUserPrompt}`, '', 'Assistant:');
    return lines;
  };

  // Token budget = window − reserve (plan #944). The caller's catalog window
  // (when known) is bound under id '' so `foldBudgetTokens` reads it directly;
  // omitted → the conservative default window (never a fabricated number).
  const windowMap = new Map<string, number>();
  if (
    typeof opts?.contextWindow === 'number' &&
    Number.isFinite(opts.contextWindow) &&
    opts.contextWindow > 0
  ) {
    windowMap.set('', Math.floor(opts.contextWindow));
  }
  const maxTokens = foldBudgetTokens(windowMap, '');

  // Token trim: drop OLDEST history rows until the fold fits the budget. The
  // current ask (and the newest history row) always survive.
  let out = linesFor(recent).join('\n');
  while (recent.length > 0 && estimateTokens(out) > maxTokens) {
    recent.shift();
    if (recent.length === 0) {
      // Every history row was trimmed — send the bare current ask.
      out = ['', `User: ${newUserPrompt}`, '', 'Assistant:'].join('\n');
      break;
    }
    out = linesFor(recent).join('\n');
  }

  // Char backstop (transport only — never the product rule).
  if (out.length > maxChars) {
    // Keep the most recent context (tail).
    out = out.slice(out.length - maxChars);
    const nl = out.indexOf('\n');
    if (nl > 0 && nl < 240) out = out.slice(nl + 1);
  }
  return out;
}
