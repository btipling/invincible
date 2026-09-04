/**
 * Phase 3.7–3.9 — host-side inference for the harness.
 * Agent-tools first; a failed agent turn hard-fails (no 503 → /api/chat fallback).
 * Wasm never sees Gateway keys; results push through HarnessBridge + SessionStore.
 */
import {
  normalizePrompt,
  sendChat,
  validatePrompt,
  PROMPT_BODY_MAX_CHARS,
  type ChatResult,
} from './chatApi';
import {
  sendAgent,
  sendAgentStream,
  type AgentFailure,
  type AgentResult,
  type SendAgentFn,
  type SendAgentStreamFn,
  type ToolTraceEntry,
} from './agentApi';
import { sendTurn, sendTurnStream, attachTurnStream } from './turnApi';
import { isDetachAbort, isG22AcceptedAbort } from './detachTurn';
import { type AgentStreamEvent } from './agent/agentStream';
import { isProviderRefusalFinish, truncatedFinishError } from './agent/modelFinish';
import {
  TOOL_TRACE_SUMMARY_MAX_CHARS,
} from './sandbox/config';
import {
  withTransientRetry,
  type VercelErrorClass,
} from './sandbox/resilience';
import {
  isRedisSafeOpaqueId,
  normalizeSessionCwd,
  sanitizeTurnStreamCursor,
  STATUS_SLOT_MAX_BYTES,
} from './sessionCloudCaps';
import {
  foldThisRunAssistant,
  isAttachRunGone,
  lastUserText,
  prefixThroughLastUser,
  thisRunAssistantText,
  thisRunToolItems,
  thisRunWindow,
  withoutTrailingFollowUpUser,
} from './turnAttach';
import {
  closeThinkingSegment,
  createApplyTurnEvent,
  resetLiveToolStreak,
  type TurnApplyCtx,
} from './turnApply';
import {
  SANDBOX_FORBIDDEN_ERROR,
  SANDBOX_SELECTION_REQUIRED_ERROR,
} from './tenancy/errors';
import { formatUsageSummary, sanitizeUsageSummary } from './agent/usageSummary';
import {
  HarnessBridge,
  Lifecycle,
  MessageKind,
  StatusSlot,
} from './harnessBridge';
import {
  resetHarnessImageSession,
  scheduleImagesFromMarkdown,
  scheduleImagesFromTexts,
} from './harnessImages';
import {
  resetHarnessMathSession,
  scheduleMathFromMarkdown,
  scheduleMathFromTexts,
} from './harnessMath';
import {
  appendMessage,
  formatPromptWithHistory,
  type SessionMessage,
  type SessionRole,
  type SessionSnapshot,
} from './sessionStore';
import {
  buildTraceGroups,
  createToolRunGroup,
  decodeToolRun,
  encodeToolRun,
  encodeToolRunPayload,
  mergeToolRunPayloads,
  type ToolRunGroup,
  type ToolRunPayload,
} from './toolRun';
import { canLoadEarlier, latestRingStart, sliceMessagesForRing } from './sessionWindow';

/** UTF-8 width helper for `truncateStatusValue` (status-slot byte cap). */
const utf8Encode = new TextEncoder();

/**
 * Match Wasm MAX_MSG_LEN (`native/harness/src/bridge.zig`).
 * Only hard edge for a single ring line — not a product "thinking budget".
 */
export const THINKING_DISPLAY_MAX = 262_144;

/**
 * @deprecated No per-turn thinking segment cap (was a UX wall). Kept as Infinity
 * for any leftover imports/tests.
 */
export const THINKING_SEGMENTS_MAX = Number.POSITIVE_INFINITY;

/**
 * @deprecated Thinking is no longer collapsed to a one-liner on tool boundaries.
 * Kept for tests that call collapseThinkingDisplay (now identity-ish soft trim).
 */
export const THINKING_COLLAPSED_MAX = THINKING_DISPLAY_MAX;

/**
 * @deprecated No host toolTrace line cap. Kept as Infinity for import stability.
 */
export const TOOL_TRACE_MAX_LINES = Number.POSITIVE_INFINITY;

// ── plan #759 — retryable turn errors retry the current turn, never drain ──
/** Max attempts (1 send + 4 retries) for a retryable agent-turn failure. NEW cap. */
export const TURN_RETRY_ATTEMPTS = 5;
/** Backoff base (ms) between attempts — matches `withTransientRetry` defaults. */
export const TURN_RETRY_BASE_MS = 250;
/** Hard backoff cap (ms). */
export const TURN_RETRY_CAP_MS = 4000;
/** Wasm `MAX_ITEMS` mirror (`submit_queue.zig`) — host fails closed at this depth. */
export const HARNESS_QUEUE_MAX_ITEMS = 16;
/** Inserted as the new queue HEAD on give-up with a non-empty queue (plan #759). */
export const CONTINUE_TURN_PROMPT = 'Continue the current turn';

/**
 * HTTP statuses the turn treats as PERMANENT (no 5× backoff loop): 4xx client
 * errors are the operator/request's fault (auth 401/403, validation 400/422,
 * not-found 404, too-large 413, and 409 live-lock — C15's double-send guard —
 * which is a state conflict, not a transient quota blip like 429, so it must
 * not hammer POST while the first run is still live). 408/429/5xx and
 * timeout/empty stay retryable.
 */
const PERMANENT_TURN_STATUS = new Set([400, 401, 403, 404, 409, 413, 422]);

/**
 * Thrown by the retry wrapper for a FAILED agent attempt so `withTransientRetry`
 * (via the narrow classifier) can decide retryable vs permanent from the HTTP
 * status + `classifyTurnFailure` kind — the turn classifier keys on both because
 * `classifyTurnFailure` does NOT return distinct 401/403/validation kinds.
 *
 * Exported so unit tests can pin `classifyTurnRetry` against a real instance
 * (adversarial #844 Nit: detach must be permanent, not only gated by an
 * already-aborted signal).
 */
export class AgentRetryError extends Error {
  readonly status: number | undefined;
  readonly turnKind: TurnEndKind;
  /** Session-sticky attached-skills set from the failed AgentFailure — must
   *  survive the throw/catch round-trip or fold-before-persist (plan #517)
   *  would silently drop the sticky set on a give-up turn. */
  readonly attachedSlugs?: string[];
  /** Plan #811 (D17) — the Workflow run id must survive the throw/catch
   *  round-trip too, or the D17 failure fold (clear `turnRunId` + mark the
   *  terminal turn `completed`) can never fire: the give-up rebuild would drop
   *  the id on every failed durable turn, leaving a stale `running` on the
   *  session that blocks the next C15 start. */
  readonly turnRunId?: string;
  constructor(
    error: string,
    status: number | undefined,
    turnKind: TurnEndKind,
    attachedSlugs?: string[],
    turnRunId?: string,
  ) {
    super(error);
    this.name = 'AgentRetryError';
    this.status = status;
    this.turnKind = turnKind;
    this.attachedSlugs = attachedSlugs;
    this.turnRunId = turnRunId;
  }
}

/**
 * Narrow classifier for the in-flight turn (passed to the `classify` seam in
 * `withTransientRetry`). Deliberately NOT `classifyVercelError` — a turn failure
 * is its own domain, not the sandbox SDK's. stop / 401 / 403 / other permanent
 * statuses → permanent (single attempt, straight to give-up); timeout / empty /
 * generic 5xx / network → retryable.
 */
export function classifyTurnRetry(err: unknown): VercelErrorClass {
  if (err instanceof AgentRetryError) {
    if (err.turnKind === 'stop' || err.turnKind === 'detach') {
      return { kind: 'permanent', status: err.status };
    }
    if (err.status !== undefined && PERMANENT_TURN_STATUS.has(err.status)) {
      return { kind: 'permanent', status: err.status };
    }
    return { kind: 'retryable', status: err.status };
  }
  // Anything else (incl. withTransientRetry's own AbortError mid-backoff) can't
  // be re-classified in the turn domain — fail closed to permanent.
  return { kind: 'permanent' };
}

/** Rebuild an AgentFailure from a classifier-thrown value (post-retry give-up). */
function agentFailureFromRetry(err: unknown): AgentFailure {
  if (err instanceof AgentRetryError) {
    return {
      ok: false,
      error: err.message,
      ...(err.status != null ? { status: err.status } : {}),
      ...(err.attachedSlugs !== undefined
        ? { attachedSlugs: err.attachedSlugs }
        : {}),
      ...(err.turnRunId !== undefined ? { turnRunId: err.turnRunId } : {}),
    };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { ok: false, error: 'Request cancelled.' };
  }
  return { ok: false, error: err instanceof Error ? err.message : 'Turn failed.' };
}

/**
 * plan #759 — on give-up with a non-empty queue, insert `Continue the current
 * turn` as the new HEAD (never pops operator items). Fails closed when the
 * queue is full: no insert, no drop.
 */
export function insertContinueTurnPrompt(bridge: HarnessBridge): void {
  const count = bridge.queuedCount();
  if (count === 0) return;
  if (count >= HARNESS_QUEUE_MAX_ITEMS) return; // fail closed — no drop
  bridge.queuedInsertFront(CONTINUE_TURN_PROMPT);
}

/**
 * Lifecycle to land on after a FAILED turn: Ready on operator Stop (queue
 * untouched, drains only on a later success — unchanged), and Error on give-up
 * (plan #759 — `err` is NOT terminal for the Wasm promote gate, so a failed
 * turn never consumes a queued operator item; Continue is inserted at head).
 */
function setFailLifecycle(bridge: HarnessBridge, kind: TurnEndKind): void {
  // plan #760 — a non-success terminal must never auto-drain: arm the one-shot
  // promote gate false (a Stop lands on Ready; without the gate FALSE that Ready
  // would drain a queued head). Harmless on the give-up Error path (err is not
  // terminal for the promote gate), but the Ready-on-Stop case REQUIRES it.
  bridge.setQueuePromoteAllowed(false);
  if (kind === 'stop' || kind === 'detach') {
    bridge.setLifecycle(Lifecycle.Ready);
  } else {
    bridge.setLifecycle(Lifecycle.Error);
    insertContinueTurnPrompt(bridge);
  }
}

/**
 * Attach 503/401/network: one non-terminal EMBER row. A retry that 503s again
 * replaces the last subscribe-fail error instead of stacking Blob rows
 * (adversarial #857 Minor).
 */
