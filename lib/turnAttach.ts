/**
 * Plan #813 (E19) — attach-handshake helpers (classify + this-run-window dedup).
 *
 * Pure + unit-testable. Not `applyTurnEvent` (that is E20 #814). The host
 * GET client lives in `turnApi.attachTurnStream`; live grow stays inline in
 * `runHarnessTurn`.
 *
 * Caps: none added or changed. Reuses `TURN_STREAM_CURSOR_MAX` / A3 sanitize.
 */
import type { AgentStreamEvent } from './agent/agentStream';
import type { SessionMessage, SessionSnapshot } from './sessionStore';
import { appendMessage } from './sessionStore';
import { decodeToolRun } from './toolRun';
import {
  sanitizeTurnStreamCursor,
  type TurnStatus,
} from './sessionCloudCaps';

export type HeapApplied = { runId: string; count: number };

export type AttachDecision =
  | { kind: 'none' }
  | { kind: 'hot'; startIndex: number }
  | { kind: 'cold'; startIndex: 0 };

/**
 * Classify hot resume vs cold attach by **this heap's ring**, not envelope `C`.
 *
 * - No live run → none (do not attach completed sessions on boot).
 * - Heap has not applied this `turnRunId` (F5 / login / new tab / switch) → cold
 *   at `startIndex=0`, even if envelope `C` is large.
 * - Same-heap live ring → hot resume at **heap-applied** count. Envelope `C` is
 *   a persist hint, not a skip: another tab's LWW write must not force a cold
 *   replay (or skip reconnect) while this ring already has `[0, applied)`.
 */
export function decideAttachClass(input: {
  turnRunId?: string;
  turnStatus?: TurnStatus;
  envelopeCursor?: number;
  heapApplied: HeapApplied | null;
}): AttachDecision {
  if (input.turnStatus !== 'running' || !input.turnRunId) {
    return { kind: 'none' };
  }
  const heap = input.heapApplied;
  const sameRun = heap != null && heap.runId === input.turnRunId;
  if (!sameRun) {
    return { kind: 'cold', startIndex: 0 };
  }
  const startIndex = sanitizeTurnStreamCursor(heap.count) ?? 0;
  return { kind: 'hot', startIndex };
}

/**
 * C16 GET 404 = run gone or ownership mismatch. Every other attach HTTP
 * failure (503 store, 401 auth, 5xx, network with no status) is "could not
 * subscribe" — the workflow may still be live (adversarial #857).
 */
export function isAttachRunGone(status?: number): boolean {
  return status === 404;
}

/**
 * After a fold that left `running`, should this heap hot-resume?
 *
 * - POST (no `attachStart`): reconnect at heap C when same-heap hot.
 * - GET attach: only if this heap applied frames **past** `attachStart`
 *   (empty-EOF GET must not spin).
 * - Cold / none → do not reconnect here (F5/boot is `kickColdAttach`).
 */
export function decideHotResume(input: {
  turnRunId?: string;
  turnStatus?: TurnStatus;
  envelopeCursor?: number;
  heapApplied: HeapApplied | null;
  attachStart?: number;
}): Extract<AttachDecision, { kind: 'hot' }> | { kind: 'none' } {
  const cls = decideAttachClass(input);
  if (cls.kind !== 'hot') return { kind: 'none' };
  const attachStart = input.attachStart;
  const applied = input.heapApplied;
  const progressed =
    attachStart === undefined ||
    (applied != null && applied.count > attachStart);
  if (!progressed) return { kind: 'none' };
  return cls;
}

/**
 * Messages after the last `user` row — the prompt that started this `turnRunId`.
 * Historical assistant / tool_run / skill_attached before that line are never
 * skip targets.
 */
export function thisRunWindow(messages: SessionMessage[]): SessionMessage[] {
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') lastUser = i;
  }
  if (lastUser < 0) return [];
  return messages.slice(lastUser + 1);
}

export function thisRunAssistantText(messages: SessionMessage[]): string {
  let acc = '';
  for (const m of thisRunWindow(messages)) {
    if (m.role === 'assistant') acc += m.text;
  }
  return acc;
}

export type TextDedupAction =
  | { action: 'grow'; chunk: string }
  | { action: 'skip' }
  | { action: 'grow-suffix'; chunk: string };

/**
 * Cold-attach `text_delta` rule. `reasoning_delta` is never skipped (caller).
 * Hydrated assistant is the this-run window only — a prior-turn assistant is
 * not a skip target (`thisRunAssistantText` already scoped).
 */