function paintSubscribeFail(
  bridge: HarnessBridge,
  session: SessionSnapshot,
  line: string,
): SessionSnapshot {
  const last = session.messages[session.messages.length - 1];
  if (last?.role === 'error' && !isTurnEndLine(last.text)) {
    const msgs = session.messages.slice();
    msgs[msgs.length - 1] = { ...last, text: line, at: Date.now() };
    const next = { ...session, messages: msgs, updatedAt: Date.now() };
    if (!bridge.updateLastMessage(MessageKind.Error, line)) {
      bridge.pushMessage(MessageKind.Error, line);
    }
    return next;
  }
  bridge.pushMessage(MessageKind.Error, line);
  return appendMessage(session, 'error', line);
}

export type RunHarnessChatOptions = {
  signal?: AbortSignal;
  /** Inject for tests; defaults to sendChat. */
  send?: typeof sendChat;
  /**
   * When true (default), push the user line into the Wasm transcript.
   * Set false if Wasm already showed the user message before host ack.
   */
  pushUser?: boolean;
  /**
   * Prior session messages for multi-turn context (user/assistant only folded).
   * Does not include the new user prompt.
   */
  history?: SessionSnapshot['messages'];
  /** When true (default), fold history into the Gateway prompt. */
  useHistory?: boolean;
  /** Explicit gateway model id (protocol v3 picker). */
  modelId?: string;
  /** Live Wasm effort pick (protocol v23). Omit when hidden/empty. */
  reasoning?: string;
};

export type RunHarnessTurnOptions = Omit<RunHarnessChatOptions, 'history'> & {
  /**
   * When true (default), run the agent (tools) path; for `preferAgent:false`
   * the harness uses `runHarnessChat` directly (standalone chat). A failed
   * agent turn always hard-fails — there is no 503 → /api/chat fallback.
   */
  preferAgent?: boolean;
  /** Inject for tests; defaults to sendAgent (JSON). */
  sendAgent?: SendAgentFn;
  /**
   * When true (default), use SSE stream for live tool/text updates.
   * Set false to force JSON agent path.
   */
  streamAgent?: boolean;
  /** Inject for tests; defaults to sendAgentStream. */
  sendAgentStream?: SendAgentStreamFn;
  /**
   * Phase 2 (#627 / #625): called after each mid-turn session mutation
   * (cwd change, sandbox switch) so the host can persist the live state
   * before `done`. Never awaited; wired to the existing `persist` callback.
   */
  onSessionPatch?: (s: SessionSnapshot) => void;
  /**
   * Plan #813 (E19) — GET-attach an existing durable run instead of POST
   * `/api/turns`. Skips prompt validation / user push. `dedup` enables the
   * this-run-window skip (cold attach). E20 (#814) — the shared apply
   * consumer lives in `lib/turnApply.ts` (`createApplyTurnEvent`).
   */
  attach?: {
    runId: string;
    startIndex: number;
    dedup: boolean;
    attachStream?: typeof attachTurnStream;
  };
  /**
   * Plan #887 — skip appending a User row to SessionStore (auto-continue).
   * Independent of `pushUser` (ring). Attaching already skips. History fold
   * still uses `formatPromptWithHistory(session.messages, prompt)`.
   */
  skipUserAppend?: boolean;
};

export type HarnessTurnResult = {
  result: ChatResult;
  /** Session after this turn (user + optional system tool lines + assistant/error). */
  session: SessionSnapshot;
  /**
   * True only after attach/POST `onTurnStarted` (200 SSE opened).
   * Omitted / false: validation, fetch-reject, JSON 4xx/5xx. Host hot-resume
   * must not treat subscribe-fail as a live drop.
   */
  streamOpened?: boolean;
};

function roleToKind(role: SessionRole): MessageKind {
  switch (role) {
    case 'user':
      return MessageKind.User;
    case 'assistant':
      return MessageKind.Assistant;
    case 'system':
      return MessageKind.System;
    case 'error':
      return MessageKind.Error;
    case 'tool_run':
      return MessageKind.ToolRun;
    case 'skill_attached':
      return MessageKind.SkillAttached;
  }
}

/**
 * Display-only text for a skill attach/detach outcome (phase 2 #517). Carries
 * ONLY the slug + status — never a skill body (bodies stay server-side in the
 * model's system context).
 */
export function skillRowText(ev: {
  action: 'attach' | 'detach';
  slug: string;
  ok: boolean;
}): string {
  if (ev.action === 'detach') {
    return ev.ok ? `Skill detached: ${ev.slug}` : `Skill not attached: ${ev.slug}`;
  }
  return ev.ok ? `Skill attached: ${ev.slug}` : `Skill not attached: ${ev.slug}`;
}

/**
 * Push one display-only skill row to the bridge (kind 7 `skill_attached`) and
 * mirror it into the session (role `skill_attached`). Display-only: never folded
 * into the model prompt (staff-of-work bodies are server-side only).
 *
 * E20 (#814): exported for `lib/turnApply.ts` — the shared apply consumer
 * relocated the stream-side caller here; the JSON `skillEvents` path in
 * `runHarnessTurn` still calls it directly.
 */
export function pushSkillRow(
  bridge: HarnessBridge,
  session: SessionSnapshot,
  ev: { action: 'attach' | 'detach'; slug: string; ok: boolean },
): SessionSnapshot {
  const text = skillRowText(ev);
  bridge.pushMessage(MessageKind.SkillAttached, text);
  return appendMessage(session, 'skill_attached', text);
}

/** Soft-truncate for bridge only when past Wasm MAX_MSG_LEN-scale limits. */
export function truncateToolTraceSummary(
  text: string,
  maxChars: number = TOOL_TRACE_SUMMARY_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Soft-truncate thinking to Wasm line max (MAX_MSG_LEN). */
export function truncateThinkingDisplay(
  text: string,
  maxChars: number = THINKING_DISPLAY_MAX,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Keep full thinking when a segment closes (no one-liner collapse).
 * Whitespace-normalized only so the ring still shows the monologue.
 */
export function collapseThinkingDisplay(
  text: string,
  maxChars: number = THINKING_COLLAPSED_MAX,
): string {
  const raw = text ?? '';
  if (!raw.trim()) return 'Thinking';
  // Preserve newlines in long monologues — only soft-cap to line max.
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * All non-empty toolTrace summaries for host display (no line-count product cap).
 */
export function selectToolTraceLines(
  toolTrace: ToolTraceEntry[] | undefined,
  maxLines: number = TOOL_TRACE_MAX_LINES,
): string[] {
  if (!toolTrace?.length) return [];
  const lines: string[] = [];
  for (const entry of toolTrace) {
    if (Number.isFinite(maxLines) && lines.length >= maxLines) break;
    const summary = truncateToolTraceSummary((entry.summary ?? '').trim());
    if (!summary) continue;
    lines.push(summary);
  }
  return lines;
}

/**
 * Coalesce consecutive `tool_run` rows on hydrate (plan #365) so a long restored
 * session reads as scannable groups instead of a wall of N×1 cards. A run of
 * adjacent `tool_run` messages is decoded and merged via `mergeToolRunPayloads`
 * (rolling at `TOOL_RUN_ITEMS_MAX` + re-clamping the summed detail budget —
 * never across an assistant/user/error/turn-end boundary, because those roles
 * interrupt the run). A row that fails decode is kept as raw plain text
 * (fail-open) and ends the run. Only the merged group's text (and row count)
 * changes; the first source row's `id`/`at` anchor each merged group. Every item
 * count stays exact (recounted), so no header can disagree with kept items.
 */
export function coalesceToolRunMessages(
  messages: SessionMessage[],
): SessionMessage[] {
  const out: SessionMessage[] = [];
  let run: ToolRunPayload[] = [];
  let anchor: SessionMessage | undefined;

  const flush = () => {
    if (run.length === 0 || !anchor) return;
    const merged = mergeToolRunPayloads(run);
    for (const p of merged) {
      const text = encodeToolRunPayload(p);
      if (text) out.push({ id: anchor.id, role: 'tool_run', text, at: anchor.at });
    }
    run = [];
    anchor = undefined;
  };

  for (const m of messages) {
    if (m.role === 'tool_run') {
      const p = decodeToolRun(m.text);
      if (p) {
        if (run.length === 0) anchor = m;
        run.push(p);
        continue;
      }
      // decode fail-open — flush the open run, keep this row raw.
      flush();
      out.push(m);
      continue;
    }
    flush();
    out.push(m);
  }
  flush();
  return out;
}

/** Mirror a SessionStore window (≤ HARNESS_RING_MAX) into Wasm. Returns ringWindowStart used. */
export function pushSessionToBridge(
  bridge: HarnessBridge,
  session: SessionSnapshot,
  opts?: {
    clear?: boolean;
    lifecycle?: import('./harnessBridge').Lifecycle;
    /** Oldest session index to place in the ring; default = latest window. */
    windowStart?: number;
    /**
     * Protocol v21 — keep the Wasm submit queue / pause / promote gate.
     * Send-while-running attach only. F5 / New / switch omit this.
     */
    preserveQueue?: boolean;
  },
): number {
  const windowStart =
    opts?.windowStart !== undefined
      ? Math.max(0, opts.windowStart)
      : latestRingStart(session.messages.length);
  const slice = coalesceToolRunMessages(
    sliceMessagesForRing(session.messages, windowStart),
  );
  const msgs = slice.map((m) => ({
    kind: roleToKind(m.role),
    text: m.text,
  }));
  if (opts?.clear !== false) {
    resetHarnessImageSession();
    resetHarnessMathSession();
    bridge.hydrateMessages(msgs, {
      lifecycle: opts?.lifecycle,
      preserveQueue: opts?.preserveQueue,
    });
    foldStatusSlots(bridge, session);
    // Phase 2 (plan #540) — hydrate/turn-refresh: pull the git slot right after
    // the sandbox/cwd fold so a restored or freshly-bound session's first git
    // paint isn't stale against a full cadence tick. Fail-soft (keeps last on
    // any error / rate-limit); server rate-limited.
    void refreshGitStatusSlot(bridge, session);
  } else {
    for (const m of msgs) {
      bridge.pushMessage(m.kind, m.text);
    }
  }
  const texts = slice
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => m.text);
  scheduleImagesFromTexts(bridge, texts);
  scheduleMathFromTexts(bridge, texts);
  bridge.setCanLoadEarlier(canLoadEarlier(windowStart));
  return windowStart;
}

/**
 * Adversarial #857: hot-resume follow-up strip. Thinking has no SessionStore
 * role, so this cannot go through `pushSessionToBridge`. Same cache contract as
 * a canonical hydrate: reset JS `putOk`, clear+repaint the kept rows, reschedule
 * user/assistant media. Does not coalesce (live thinking is a separator) and
 * does not touch Load-earlier (ring window is unchanged).
 *
 * Always `preserveQueue` — this is a live-session surgical edit, not F5/New.
 */
export function rebuildAttachRingFromRows(
  bridge: HarnessBridge,
  rows: { kind: MessageKind; text: string }[],
  session: SessionSnapshot,
): void {
  resetHarnessImageSession();
  resetHarnessMathSession();
  bridge.hydrateMessages(rows, { preserveQueue: true });
  foldStatusSlots(bridge, session);
  const texts = rows
    .filter((m) => m.kind === MessageKind.User || m.kind === MessageKind.Assistant)
    .map((m) => m.text);
  scheduleImagesFromTexts(bridge, texts);
  scheduleMathFromTexts(bridge, texts);
}

/**
 * Host-side UTF-8-safe ellipsizer for a status-slot value (PR #543 #3). A status
 * slot holds at most `STATUS_SLOT_MAX_BYTES` UTF-8 bytes (Zig
 * `MAX_STATUS_SLOT_LEN`); `setStatusSlot` rejects anything over the cap. Without
 * a host cap, an oversize fold (realistically a long cwd ≥ 97 bytes) would be
 * ignored by `setStatusSlot` — leaving the PRIOR slot value painted. Truncating
 * at a UTF-8 code-point boundary with a trailing "…" keeps the operator's
 * context and never lets an accepted-but-oversize value stall a stale sibling.
 * Returns `''` for a whitespace/empty input; otherwise the value ≤ cap bytes
 * (content at budget + 3-byte ellipsis). Mirrors the Zig `truncateStatusValue`
 * behavior on the host side (that one is only reachable in-Wasm for a stale wire
 * value; this is the normal host-push path).
 */
export function truncateStatusValue(
  value: string,
  maxBytes: number = STATUS_SLOT_MAX_BYTES,
): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  const bytes = utf8Encode.encode(text);
  if (bytes.length <= maxBytes) return text;
  // "…" (U+2026) is 3 UTF-8 bytes — reserve it so the result never exceeds cap.
  const budget = Math.max(0, maxBytes - 3);
  if (budget <= 0) return '…';
  // Iterate full code points (for...of yields astral pairs as one), accumulating
  // only while the code point's own UTF-8 width still fits the budget. This
  // never splits a multi-byte sequence — safe to decode the byte prefix.
  let taken = '';
  let used = 0;
  for (const cp of text) {
    const cpBytes = utf8Encode.encode(cp).length;
    if (used + cpBytes > budget) break;
    taken += cp;
    used += cpBytes;
  }
  return `${taken}…`;
}

/**
 * Protocol v13 (plan #538/#541) — fold session state into the Wasm status-slot
 * pack that the canvas header paints. Sandbox slot = a human label derived from
 * the effective `activeSandboxId` (non-secret Redis-safe id; never base_url /
 * token). cwd slot = the workspace-relative `session.cwd`. An unset value clears
 * the slot (mutually safe — never a stale leftover from a prior session).
 * Oversize values are truncated to the slot byte cap via `truncateStatusValue`
 * (PR #543 #3) so a present-but-long cwd renders `<…>` instead of failing — the
 * slot is only ever a real current value, an empty (cleared) slot, or an honest
 * truncated-with-ellipsis value; never a stale prior sibling.
 */
export function foldStatusSlots(
  bridge: HarnessBridge,
  session: SessionSnapshot,
): void {
  const sandbox = session.activeSandboxId;
  if (sandbox && isRedisSafeOpaqueId(sandbox)) {
    bridge.setStatusSlot(StatusSlot.Sandbox, truncateStatusValue(`sandbox ${sandbox}`));
  } else {
    bridge.clearStatusSlot(StatusSlot.Sandbox);
  }
  const cwd = toSessionCwd(session.cwd);
  if (cwd) {
    bridge.setStatusSlot(StatusSlot.Cwd, truncateStatusValue(cwd));
  } else {
    bridge.clearStatusSlot(StatusSlot.Cwd);
  }
  // Phase 3 (plan #539 / #327) — context/usage slot. Absent usage (or a
  // non-provider source) HIDES by default; a completed turn always folds its own
  // summary (clearing the slot when the provider reported none), while an
  // aborted/cancelled turn carries the prior summary forward so the slot keeps
  // its last honest value — never a fake number.
  // Read-side validation (validate on read too): the value is re-sanitized here
  // so a poisoned in-memory usage (non-provider source / absuuurd clamped counts
  // past the carrier cap) can never paint — the slot stays hidden instead.
  const context = formatUsageSummary(sanitizeUsageSummary(session.usage));
  if (context) {
    bridge.setStatusSlot(StatusSlot.Context, truncateStatusValue(context));
  } else {
    bridge.clearStatusSlot(StatusSlot.Context);
  }
}

/**
 * Phase 2 (plan #540) — refresh the git status slot from the read-only server
 * probe (`GET /api/harness/status`). The DOM host calls this after hydrate,
 * after each agent turn / confirmed cwd change, and on the slow cadence timer;
 * the server resolves the envelope-authoritative bind and runs the bounded git
 * probe at the bind workspace root.
 *
 * Fail-soft on every path — never throws, never blocks a turn, never blanks a
 * sibling slot:
 * - any network/abort/cancel error, non-ok status, or a server `rate_limited`
 *   reply → the git slot KEEPS its last value (it is not cleared on a transient
 *   rate-limit, so a refresh loop can't flicker the header).
 * - a valid empty probe result (non-git / no bind) → clear the git slot (stale
 *   prior value must not linger).
 * - a SHA-only result (sha present, branch absent — detached HEAD / transient
 *   git lock) → keep the last honest branch@sha (structured git fields are
 *   authoritative: a real @-prefixed branch has both fields and passes through).
 * - an oversize value is ellipsized to the status-slot byte cap via
 *   `truncateStatusValue` before the wire.
 */
export async function refreshGitStatusSlot(
  bridge: HarnessBridge,
  session: SessionSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const params = new URLSearchParams();
    // Redis-safe carries only; any non-safe value is simply omitted (the server
    // still resolves the envelope bind, which is authoritative).
    if (session.activeSandboxId && isRedisSafeOpaqueId(session.activeSandboxId)) {
      params.set('sandboxId', session.activeSandboxId);
    }
    if (session.id && isRedisSafeOpaqueId(session.id)) {
      params.set('sessionId', session.id);
    }
    const q = params.toString();
    const res = await fetch(`/api/harness/status${q ? `?${q}` : ''}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || res.status === 429) return; // keep last value
    const data = (await res.json()) as {
      value?: string;
      git?: { branch?: string; sha?: string; dirty?: boolean };
    };
    // Rate-limited replies carry the cached value and are not a clear; only a
    // genuinely empty probe result clears the git slot.
    if (typeof data.value === 'string' && data.value.length > 0) {
      // When the server returns a sha but no branch (detached HEAD / transient
      // git lock), keep the last honest branch@sha. The structured git fields
      // are authoritative: a real @-prefixed branch has both git.branch AND
      // git.sha and passes through — only the sha-present+branch-absent case is
      // an unreliable SHA-only partial (adversarial review L1: git check-ref-format
      // accepts @-prefixed branch names, so the string prefix is not a reliable
      // discriminator).
      if (data.git?.sha && !data.git?.branch) return;
      bridge.setStatusSlot(StatusSlot.Git, truncateStatusValue(data.value));
    } else {
      bridge.clearStatusSlot(StatusSlot.Git);
    }
  } catch {
    // Abort / network error: keep the last git value, never throw.
  }
}

/**
 * Protocol v19 (plan #760) — host terminal: arm the one-shot promote gate then
 * set Ready. The host is the SOLE lifecycle writer and the only observer of the
 * outcome (`classifyTurnFailure`), so every Ready path must go through this
 * helper or a Stop/error Ready could silently drain the queue. `promoteAllowed`
 * is true on a SUCCESSFUL turn (auto-promote stays, unchanged) and false on
 * Stop / Esc / error / timeout / validation (the Wasm terminal-promote block
 * never drains after a non-success; only idle ▶ / Ctrl+Enter explicit Play does).
 */
function completeTurn(bridge: HarnessBridge, promoteAllowed: boolean): void {
  bridge.setQueuePromoteAllowed(promoteAllowed);
  bridge.setLifecycle(Lifecycle.Ready);
}

/**
 * Run one prompt → Gateway → transcript update (standalone chat path, no agent
 * tools). Sets lifecycle busy → Ready on success; on failure it gives up to
 * Error (or stays Ready on an operator Stop) — the chat path does NOT retry.
 * Client-side validation is rejected PRE-Busy: it pushes the error line and
 * returns Ready without ever inserting a Continue prompt (nothing drained).
 */
export async function runHarnessChat(
  bridge: HarnessBridge,
  rawPrompt: string,
  opts?: RunHarnessChatOptions,
): Promise<ChatResult> {
  const validation = validatePrompt(rawPrompt);
  if (validation) {
    bridge.pushMessage(MessageKind.Error, validation);
    completeTurn(bridge, false); // validation — no auto-promote
    return { ok: false, error: validation };
  }

  const prompt = normalizePrompt(rawPrompt);
  const send = opts?.send ?? sendChat;
  const pushUser = opts?.pushUser !== false;
  const useHistory = opts?.useHistory !== false;
  const history = opts?.history ?? [];

  const apiPrompt =
    useHistory && history.length > 0
      ? formatPromptWithHistory(history, prompt)
      : prompt;

  bridge.setLifecycle(Lifecycle.Busy);
  if (pushUser) {
    bridge.pushMessage(MessageKind.User, prompt);
    scheduleImagesFromMarkdown(bridge, prompt);
    scheduleMathFromMarkdown(bridge, prompt);
  }

  const result = await send(apiPrompt, {
    signal: opts?.signal,
    modelId: opts?.modelId,
  });

  if (result.ok) {
    bridge.pushMessage(MessageKind.Assistant, result.text);
    scheduleImagesFromMarkdown(bridge, result.text);
    scheduleMathFromMarkdown(bridge, result.text);
    // Also fold prior history so LRU-dropped formulas can refresh.
    if (history.length > 0) {
      scheduleMathFromTexts(
        bridge,
        [
          ...history
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => m.text),
          prompt,
          result.text,
        ],
      );
    }
    bridge.pushMessage(MessageKind.System, describeTurnEnd('chat'));
    completeTurn(bridge, true); // success — auto-promote allowed
    return result;
  }

  const fail = classifyTurnFailure(result.error, result.status, opts?.signal);
  bridge.pushMessage(
    fail.kind === 'stop' ? MessageKind.System : MessageKind.Error,
    describeTurnEnd(fail.kind, fail.detail),
  );
  // plan #759 — arms the promote gate false (plan #760) then lands Stop on Ready
  // (queue untouched) or give-up on Error + Continue-at-head never drains.
  setFailLifecycle(bridge, fail.kind);
  return result;
}

/** Prefix for end-of-turn canvas lines (excluded from Tool: history fold). */
export const TURN_END_PREFIX = 'Turn ended · ';

export function isTurnEndLine(text: string): boolean {
  return (text ?? '').startsWith(TURN_END_PREFIX);
}

export type TurnEndKind =
  | 'model'
  | 'stop'
  | 'detach'
  | 'error'
  | 'timeout'
  | 'empty'
  | 'validation'
  | 'chat';

/**
 * Human-readable why this turn stopped. Always starts with TURN_END_PREFIX.
 */
export function describeTurnEnd(kind: TurnEndKind, detail?: string): string {
  const d = (detail ?? '').replace(/\s+/g, ' ').trim();
  switch (kind) {
    case 'model':
      return `${TURN_END_PREFIX}model finished`;
    case 'stop':
      return `${TURN_END_PREFIX}you stopped`;
    case 'detach':
      // Never painted on the canvas (fail path skips pushTurnEnd). Exhaustiveness.
      return `${TURN_END_PREFIX}detached`;
    case 'timeout':
      return d
        ? `${TURN_END_PREFIX}timed out · ${d}`
        : `${TURN_END_PREFIX}timed out`;
    case 'empty':
      return `${TURN_END_PREFIX}empty model response`;
    case 'validation':
      return d
        ? `${TURN_END_PREFIX}invalid input · ${d}`
        : `${TURN_END_PREFIX}invalid input`;
    case 'chat':
      return `${TURN_END_PREFIX}chat finished`;
    case 'error':
    default:
      return d
        ? `${TURN_END_PREFIX}error · ${d}`
        : `${TURN_END_PREFIX}error`;
  }
}

/** Classify a failed agent/chat result into an end reason. */
export function classifyTurnFailure(
  error: string,
  status?: number,
  signal?: AbortSignal,
): { kind: TurnEndKind; detail?: string } {
  const msg = (error ?? '').trim();
  if (isDetachAbort(signal)) {
    return { kind: 'detach' };
  }
  if (signal?.aborted || msg === 'Request cancelled.' || status === 499) {
    return { kind: 'stop' };
  }
  const lower = msg.toLowerCase();
  if (
    status === 504 ||
    status === 408 ||
    /\btimeout\b|timed out|time-?out|maxduration|invocation timeout|function_invocation_timeout/i.test(
      msg,
    )
  ) {
    return { kind: 'timeout', detail: msg || undefined };
  }
  if (/empty model response/i.test(msg)) {
    return { kind: 'empty' };
  }
  return { kind: 'error', detail: msg || undefined };
}

function pushTurnEnd(
  bridge: HarnessBridge,
  session: SessionSnapshot,
  kind: TurnEndKind,
  detail?: string,
): SessionSnapshot {
  const line = describeTurnEnd(kind, detail);
  // Stop / model / chat → System. Real failures → Error so they stay ember-tinted.
  const asError = kind === 'error' || kind === 'timeout' || kind === 'empty' || kind === 'validation';
  if (asError) {
    bridge.pushMessage(MessageKind.Error, line);
    return appendMessage(session, 'error', line);
  }
  bridge.pushMessage(MessageKind.System, line);
  return appendMessage(session, 'system', line);
}

/**
 * The single tool-run boundary kind. Tracks the last kind pushed to the bridge
 * (the row the user last saw) so grouping of the next `tool_start`/`tool_result`
 * is one predicate instead of scattered flush call sites (plan #364 / residual
 * #357). Under the #433 lock only `'tool_run'` continues the open card;
 * `'thinking'`, `'none'`, `'assistant'`, `'user'`, `'error'`, and `'system'` are
 * physical separators — the next tool opens a NEW card at `1`. `'system'` is a
 * turn-end terminal row.
 */
export type LastUiKind =
  | 'none'
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool_run'
  | 'system'
  | 'error';

/**
 * Single grouping predicate (#433 locked rule): whether an incoming
 * `tool_start`/`tool_result` continues the open tool-run card (aggregate into
 * the current live card) or must open a NEW card at `1`. The live path uses
 * `lastRingRowIsToolRun` (the only ring writer) as its runtime flag; this pure
 * helper states the same rule from a `LastUiKind`. Under the #433 lock a
 * tool-run row last continues; every other row (thinking / assistant / user /
 * error / system) is a physical separator, so a Thinking row that lands last
 * forces a fresh card. `none` (fresh turn start) is checked by the live flag
 * and opens a card at 1. `system` is a turn-end terminal — never a live continue.
 */
export function shouldContinueStreak(last: LastUiKind): boolean {
  return last === 'tool_run';
}

/**
 * Restore `lastUiKind` at turn start from the last persisted session role so
 * the same predicate that drives a live turn also drives the first tool after a
 * reload. A fresh/empty session returns `'none'` (first tool continues a
 * brand-new group). After any committed row the first post-reload tool opens a
 * new group so it never grows a committed restored row.
 */
export function restoreLastUiKind(
  messages: SessionSnapshot['messages'],
): LastUiKind {
  const last = messages[messages.length - 1];
  if (!last) return 'none';
  switch (last.role) {
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    case 'error':
      return 'error';
    case 'system':
      return 'system';
    case 'tool_run':
      return 'tool_run';
    case 'skill_attached':
      // A skill row is a non-tool separator — the next tool opens a fresh card.
      return 'assistant';
  }
}

/**
 * Map any candidate cwd to a value `/api/agent` will accept, or `undefined` when it
 * cannot be safely sent (host-absolute, drive/UNC, control chars, or `..` that
 * escapes the workspace root). `..`/`a/../../b` are LEGAL on the session record at
 * P1 (validateMetaFields accepts them), but `normalizeWorkspaceRel` throws on an
 * escaping `..` — so feeding it straight to `/api/agent` would 400 every turn. The
 * getter / success-apply must therefore sanitize then renormalize, else `.`.
 */
function toSessionCwd(value: unknown): string | undefined {
  return normalizeSessionCwd(value);
}

/**
 * Defensive `change_dir` marker parser. The PRIMARY persistence carrier is now a
 * TYPED field — `tool_result.changeDirCwd` (stream) / `ToolTraceEntry.cwd`
 * (JSON) — populated from the raw, untruncated tool result, never from the
 * display summary, which is hard-truncated at `TOOL_LINE_SALIENT_MAX` and would
 * corrupt or erase long targets (adversarial review #470 Major). This helper
 * retains the raw/summarized marker parsing as defense-in-depth for legacy
 * carriers and enforces a strict success shape (`ok cwd=` present, no `ERROR`).
 * It also REJECTS any capture containing `…` — the exact slice artifact a
 * 160-char-clipped summary produces on a ≥67-char target — so a long path is
 * never persisted as `aaa…` (adversarial review #470 Major).
 */
export function parseChangeDirCwd(text: string | undefined): string | undefined {
  const t = (text ?? '').trim();
  if (!t) return undefined;
  if (/^ERROR\b/i.test(t)) return undefined;
  let value: string | undefined;
  // Raw success line: `change_dir <path>: ok cwd=<path>`.
  const direct = t.match(/^change_dir\s+\S+:\s*ok\s+cwd=(\S+)\s*$/i);
  if (direct) {
    value = direct[1];
  } else {
    // Summarized form: `change_dir · ✓ ok · <path> · cwd=<path>`.
    const summarized = t.match(/change_dir[^]*?\bcwd=(\S+)\s*$/i);
    if (summarized) value = summarized[1];
  }
  if (value === undefined) return undefined;
  // Truncation guard: a value produced by a clipped summary ends in `…`; that is
  // not a real directory name, so it is never returned or persisted.
  if (value.includes('…')) return undefined;
  return value;
}

/**
 * Turn-scoped confirmation that at least one `change_dir` succeeded, carrying the
 * last successfully-resolved workspace-relative cwd. Null (no `value`) until
 * proven by a tool result; multiple `change_dir` in one turn keep the model's
 * final position. Kept separate from the applied session `cwd` so a non-success
 * terminal can apply it only when the model actually moved (plan #465).
 */
export type LiveCwdSource = {
  value: string | undefined;
  source: string | undefined;
};

/**
 * Record a confirmed-`change_dir` cwd carried as a TYPED field (stream
 * `tool_result.changeDirCwd` / JSON `ToolTraceEntry.cwd`). The caller has already
 * gated on `name === 'change_dir'` + `ok === true`; an `undefined`/empty value or
 * a truncated `…` capture is ignored so the last confirmed value wins and a
 * failed/truncated marker never overwrites it within the turn.
 */
export function recordLiveCwd(
  state: LiveCwdSource,
  confirmedCwd: string | undefined,
): LiveCwdSource {
  if (confirmedCwd === undefined || confirmedCwd === '') return state;
  // Truncation guard — never persist a clipped capture.
  if (confirmedCwd.includes('…')) return state;
  return { value: confirmedCwd, source: 'confirmed' };
}

/**
 * Single authoritative session-cwd getter (P1/GAP-1, #452). Every agent turn reads
 * the workspace-relative logical cwd from here for the request (`sessionCwd`).
 * Per phase 2 (#465), the success path applies `agentResult.cwd` and a confirmed
 * `change_dir` also persists on cancel/timeout/hard-error (and as a success
 * fallback); chat-fallback keeps the prior known value (spread retention through
 * `appendMessage`). `.` when none known or when the stored cwd cannot be safely
 * sent to `/api/agent` (escapes the root) — default workspace-root semantics.
 */
export function getSessionCwd(snapshot: SessionSnapshot): string {
  return toSessionCwd(snapshot.cwd) ?? '.';
}

/**
 * Full agent turn: try /api/agent (tools) then optional chat fallback + session.
 */
export async function runHarnessTurn(
  bridge: HarnessBridge,
  session: SessionSnapshot,
  rawPrompt: string,
  opts?: RunHarnessTurnOptions,
): Promise<HarnessTurnResult> {
  const attaching = opts?.attach != null;
  if (!attaching) {
    const validation = validatePrompt(rawPrompt);
    if (validation) {
      bridge.pushMessage(MessageKind.Error, describeTurnEnd('validation', validation));
      const next = appendMessage(session, 'error', describeTurnEnd('validation', validation));
      completeTurn(bridge, false); // validation — no auto-promote
      return { result: { ok: false, error: validation }, session: next };
    }
  }

  const prompt = attaching ? '' : normalizePrompt(rawPrompt);
  const skipUserAppend = attaching || opts?.skipUserAppend === true;
  const withUser = skipUserAppend ? session : appendMessage(session, 'user', prompt);

  // Wasm pending-submit path sets pushUser:false (user line already in canvas).
  // Attach (E19) never re-pushes the user line — the ring was hydrated (cold)
  // or already has it (hot).
  const pushUser = attaching ? false : opts?.pushUser !== false;
  // Always schedule user-body images/math (Wasm may already show the user line).
  scheduleImagesFromMarkdown(bridge, prompt);
  scheduleMathFromMarkdown(bridge, prompt);
  const preferAgent = opts?.preferAgent !== false;
  const useHistory = opts?.useHistory !== false;
  // Plan #811 (D17): production defaults → /api/turns (durable-turn transport).
  // Tests inject sendAgent/sendAgentStream via opts to keep the legacy /api/agent path.
  const sendAgentFn = opts?.sendAgent ?? sendTurn;
  const sendAgentStreamFn = opts?.sendAgentStream ?? sendTurnStream;
  // Default: stream when using production client. Tests that only inject
  // `sendAgent` keep the JSON path unless streamAgent/sendAgentStream set.
  const streamAgent =
    opts?.streamAgent !== undefined
      ? opts.streamAgent
      : opts?.sendAgentStream != null || opts?.sendAgent == null;

  // Plan #936 (source #549): on the durable `/api/turns` path (production —
  // no injected legacy `sendAgent`/`sendAgentStream`), the server seeds the
  // orchestrator from the persisted model-messages projection, so the host
  // sends the RAW prompt (never the 3.5M-char fold). While the session has no
  // locally-observed `modelMessagesPointer` yet, the host ALSO sends the
  // `formatPromptWithHistory` fold as a `promptHistory` sidecar — the server
  // uses it as the roll-forward `userMessage` iff the envelope has no readable
  // pointer, else ignores it. Legacy/test paths (injected sendAgent*/local)
  // keep today's single folded `prompt` unchanged.
  const isDurableTurnPath = opts?.sendAgent == null && opts?.sendAgentStream == null;
  const historyFold =
    useHistory && session.messages.length > 0
      ? formatPromptWithHistory(session.messages, prompt)
      : undefined;
  const apiPrompt = isDurableTurnPath ? prompt : (historyFold ?? prompt);
  let promptHistory =
    isDurableTurnPath &&
    historyFold !== undefined &&
    session.modelMessagesPointer === undefined
      ? historyFold
      : undefined;
  // Combined Function-body budget (adversarial-review #937): prompt + sidecar
  // must stay under PROMPT_BODY_MAX_CHARS. The fold already includes the
  // current user line, so a maxed fold + fat prompt would 413. Trim the
  // sidecar tail (same policy as formatPromptWithHistory).
  if (promptHistory !== undefined) {
    const budget = PROMPT_BODY_MAX_CHARS - prompt.length;
    if (budget <= 0) promptHistory = undefined;
    else if (promptHistory.length > budget) {
      promptHistory = promptHistory.slice(promptHistory.length - budget);
      const nl = promptHistory.indexOf('\n');
      if (nl > 0 && nl < 240) promptHistory = promptHistory.slice(nl + 1);
    }
  }

  let userPushedOnBridge = false;

  if (preferAgent) {
    bridge.setLifecycle(Lifecycle.Busy);
    // Grouping predicate restores from the last persisted role so a reload turns
    // the same way a live turn does; a real user push then resets it to the
    // 'user' boundary (plan #364).
    let lastUiKind: LastUiKind = restoreLastUiKind(session.messages);
    if (pushUser) {
      bridge.pushMessage(MessageKind.User, prompt);
      lastUiKind = 'user';
      userPushedOnBridge = true;
    }

    let agentResult: AgentResult;
    let next = withUser;
    let assistantStarted = false;
    /** Full assistant text for session/result (all stream segments). */
    let assistantAcc = '';
    /**
     * Text for the currently open assistant ring bubble only.
     * Closed when a System tool line is pushed so post-tool deltas open a new
     * bubble — `inv_update_last_message` only rewrites the last ring row.
     */
    let assistantSegment = '';
    let assistantSegmentOpen = false;
    /**
     * Boundary whitespace buffered between streamed assistant segments (see
     * growAssistant). When a whitespace-only delta arrives after the previous
     * segment has been closed (e.g. by a tool), it is held here so it can be
     * reattached as LEADING whitespace on the next opened assistant segment —
     * keeping an inter-segment blank line on the canvas so it reconstitutes the
     * authoritative text exactly (#387 after-close residual). Never opens a
     * bubble on its own (plan #364).
     */
    let pendingAssistantWs = '';
    let thinkingSegment = '';
    let thinkingSegmentOpen = false;
    let sawStreamTerminal = false;
    let doneFinishReason: string | undefined;
    /**
     * This-turn durable SSE start. Set only in `onTurnStarted` (headers +
     * body accepted). Leftover completed/cancelling `turnRunId` on the session
     * must not count — that would freeze pre-headers retries (adversarial #844)
     * and JSON/HTTP errors that blend the run-id header never call
     * `onTurnStarted`. Incomplete durable read (no SSE `done`/`error`) is
     * D18 detach; retry after this flag is permanent (a second POST would
     * start a second Workflows run).
     */
    let sawDurableStart = false;
    /**
     * plan #759 / adversarial-review Major — once the LIVE stream has painted
     * ANY ring content past the user line (a tool card, assistant text, a
     * thinking row, a skill row), a later failure is NOT retryable: replaying
     * the same prompt onto the SAME ring would re-run tools (side-effect
     * duplication) and push duplicate bubbles. Monotonic — set once, never
     * reset within the turn, so any post-paint failure fails closed to
     * permanent single-attempt. A failure BEFORE anything painted (immediate
     * 5xx / network drop) stays cleanly retryable. JSON tests run the
     * non-stream path where `onStreamEvent` never fires, so this flag stays
     * false and the 5× loop is unchanged there.
     */
    let streamPainted = false;
    // Plan #813 (E19) — this-heap SSE-frame count. POST starts at 0; hot
    // resume starts at attach.startIndex; cold starts at 0. Incremented per
    // parsed event. Persisted only when onSessionPatch already fires (or at
    // turn end) — never a new HTTP per token.
    const attachOpts = opts?.attach;
    const dedup = attachOpts?.dedup === true;
    // Send-while-running (non-empty composer / promoted queue head) is a live
    // session: keep the Wasm FIFO. F21 (adversarial #901): kickColdAttach's
    // empty prompt is ALSO a live session — hydrateRingWindow already
    // clearMessages'd + re-armed from the persisted mirror; a preserveQueue
    // false here would inv_clear_messages the FIFO we just restored.
    // F5/switch stale-FIFO wipe is hydrateRingWindow's job, not this attach.
    const preserveQueue = attaching;
    let heapC = attachOpts != null
      ? (sanitizeTurnStreamCursor(attachOpts.startIndex) ?? 0)
      : 0;
    if (attaching && attachOpts) {
      next = {
        ...next,
        turnRunId: attachOpts.runId,
        turnStatus: next.turnStatus === 'completed' ? next.turnStatus : 'running',
        turnStreamCursor: heapC,
      };
    }
    /**
     * Send-while-running hot resume (adversarial #857): Wasm already painted the
     * follow-up user line before the host remapped Send to attach. Drop it so
     * live grow cannot sit under a prompt that was never POSTed. Cold attach
     * (dedup) rebuilds through the session last user via `pushSessionToBridge`
     * below — do not `hydrateMessages` here (that would skip image/math reset
     * and clear the submit queue as a surgical edit).
     * Empty `rawPrompt` (kickColdAttach / hot-resume microtask) leaves the
     * originating user.
     */
    if (attaching && !dedup && (rawPrompt ?? '').trim()) {
      const sessionLastUser = lastUserText(next.messages);
      try {
        const n = bridge.messageCount();
        const rows: { kind: MessageKind; text: string }[] = [];
        for (let i = 0; i < n; i++) {
          const m = bridge.messageAt(i);
          if (m) rows.push(m);
        }
        const stripped = withoutTrailingFollowUpUser(
          rows,
          (m) => m.kind === MessageKind.User,
          sessionLastUser,
        );
        if (stripped.length !== rows.length) {
          rebuildAttachRingFromRows(bridge, stripped, next);
        }
      } catch {
        /* tests / torn-down bridge */
      }
    }
    /**
     * Cold attach (dedup): Blob this-run suffix (`tool_run` / assistant) has no
     * thinking. Leaving it on the ring makes `reasoning_delta` append after the
     * answer (adversarial #857 Major). Rebuild this-run from the stream: keep a
     * persist backup, hydrate the ring through the last user via the canonical
     * `pushSessionToBridge` (reset image/math `putOk`, coalesce, slice, reschedule),
     * and let skip see an empty this-run window. Always re-hydrate the prefix
     * (even with no suffix) so a Wasm follow-up cannot remain as the last user
     * and so boot-scheduled images are re-put after the ring clear
     * (`inv_clear_ring` — attach always preserves the FIFO; F21 adversarial #901).
     */
    let coldBackup: typeof next.messages | null = null;
    if (attaching && dedup) {
      const prefix = prefixThroughLastUser(next.messages);
      if (prefix.length < next.messages.length) {
        coldBackup = next.messages;
        next = { ...next, messages: prefix };
        lastUiKind = restoreLastUiKind(next.messages);
      }
      try {
        pushSessionToBridge(bridge, next, {
          clear: true,
          windowStart: latestRingStart(next.messages.length),
          preserveQueue,
        });
      } catch {
        /* tests / torn-down bridge */
      }
    }

    const hydratedAssistantStart = dedup ? thisRunAssistantText(next.messages) : '';
    let hydratedAssistant = hydratedAssistantStart;
    const hydratedTools = dedup ? thisRunToolItems(next.messages) : [];
    const replayedStarts: Record<string, number> = {};
    const replayedResults: Record<string, number> = {};
    // Last confirmed-successful `change_dir` cwd this turn (phase 2 of #464 /
    // plan #465): recorded from live tool events (stream) or the JSON toolTrace,
    // applied on non-success terminals and as a success fallback so an aborted
    // turn where the model moved still boots the next turn where it worked.
    let liveCwd: LiveCwdSource = { value: undefined, source: undefined };

    // Tool-run aggregation (protocol v11 / #433). The host owns the SSE and
    // knows the structured `tool_result.ok`, so it aggregates each uninterrupted
    // tool-run into ONE display-only `tool_run` message (bridge kind 6, session
    // role `tool_run`) that paints LIVE: a tool event opens (or grows) exactly
    // ONE kind-6 card immediately — `1 tool called` → `2 tools called` → … — via
    // `inv_update_last_message` while the last ring row is a tool-run, else it
    // opens a fresh card at `1`. This replaces commit-once (#355 / #352 C):
    // tools are never withheld until assistant text / turn end.
    let toolRunGroup: ToolRunGroup = createToolRunGroup();

    /**
     * Live-paint grouping flag (#433 locked rule): whether the last ring row
     * this host wrote is its OWN open kind-6 tool card. True → grow that card
     * (`update_last`); false → push a fresh card at `1`. Set false by any
     * non-tool ring write (thinking / assistant / user / error / system) and by
     * a group-full roll (the just-pushed full card must never be grown). The
     * host is the sole ring writer, so this single boolean is the only predicate
     * needed; `updateLastMessage`'s return stays as insurance, never a decision.
     */
    let lastRingRowIsToolRun = attaching && lastUiKind === 'tool_run';
    /** Session id of the current open live tool card (patched in place on growth). */
    let openToolRunId: string | null = attaching && lastUiKind === 'tool_run'
      ? (next.messages[next.messages.length - 1]?.id ?? null)
      : null;

    if (attaching && lastUiKind === 'tool_run') {
      const last = next.messages[next.messages.length - 1];
      if (last?.role === 'tool_run') {
        const decoded = decodeToolRun(last.text);
        if (decoded) {
          toolRunGroup = {
            items: decoded.items.map((it) => ({ ...it })),
            detailEncUsed: 0,
          };
        }
      }
    }

    // Hot resume continues the last live ring row so a suffix `text_delta` /
    // `reasoning_delta` grows in place. Cold attach rebuilt through the last
    // user (above); last ring is that user line, not a hydrated assistant.
    if (attaching) {
      const n = bridge.messageCount();
      if (n > 0) {
        const lastRing = bridge.messageAt(n - 1);
        if (lastRing?.kind === MessageKind.Assistant) {
          assistantSegment = lastRing.text;
          assistantSegmentOpen = true;
          assistantStarted = true;
          lastUiKind = 'assistant';
          lastRingRowIsToolRun = false;
          if (!dedup) assistantAcc = lastRing.text;
        } else if (lastRing?.kind === MessageKind.Thinking) {
          thinkingSegment = lastRing.text;
          thinkingSegmentOpen = true;
          lastUiKind = 'thinking';
          lastRingRowIsToolRun = false;
        }
      }
    }
    // Authoritative per-turn cwd (P1/GAP-1, #452): one getter → one request value.
    const sessionCwd = getSessionCwd(session);

    // Session-owned active sandbox override (Redis-safe; server-validated).
    // Omitted when unset → server preference/single/selection logic.
    const sessionSandboxId = session.activeSandboxId;
    // Phase 3 (#488) session-carrier: the session id (Redis-safe) lets the agent
    // route find this session's `meta.personaSnapshot` on later turns, and the
    // bound persona id lets it resolve + snapshot the body on the first use.
    // Guarded Redis-safe so a hostile/local id can never be smuggled into the
    // body (same fail-closed rule as the server's `parseSessionId`).
    const sessionId = isRedisSafeOpaqueId(session.id) ? session.id : undefined;
    const boundPersonaId =
      typeof session.personaId === 'string' &&
      isRedisSafeOpaqueId(session.personaId)
        ? session.personaId
        : undefined;

    // plan #759 — a retryable turn failure retries the SAME send up to
    // TURN_RETRY_ATTEMPTS (5) with bounded exponential backoff, reusing
    // `withTransientRetry` via its additive `classify` seam. The user line is
    // already on the ring; nothing re-promotes or sets Ready between attempts —
    // the lifecycle stays Busy for the whole retry window. A non-ok AgentResult
    // becomes an AgentRetryError so the narrow classifier can map retryable vs
    // permanent from HTTP status + classifyTurnFailure kind.

    // E20 (plan #814) — build the shared ApplyContext once. Writers live on
    // the ctx so `lib/turnApply.ts` never value-imports this module (E19
    // turnAttach rule): `patchSession` (#857 cold-backup gate), fold/push/git
    // refresh, collapse/truncate, `recordLiveCwd`. BOTH producers (attach +
    // legacy stream) pass the SAME `onStreamEvent` from `createApplyTurnEvent`
    // — behavior parity is by construction.
    const applyCtx: TurnApplyCtx = {
      next,
      heapC,
      streamPainted,
      dedup,
      hydratedAssistant,
      hydratedTools,
      replayedStarts,
      replayedResults,
      toolRunGroup,
      openToolRunId,
      lastRingRowIsToolRun,
      lastUiKind,
      assistantStarted,
      assistantAcc,
      assistantSegment,
      assistantSegmentOpen,
      pendingAssistantWs,
      thinkingSegment,
      thinkingSegmentOpen,
      sawStreamTerminal,
      doneFinishReason,
      liveCwd,
      foldStatusSlots,
      pushSkillRow,
      refreshGitStatusSlot,
      collapseThinkingDisplay,
      truncateThinkingDisplay,
      truncateToolTraceSummary,
      recordLiveCwd,
      patchSession: (s) => {
        // Mid-attach patches must not PUT a truncated (prefix-only) transcript
        // over Blob. Once this-run has painted, `s.messages` is the live rebuild
        // — persist that, not the boot-time suffix (adversarial #857).
        if (coldBackup && !applyCtx.streamPainted) {
          opts?.onSessionPatch?.({ ...s, messages: coldBackup });
          return;
        }
        opts?.onSessionPatch?.(s);
      },
      signal: opts?.signal,
    };
    const patchSession = (s: typeof next) => applyCtx.patchSession(s);
    const onStreamEvent = createApplyTurnEvent(bridge, applyCtx);

    try {
      agentResult = await withTransientRetry(
        async () => {
          if (attachOpts) {
            const attachFn = attachOpts.attachStream ?? attachTurnStream;
            if (!sessionId) {
              return {
                ok: false as const,
                status: 400,
                error: 'sessionId is required.',
              };
            }
            const r = await attachFn(attachOpts.runId, {
              sessionId,
              startIndex: attachOpts.startIndex,
              signal: opts?.signal,
              onEvent: onStreamEvent,
              onTurnStarted: async ({ turnRunId }) => {
                sawDurableStart = true;
                // E20 (#814): the ctx owns the session during the stream —
                // mutate the state bag so it stays authoritative.
                applyCtx.next = {
                  ...applyCtx.next,
                  turnRunId,
                  turnStatus:
                    applyCtx.next.turnStatus === 'completed'
                      ? 'completed'
                      : 'running',
                  turnStreamCursor: applyCtx.heapC,
                };
                applyCtx.patchSession(applyCtx.next);
              },
            });
            if (!r.ok) {
              const kind = classifyTurnFailure(r.error, r.status, opts?.signal).kind;
              throw new AgentRetryError(
                r.error,
                r.status,
                kind,
                r.attachedSlugs,
                r.turnRunId,
              );
            }
            return r;
          }
          const r = streamAgent
            ? await sendAgentStreamFn(apiPrompt, {
                signal: opts?.signal,
                modelId: opts?.modelId,
                ...(opts?.reasoning ? { reasoning: opts.reasoning } : {}),
                cwd: sessionCwd,
                ...(sessionId ? { sessionId } : {}),
                ...(boundPersonaId ? { personaId: boundPersonaId } : {}),
                ...(sessionSandboxId ? { sandboxId: sessionSandboxId } : {}),
                ...(promptHistory !== undefined ? { promptHistory } : {}),
                onEvent: onStreamEvent,
                onTurnStarted: async ({ turnRunId }) => {
                  sawDurableStart = true;
                  // E20 (#814): the ctx owns the session during the stream —
                  // mutate the state bag, not the stale local.
                  applyCtx.next = {
                    ...applyCtx.next,
                    turnRunId,
                    turnStatus: 'running',
                    turnStreamCursor: applyCtx.heapC,
                  };
                  applyCtx.patchSession(applyCtx.next);
                },
              })
            : await sendAgentFn(apiPrompt, {
                signal: opts?.signal,
                modelId: opts?.modelId,
                ...(opts?.reasoning ? { reasoning: opts.reasoning } : {}),
                cwd: sessionCwd,
                ...(sessionId ? { sessionId } : {}),
                ...(boundPersonaId ? { personaId: boundPersonaId } : {}),
                ...(sessionSandboxId ? { sandboxId: sessionSandboxId } : {}),
                ...(promptHistory !== undefined ? { promptHistory } : {}),
              });
          if (!r.ok) {
            const kind = classifyTurnFailure(r.error, r.status, opts?.signal).kind;
            throw new AgentRetryError(
              r.error,
              r.status,
              kind,
              r.attachedSlugs,
              r.turnRunId,
            );
          }
          return r;
        },
        {
          // 5 attempts total = 1 initial send + 4 retries (plan #759 TURN_RETRY_ATTEMPTS).
          retries: TURN_RETRY_ATTEMPTS - 1,
          baseMs: TURN_RETRY_BASE_MS,
          capMs: TURN_RETRY_CAP_MS,
          signal: opts?.signal,
          // Fail-closed gate (adversarial-review Major): once `streamPainted`,
          // no failure is retryable — replaying the same prompt onto the SAME
          // ring would re-run just-painted tools (side-effect duplication) and
          // push duplicate assistant bubbles. `classifyTurnRetry` still owns
          // the status/stop mapping for the clean (never-painted) cases.
          // E20 (#814): read the LIVE ctx flag — the apply consumer arms it
          // during the stream.
          classify: (err) =>
            applyCtx.streamPainted || sawDurableStart || attaching
              ? { kind: 'permanent' }
              : classifyTurnRetry(err),
        },
      );
    } catch (err) {
      // Permanent status / Stop / exhausted retryable / abort during backoff.
      agentResult = agentFailureFromRetry(err);
    }

    // E20 (#814): re-sync the turn-scope locals from the shared apply ctx —
    // the state bag is authoritative after the stream (both producers mutated
    // it through `onStreamEvent`).
    next = applyCtx.next;
    heapC = applyCtx.heapC;
    streamPainted = applyCtx.streamPainted;
    assistantStarted = applyCtx.assistantStarted;
    assistantAcc = applyCtx.assistantAcc;
    assistantSegment = applyCtx.assistantSegment;
    assistantSegmentOpen = applyCtx.assistantSegmentOpen;
    thinkingSegment = applyCtx.thinkingSegment;
    thinkingSegmentOpen = applyCtx.thinkingSegmentOpen;
    sawStreamTerminal = applyCtx.sawStreamTerminal;
    doneFinishReason = applyCtx.doneFinishReason;
    liveCwd = applyCtx.liveCwd;
    toolRunGroup = applyCtx.toolRunGroup;
    openToolRunId = applyCtx.openToolRunId;
    lastRingRowIsToolRun = applyCtx.lastRingRowIsToolRun;
    lastUiKind = applyCtx.lastUiKind;

    // Safety net: collapse open thinking when the stream ends without a terminal
    // SSE event (abort, network drop, empty body). Mid-stream closes already ran
    // for tool/text/done/error; this is a no-op when the segment is already closed.
    closeThinkingSegment(bridge, applyCtx);

    if (agentResult.ok && isProviderRefusalFinish(doneFinishReason)) {
      agentResult = {
        ok: false,
        error: truncatedFinishError(doneFinishReason),
        ...('turnRunId' in agentResult && agentResult.turnRunId
          ? { turnRunId: agentResult.turnRunId }
          : {}),
      };
    }

    const stopKind = !agentResult.ok
      ? classifyTurnFailure(
          agentResult.error,
          agentResult.status,
          opts?.signal,
        ).kind
      : undefined;
    const durableIncomplete =
      (streamAgent || attaching) &&
      sawDurableStart &&
      !sawStreamTerminal &&
      stopKind !== 'stop';

    if (agentResult.ok && !durableIncomplete) {
      // Live tool cards are already painted + session-mirrored on each event;
      // this clears the live state so the JSON/toolTrace fallback below (when
      // present) is the only writer. No re-push of an already-committed card.
      resetLiveToolStreak(applyCtx);
      if (!streamAgent || !sawStreamTerminal) {
        // JSON path (or stream that returned JSON): aggregate end-of-turn
        // toolTrace into display-only tool_run group(s) instead of System lines;
        // skip if empty.
        const groups = buildTraceGroups(agentResult.toolTrace);
        for (const group of groups) {
          const payload = encodeToolRun(group);
          if (!payload) continue;
          bridge.pushMessage(MessageKind.ToolRun, payload);
          next = appendMessage(next, 'tool_run', payload);
        }
        // Phase 2 (#517): the JSON (non-stream) path carries skill outcomes on
        // `skillEvents` (SSE surfaces them as live events instead). Push the
        // display-only rows so the transcript shows the skill name, matching the
        // stream path exactly.
        if (agentResult.skillEvents) {
          for (const ev of agentResult.skillEvents) {
            lastRingRowIsToolRun = false;
            lastUiKind = 'assistant';
            next = pushSkillRow(bridge, next, ev);
          }
        }
        // Phase 2 (#517 / adversarial-review): fold the session-sticky skill set
        // from the JSON response so the host persists it as `meta.attachedSkills`
        // on the next PUT (stream path folds it live on each skill_attached event).
        // Present `[]` = explicit detach-all; omitted = leave the existing set.
        if (Array.isArray(agentResult.attachedSlugs)) {
          next = { ...next, attachedSlugs: [...agentResult.attachedSlugs] };
        }
        if (!assistantStarted) {
          bridge.pushMessage(MessageKind.Assistant, agentResult.text);
          assistantStarted = true;
        } else {
          bridge.updateLastMessage(MessageKind.Assistant, agentResult.text);
        }
        // JSON (non-stream) path ends with the same 'assistant' end state as the
        // stream path so the predicate stays the single driver (plan #364).
        lastUiKind = 'assistant';
        scheduleImagesFromMarkdown(bridge, agentResult.text);
        assistantAcc = agentResult.text;
      }
      next = attaching
        ? foldThisRunAssistant(next, agentResult.text || assistantAcc)
        : appendMessage(next, 'assistant', agentResult.text || assistantAcc);
      scheduleMathFromTexts(
        bridge,
        next.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => m.text),
      );
      if (
        !attaching ||
        !thisRunWindow(next.messages).some((m) => isTurnEndLine(m.text))
      ) {
        next = pushTurnEnd(bridge, next, 'model');
      }
      lastUiKind = 'system';
      // Success-path cwd apply (parent #270 / phase 2): prefers the authoritative
      // `agentResult.cwd`. Sanitize + renormalize exactly like the send path
      // (GAP-1 review #453): an unsanitary `agentResult.cwd` (host-absolute /
      // escaping `..`) is dropped rather than persisted as a sticky value that
      // would 400 every future turn. Plan #465: when the authoritative value is
      // absent but a `change_dir` was confirmed this turn, fall back to the live
      // cwd so a success that omits `cwd` never silently re-retains the stale one.
      // Stream turns already captured `liveCwd` from live events; a JSON success
      // (no live events) derives it from the end-of-turn toolTrace `cwd` TYPED
      // field (last confirmed `change_dir` wins) before the fallback. Never
      // re-derive from the truncated toolTrace `summary` (#470 Major).
      let successCwd = liveCwd;
      if (!streamAgent) {
        let fromTrace: LiveCwdSource = { value: undefined, source: undefined };
        for (const entry of agentResult.toolTrace ?? []) {
          if (entry.name === 'change_dir' && entry.ok) {
            fromTrace = recordLiveCwd(fromTrace, entry.cwd);
          }
        }
        successCwd = fromTrace.value !== undefined ? fromTrace : successCwd;
      }
      const appliedCwd =
        toSessionCwd(agentResult.cwd) ??
        (successCwd.value !== undefined ? toSessionCwd(successCwd.value) : undefined);
      if (appliedCwd !== undefined) {
        next = { ...next, cwd: appliedCwd };
      }
      // Success-path active-bind reconcile (authoritative server resolution):
      // the turn ran against the resolved bind. Fold the POST-TURN EFFECTIVE
      // bind — `agentResult.activeSandboxId` (switch target when the turn
      // switched, else the resolved `sandboxId`; blocker B1 / #532 A2 wire) —
      // onto the session's `activeSandboxId` so a `meta_sandbox_switch` survives
      // the fold/PUT. Previously the host folded the PRE-turn `sandboxId`, which
      // silently overwrote a freshly-persisted switch (the very B1 bug). Fall
      // back to `sandboxId` only when the wire field is absent (pre-wire /
      // parity). Only sanitized Redis-safe values persist (local SoT).
      const foldBind = agentResult.activeSandboxId ?? agentResult.sandboxId;
      if (foldBind != null && isRedisSafeOpaqueId(foldBind)) {
        next = { ...next, activeSandboxId: foldBind };
      }
      // Phase 3 (plan #539 / #327): a COMPLETED turn always writes its OWN usage
      // onto the session — present paints the context slot, absent CLEARS it to
      // the locked default-hidden (never a stale prior value). The fail path
      // below deliberately does NOT touch `usage`, so an aborted/cancelled turn
      // keeps its last honest value.
      next = { ...next, usage: agentResult.usage };
      if (agentResult.resolvedProvider) {
        next = { ...next, resolvedProvider: agentResult.resolvedProvider };
      }
      // Plan #811 (D17) — fold durable-turn fields onto the session.
      // `turnRunId` is populated by /api/turns (absent for /api/agent — tests).
      if (agentResult.turnRunId !== undefined) {
        next = {
          ...next,
          turnRunId: agentResult.turnRunId,
          turnStatus: 'completed',
          turnStreamCursor: 0,
        };
      }
      // Protocol v13 (plan #538/#541): after a successful turn, fold the
      // effective bind + cwd into the status-slot pack so the canvas header
      // reflects the post-turn state (incl. a `meta_sandbox_switch`).
      foldStatusSlots(bridge, next);
      // Phase 2 (plan #540) — post-turn git refresh: a committed `change_dir`
      // (or any turn) may have moved the bind workspace branch; re-fetch the git
      // slot right after the fold instead of waiting for the cadence tick.
      // Fail-soft; server rate-limited; never blocks the turn return.
      void refreshGitStatusSlot(bridge, next, opts?.signal);
      completeTurn(bridge, true); // success — auto-promote allowed
      return {
        result: { ok: true, text: agentResult.text || assistantAcc },
        session: next,
        streamOpened: sawDurableStart,
      };
    }

    // Any failed agent turn hard-fails — never fall back to chat.
    {
      // Persist any live tool-run group (display-only, plan #345). Caveat: the
      // aggregated `tool_run` is NOT folded back into the model prompt, so a
      // continue-after-stall turn no longer re-sends tool summaries — the model
      // sees only the persisted assistant prose and may re-run tools or infer
      // results. That is a documented product rule (docs/harness-limits.md); a
      // "continue / finish that" prompt after a mid-tool cancel is the one path
      // most likely to trigger a re-run. We still persist the group so the
      // transcript + Copy show exactly what ran.
      // Live tool cards are already painted + session-mirrored on each event, so
      // the partial live tools persist before abort. Clear live state only — no
      // re-push of already-committed cards.
      resetLiveToolStreak(applyCtx);
      let failedSession = next;
      // Phase 2 (#517 / "fold-before-persist incl. fail/cancel"): the server
      // sends the session's current sticky set on error bodies too, so a FAILED
      // turn still persists the set that was attached before the model errored.
      // On the stream path the skill_attached events already folded it into
      // `next`; this catches the JSON path (and is a no-op when neither exists).
      if (Array.isArray(agentResult.attachedSlugs)) {
        failedSession = {
          ...failedSession,
          attachedSlugs: [...agentResult.attachedSlugs],
        };
      }
      const partial = (assistantAcc || '').trim();
      if (partial) {
        failedSession = attaching
          ? foldThisRunAssistant(failedSession, partial)
          : appendMessage(failedSession, 'assistant', partial);
      }
      const fail = durableIncomplete
        ? { kind: 'detach' as const, detail: undefined as string | undefined }
        : classifyTurnFailure(
            agentResult.ok ? 'Stream ended without a terminal event.' : agentResult.error,
            agentResult.ok ? undefined : agentResult.status,
            opts?.signal,
          );
      // Adversarial #857: subscribe-fail is "could not open a readable"
      // (`!sawDurableStart`), not every non-404. 404 = run gone → Turn ended
      // + Error + clear `running`. 503/401/network before onTurnStarted →
      // D18-shaped persist (keep `running`, Ready, no Turn-ended) +
      // non-terminal EMBER. After onTurnStarted, producer SSE error / 5xx
      // reuses the POST give-up fold. EOF without terminal stays D18 via
      // durableIncomplete.
      // Attach Stop/Esc is G22 server cancel (plan #816 / punch-list): fold
      // `'cancelling'` + Turn-ended only after an accepted cancel abort
      // (`G22_ACCEPTED_ABORT_REASON`). A raw abort before ack keeps `running`
      // with no stop line so F5 can attach. Producer cancelled SSE
      // (`Request cancelled.` without abort) is a **terminal** Stop fold —
      // clear `running` (plan #919 / source #918).
      const attachSubscribeFail =
        attaching &&
        !sawDurableStart &&
        fail.kind !== 'stop' &&
        fail.kind !== 'detach' &&
        !isAttachRunGone(agentResult.ok ? undefined : agentResult.status);
      // Raw abort on a live durable id before the cancel POST was accepted.
      // Keep `running`, no Turn-ended line (punch-list items 1–2).
      const abortBeforeAck =
        fail.kind === 'stop' &&
        opts?.signal?.aborted === true &&
        !isG22AcceptedAbort(opts?.signal) &&
        failedSession.turnRunId !== undefined &&
        (failedSession.turnStatus === 'running' ||
          failedSession.turnStatus === 'cancelling');
      // Cold-attach strip: persist the Blob suffix only when nothing was
      // painted (503/404 before events) so we do not LWW a user-only
      // transcript. Thinking-only incomplete GET must keep the stripped
      // prefix — thinking is not in SessionStore, so thisRunWindow stays
      // empty and restoring the suffix would duplicate tools on the
      // automatic hot resume at C (adversarial #857).
      if (coldBackup && !streamPainted) {
        failedSession = { ...failedSession, messages: coldBackup };
        try {
          pushSessionToBridge(bridge, failedSession, {
            clear: true,
            windowStart: latestRingStart(failedSession.messages.length),
            preserveQueue,
          });
        } catch {
          /* tests / torn-down bridge */
        }
      }
      if (attachSubscribeFail) {
        const line = (
          agentResult.ok
            ? 'Stream ended without a terminal event.'
            : agentResult.error || 'Unable to attach to run stream.'
        ).trim();
        failedSession = paintSubscribeFail(bridge, failedSession, line);
      } else if (fail.kind !== 'detach' && !abortBeforeAck) {
        failedSession = pushTurnEnd(bridge, failedSession, fail.kind, fail.detail);
      }
      // Phase 2 (#465): a cancel/timeout/hard-error turn still persists the last
      // confirmed `change_dir` cwd (before the abort) so the next turn boots where
      // the model actually worked. When no `change_dir` was confirmed, `liveCwd`
      // is undefined and the prior value is retained (today's behavior).
      // Adversarial-review #470 note (accepted residual): `liveCwd` is populated
      // only by live stream events, so a non-stream (JSON) turn that confirms a
      // `change_dir` then fails keeps the prior cwd — `AgentFailure` carries no
      // toolTrace to recover it from. Production harness always streams; a
      // JSON-failure turn is test-only / hyper-edge.
      if (liveCwd.value !== undefined) {
        const failedLiveCwd = toSessionCwd(liveCwd.value);
        if (failedLiveCwd !== undefined) {
          failedSession = { ...failedSession, cwd: failedLiveCwd };
        }
      }
      // Hard 403 of the grant-honesty class with a set-but-unusable active
      // sandbox → clear the stale session binding so the next turn honestly
      // re-resolves from preference / selection instead of re-sending a poison
      // id (which would 403-loop). The host keeps local session as the source of
      // truth; Settings → Sandbox guidance surfaces the re-select.
      //
      // Scoped to the selection-required / forbidden class ONLY (adversarial
      // review #484 Major): a 403 WORKSPACE_INSTANCE_REQUIRED is a softContinue
      // operational bind (usable grant whose Workspace instance is down/stopped),
      // NOT an unusable grant. Wiping the bind there would silently re-resolve to
      // the preferred/single grant on the next turn — a silent sandbox switch.
      if (
        !agentResult.ok &&
        agentResult.status === 403 &&
        failedSession.activeSandboxId !== undefined &&
        (agentResult.error === SANDBOX_SELECTION_REQUIRED_ERROR ||
          agentResult.error === SANDBOX_FORBIDDEN_ERROR)
      ) {
        failedSession = { ...failedSession, activeSandboxId: undefined };
      }
      // Plan #811 (D17) — clear durable-turn fields on failure, except a
      // durable *detach* of *this* turn (plan #812 / adversarial #844): keep
      // `turnRunId` + `running` so E19 can re-attach. Leftover `completed` /
      // `cancelling` from a prior D17 turn must stay as-is — pre-headers
      // AbortError omits `turnRunId`, and forcing `running` on the old id
      // would LWW-resurrect a finished run.
      // Stop/Esc after `onTurnStarted` (adversarial #844): production abort
      // used to omit `turnRunId` even after headers, so the planted-id clear
      // never fired and live persist left C15 `running`. Clear this-turn
      // `running` on `'stop'` even when the result omits the id. Do not clear
      // on generic error/timeout without a result id (network drop after
      // headers stays attach-ready).
      // Attach 503/401/network before onTurnStarted (adversarial #857): same
      // keep-running as detach — could not subscribe ≠ the turn died. After
      // onTurnStarted, producer SSE error reuses the POST give-up fold
      // (clear `running`). Attach 404 (run gone) falls through and clears
      // so C15 does not 409 a dead id.
      // Attach Stop/Esc is G22 (plan #816 / punch-list): keep-running on
      // abort-before-ack. Accepted cancel (`G22_ACCEPTED_ABORT_REASON`) falls
      // through to the cancelling / Turn-ended fold.
      if (fail.kind === 'detach' || attachSubscribeFail || abortBeforeAck) {
        const id =
          agentResult.turnRunId ??
          (failedSession.turnStatus === 'running'
            ? failedSession.turnRunId
            : undefined);
        if (id !== undefined) {
          failedSession = {
            ...failedSession,
            turnRunId: id,
            turnStatus: 'running',
          };
        }
      } else if (
        agentResult.turnRunId !== undefined ||
        (fail.kind === 'stop' &&
          // Enter the fold for a this-turn live stop (`running`) OR a legacy
          // stop with no durable id at all (fold `completed`). A leftover
          // TERMINAL id (`completed`/`cancelling`) from a PRIOR turn is NOT
          // this turn's — pre-headers Stop must not clear it (adversarial
          // #844), so skip the fold and leave it as-is.
          (failedSession.turnStatus === 'running' ||
            failedSession.turnRunId === undefined))
      ) {
        // Plan #816 (G22) — fold `'cancelling'` only after the cancel POST
        // was accepted (host aborts with `G22_ACCEPTED_ABORT_REASON`). A raw
        // abort before ack keeps `running` (handled above). Producer
        // `Request cancelled.` with no abort still clears the id (the run is
        // already terminal). The old `turnRunId: undefined` + `completed`
        // fold survives for the legacy `/api/agent` path (no live run id).
        const keepCancelling =
          fail.kind === 'stop' &&
          isG22AcceptedAbort(opts?.signal) &&
          (failedSession.turnStatus === 'running' ||
            failedSession.turnStatus === 'cancelling') &&
          failedSession.turnRunId !== undefined;
        failedSession = keepCancelling
          ? { ...failedSession, turnStatus: 'cancelling' }
          : {
              ...failedSession,
              turnRunId: undefined,
              turnStatus: 'completed',
            };
      }
      lastUiKind =
        attachSubscribeFail ||
        fail.kind === 'error' || fail.kind === 'timeout' ||
        fail.kind === 'empty' || fail.kind === 'validation'
          ? 'error'
          : 'system';
      // Protocol v13 (plan #538/#541) fail-path fold (PR #543 L1 Major): the
      // success reconcile folds status slots, but a FAILED agent turn never did —
      // leaving the Wasm header showing a STALE sandbox/cwd. On this fail path
      // the session already mutated: a 403 grant-honesty clear set
      // `failedSession.activeSandboxId` to undefined, and a cancel/timeout/error
      // turn committed the last confirmed `change_dir` cwd into
      // `failedSession.cwd`. Folding now repaints the header to match — clears a
      // cleared bind, shows the boot cwd the next turn will actually use, and is
      // a harmless idempotent re-paint when nothing changed.
      foldStatusSlots(bridge, failedSession);
      // Phase 2 (plan #540): a failed/cancelled turn can still commit a
      // confirmed `change_dir` (which may move the bind workspace branch);
      // refresh the git slot alongside the fail fold. Fail-soft; server
      // rate-limited; never blocks the fail return.
      //
      // Deliberately OMIT `opts?.signal` here (adversarial review #544 Minor
      // L1): the success path forwards it because a success turn is never
      // aborted, but this fail path is reached EXACTLY when the caller's signal
      // may already be ABORTED — a user Stop. Forwarding that aborted signal
      // onto `fetch` makes it reject instantly with `AbortError`, the `catch`
      // keeps last, and this post-cancel refresh becomes a dead no-op (the git
      // slot stays stale up to the cadence tick, contradicting the intent to
      // repaint on cancel). The unscoped fetch is bounded by the fail-soft
      // catch; it only repaints one slot once.
      void refreshGitStatusSlot(bridge, failedSession);
      // plan #759 — arms the promote gate false (plan #760) then lands give-up
      // on Error (never consumes the queue head; Continue inserted at head when
      // non-empty) unless this was an operator Stop, which stays Ready (queue
      // untouched, drains only on a later success).
      setFailLifecycle(bridge, attachSubscribeFail ? 'detach' : fail.kind);
      return {
        result: {
          ok: false,
          error: agentResult.ok
            ? 'Stream ended without a terminal event.'
            : agentResult.error,
          ...(agentResult.ok ? {} : { status: agentResult.status }),
        },
        session: failedSession,
        streamOpened: sawDurableStart,
      };
    }
  }

  // preferAgent:false → standalone chat helper (no agent turn here).
  const result = await runHarnessChat(bridge, prompt, {
    signal: opts?.signal,
    send: opts?.send,
    pushUser: pushUser && !userPushedOnBridge,
    history: session.messages,
    useHistory: opts?.useHistory,
    modelId: opts?.modelId,
  });

  if (result.ok) {
    let sess = appendMessage(withUser, 'assistant', result.text);
    sess = appendMessage(sess, 'system', describeTurnEnd('chat'));
    // Phase 3 (plan #539 / #327): the chat path is a completion — fold its
    // usage (present paints, absent clears-hides), never a stale prior value.
    sess = { ...sess, usage: result.usage };
    foldStatusSlots(bridge, sess);
    return { result, session: sess };
  }
  const fail = classifyTurnFailure(result.error, result.status, opts?.signal);
  // runHarnessChat already painted the end reason on the bridge. The fail/cancel
  // path leaves `usage` untouched (carries the prior honest value forward); fold
  // so the header stays consistent with the session.
  let sess = appendMessage(
    withUser,
    fail.kind === 'stop' ? 'system' : 'error',
    describeTurnEnd(fail.kind, fail.detail),
  );
  foldStatusSlots(bridge, sess);
  return { result, session: sess };
}