export function textDeltaDedup(opts: {
  enabled: boolean;
  hydratedAssistant: string;
  replayedBefore: string;
  chunk: string;
}): TextDedupAction {
  if (!opts.enabled) return { action: 'grow', chunk: opts.chunk };
  const replayed = opts.replayedBefore + opts.chunk;
  const hydrated = opts.hydratedAssistant;
  if (!hydrated) return { action: 'grow', chunk: opts.chunk };
  if (replayed === hydrated || hydrated.startsWith(replayed)) {
    return { action: 'skip' };
  }
  if (replayed.startsWith(hydrated)) {
    const suffix = replayed.slice(hydrated.length);
    if (!suffix) return { action: 'skip' };
    return { action: 'grow-suffix', chunk: suffix };
  }
  return { action: 'grow', chunk: opts.chunk };
}

export type HydratedToolItem = { name: string; status: 'running' | 'ok' | 'fail' };

/** Flatten this-run `tool_run` cards into ordinal items (name + status). */
export function thisRunToolItems(messages: SessionMessage[]): HydratedToolItem[] {
  const out: HydratedToolItem[] = [];
  for (const m of thisRunWindow(messages)) {
    if (m.role !== 'tool_run') continue;
    const decoded = decodeToolRun(m.text);
    if (!decoded) continue;
    for (const it of decoded.items) {
      out.push({ name: it.name, status: it.status });
    }
  }
  return out;
}

/**
 * 1-based ordinal of `name` among items `[0, seenCount)` plus this event.
 * `seenCount` is how many tool events (start or result, caller picks) of this
 * name have already been replayed.
 */
function ordinalOf(
  items: HydratedToolItem[],
  name: string,
  replayedOfName: number,
): HydratedToolItem | undefined {
  let n = 0;
  for (const it of items) {
    if (it.name !== name) continue;
    n += 1;
    if (n === replayedOfName) return it;
  }
  return undefined;
}

/**
 * Skip re-push of a `tool_start` when this-run hydrate already has that call.
 * Still apply when the ordinal is missing (live suffix).
 */
export function shouldSkipToolStart(opts: {
  enabled: boolean;
  hydrated: HydratedToolItem[];
  name: string;
  /** 1-based count of `tool_start`s for `name` including this event. */
  replayedStartsOfName: number;
}): boolean {
  if (!opts.enabled) return false;
  const hit = ordinalOf(opts.hydrated, opts.name, opts.replayedStartsOfName);
  return hit !== undefined;
}

/**
 * Skip a `tool_result` only when the hydrated ordinal is already terminal.
 * A hydrated `running` card must still grow on the result.
 */
export function shouldSkipToolResult(opts: {
  enabled: boolean;
  hydrated: HydratedToolItem[];
  name: string;
  /** 1-based count of `tool_result`s for `name` including this event. */
  replayedResultsOfName: number;
}): boolean {
  if (!opts.enabled) return false;
  const hit = ordinalOf(opts.hydrated, opts.name, opts.replayedResultsOfName);
  if (!hit) return false;
  return hit.status === 'ok' || hit.status === 'fail';
}

/** Mirror of `skillRowText` — kept here so this module does not import harnessChat. */
function skillRowNeedle(ev: {
  action: 'attach' | 'detach';
  slug: string;
  ok: boolean;
}): string {
  if (ev.action === 'detach') {
    return ev.ok ? `Skill detached: ${ev.slug}` : `Skill not attached: ${ev.slug}`;
  }
  return ev.ok ? `Skill attached: ${ev.slug}` : `Skill not attached: ${ev.slug}`;
}

export function skillAlreadyHydrated(
  messages: SessionMessage[],
  ev: Extract<AgentStreamEvent, { type: 'skill_attached' }>,
): boolean {
  const text = skillRowNeedle(ev);
  for (const m of thisRunWindow(messages)) {
    if (m.role === 'skill_attached' && m.text === text) return true;
  }
  return false;
}

/**
 * Increment this-heap SSE-frame count. Stays at the A3 max rather than
 * drop-to-unset (unset would look like poison and force a cold full replay).
 */
export function bumpStreamCursor(current: number): number {
  const next = current + 1;
  return sanitizeTurnStreamCursor(next) ?? current;
}

/**
 * Fold this-run assistant text into the session without duplicating a
 * hydrated row. Extends the last assistant when `text` grows the hydrate
 * prefix; no-ops when `text` is already present.
 */
export function foldThisRunAssistant(
  session: SessionSnapshot,
  text: string,
): SessionSnapshot {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return session;
  const have = thisRunAssistantText(session.messages);
  if (!have) {
    return appendMessage(session, 'assistant', trimmed);
  }
  if (have === trimmed || have.startsWith(trimmed)) {
    return session;
  }
  if (trimmed.startsWith(have)) {
    let lastA = -1;
    for (let i = 0; i < session.messages.length; i++) {
      if (session.messages[i]?.role === 'assistant') lastA = i;
    }
    if (lastA < 0) return appendMessage(session, 'assistant', trimmed);
    const msgs = session.messages.slice();
    const prev = msgs[lastA]!;
    msgs[lastA] = { ...prev, text: trimmed };
    return { ...session, messages: msgs, updatedAt: Date.now() };
  }
  return session;
}

