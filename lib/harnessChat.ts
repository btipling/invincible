/**
 * Phase 3.7–3.9 — host-side inference for the harness.
 * Agent-tools first; a failed agent turn hard-fails (no 503 → /api/chat fallback).
 * Wasm never sees Gateway keys; results push through HarnessBridge + SessionStore.
 */
import {
  normalizePrompt,
  sendChat,
  validatePrompt,
  type ChatResult,
} from './chatApi';
import {
  sendAgent,
  sendAgentStream,
  type AgentResult,
  type SendAgentFn,
  type SendAgentStreamFn,
  type ToolTraceEntry,
} from './agentApi';
import { type AgentStreamEvent } from './agent/agentStream';
import {
  TOOL_TRACE_SUMMARY_MAX_CHARS,
} from './sandbox/config';
import {
  isRedisSafeOpaqueId,
  normalizeSessionCwd,
  STATUS_SLOT_MAX_BYTES,
} from './sessionCloudCaps';
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
  addToolResult,
  addToolStart,
  buildTraceGroups,
  createToolRunGroup,
  decodeToolRun,
  encodeToolRun,
  encodeToolRunPayload,
  hasRunningTool,
  mergeToolRunPayloads,
  toolRunIsFull,
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
};

export type HarnessTurnResult = {
  result: ChatResult;
  /** Session after this turn (user + optional system tool lines + assistant/error). */
  session: SessionSnapshot;
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
 */
function pushSkillRow(
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
 * Run one prompt → Gateway → transcript update.
 * Sets lifecycle busy → ready (soft API errors leave ready for retry).
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
  completeTurn(bridge, false); // stop / error / timeout / empty — no auto-promote
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
  const validation = validatePrompt(rawPrompt);
  if (validation) {
    bridge.pushMessage(MessageKind.Error, describeTurnEnd('validation', validation));
    const next = appendMessage(session, 'error', describeTurnEnd('validation', validation));
    completeTurn(bridge, false); // validation — no auto-promote
    return { result: { ok: false, error: validation }, session: next };
  }

  const prompt = normalizePrompt(rawPrompt);
  const withUser = appendMessage(session, 'user', prompt);

  // Wasm pending-submit path sets pushUser:false (user line already in canvas).
  const pushUser = opts?.pushUser !== false;
  // Always schedule user-body images/math (Wasm may already show the user line).
  scheduleImagesFromMarkdown(bridge, prompt);
  scheduleMathFromMarkdown(bridge, prompt);
  const preferAgent = opts?.preferAgent !== false;
  const useHistory = opts?.useHistory !== false;
  const sendAgentFn = opts?.sendAgent ?? sendAgent;
  const sendAgentStreamFn = opts?.sendAgentStream ?? sendAgentStream;
  // Default: stream when using production client. Tests that only inject
  // `sendAgent` keep the JSON path unless streamAgent/sendAgentStream set.
  const streamAgent =
    opts?.streamAgent !== undefined
      ? opts.streamAgent
      : opts?.sendAgentStream != null || opts?.sendAgent == null;

  const apiPrompt =
    useHistory && session.messages.length > 0
      ? formatPromptWithHistory(session.messages, prompt)
      : prompt;

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
    let lastRingRowIsToolRun = false;
    /** Session id of the current open live tool card (patched in place on growth). */
    let openToolRunId: string | null = null;

    const resetLiveToolStreak = () => {
      lastRingRowIsToolRun = false;
      openToolRunId = null;
      toolRunGroup = createToolRunGroup();
    };

    /**
     * Paint the current in-memory group as the live kind-6 card: grow the open
     * card in place when `lastRingRowIsToolRun` is true, else push a fresh one
     * at `1`. Mirrors the ring into the session (patch the open card / append a
     * new one) so a mid-turn cancel or reload never loses the live card.
     */
    const livePaintToolRun = () => {
      const payload = encodeToolRun(toolRunGroup);
      if (!payload) return;
      if (lastRingRowIsToolRun) {
        // Grow the open card. Guard the rare impossible case where the last row
        // is not our tool card (a raced ring write): never a stale silent bag —
        // open a fresh card instead of duplicating state.
        if (!bridge.updateLastMessage(MessageKind.ToolRun, payload)) {
          bridge.pushMessage(MessageKind.ToolRun, payload);
          next = appendMessage(next, 'tool_run', payload);
          openToolRunId = next.messages[next.messages.length - 1]?.id ?? null;
        } else if (openToolRunId != null) {
          // Patch the open card's session row in place (same id anchor) so
          // session == ring at every instant.
          next = {
            ...next,
            messages: next.messages.map((m) =>
              m.id === openToolRunId ? { ...m, text: payload } : m,
            ),
            updatedAt: Date.now(),
          };
        } else {
          // No anchor yet (shouldn't happen) — append a fresh row and track it.
          next = appendMessage(next, 'tool_run', payload);
          openToolRunId = next.messages[next.messages.length - 1]?.id ?? null;
        }
      } else {
        // Open a fresh card at 1.
        bridge.pushMessage(MessageKind.ToolRun, payload);
        next = appendMessage(next, 'tool_run', payload);
        openToolRunId = next.messages[next.messages.length - 1]?.id ?? null;
        lastRingRowIsToolRun = true;
      }
    };

    const handleToolEvent = (ev: AgentStreamEvent) => {
      if (ev.type !== 'tool_start' && ev.type !== 'tool_result') return;
      // Live grouping predicate (#433): only continue the open card when the
      // last ring row is a tool-run; any non-tool row (assistant / user / error
      // / a thinking row that is last) opens a fresh group for this tool.
      if (!lastRingRowIsToolRun) resetLiveToolStreak();
      closeAssistantSegment();
      closeThinkingSegment();
      const grows =
        ev.type === 'tool_start' || !hasRunningTool(toolRunGroup, ev.name);
      if (grows && toolRunIsFull(toolRunGroup)) {
        // Group-full roll: the open card already holds TOOL_RUN_ITEMS_MAX. The
        // next tool opens a FRESH card at 1 — never grows the just-pushed full
        // card (that card is already the painted live row + its session row).
        resetLiveToolStreak();
      }
      if (ev.type === 'tool_start') {
        addToolStart(toolRunGroup, ev.name);
      } else {
        addToolResult(
          toolRunGroup,
          ev.name,
          ev.ok,
          truncateToolTraceSummary(ev.summary),
          ev.preview,
        );
        // Phase 2 (#465): a successful `change_dir` is the durable-live-cwd
        // signal. Only a confirmed success records it; anything else leaves the
        // prior value untouched. The cwd is read from the TYPED
        // `ev.changeDirCwd` field (from the raw, untruncated tool result) — NOT
        // from the truncated display `summary` (adversarial review #470 Major).
        if (ev.name === 'change_dir' && ev.ok) {
          liveCwd = recordLiveCwd(liveCwd, ev.changeDirCwd);
          // Phase 2 (#627 / #625): live cwd mutation mid-turn — apply the
          // confirmed cwd to the session and repaint the status bar immediately,
          // without waiting for `done`.
          if (ev.changeDirCwd !== undefined) {
            const cd = toSessionCwd(ev.changeDirCwd);
            if (cd !== undefined) {
              next = { ...next, cwd: cd };
              foldStatusSlots(bridge, next);
              opts?.onSessionPatch?.(next);
            }
          }
        }
        // Phase 2 (#627 / #625): live sandbox bind switch mid-turn. A
        // successful `meta_sandbox_switch` carries the typed target id; apply
        // it to the session, repaint the sandbox + git slots, and persist the
        // patched snapshot immediately — the switch envelope write is already
        // done server-side; this mirrors it on the host.
        if (ev.name === 'meta_sandbox_switch' && ev.ok && ev.activeSandboxId) {
          const id = ev.activeSandboxId;
          if (isRedisSafeOpaqueId(id)) {
            next = { ...next, activeSandboxId: id };
            foldStatusSlots(bridge, next);
            void refreshGitStatusSlot(bridge, next, opts?.signal);
            opts?.onSessionPatch?.(next);
          }
        }
        // Phase 2 (#627 / #625): git refresh on any successful exec — no
        // session mutation, no onSessionPatch. Fail-soft; server rate-limited.
        if (ev.name === 'exec' && ev.ok) {
          void refreshGitStatusSlot(bridge, next, opts?.signal);
        }
      }
      // Paint now — the operator sees `N tools called` on THIS event.
      livePaintToolRun();
      lastUiKind = 'tool_run';
    };

    const closeAssistantSegment = () => {
      assistantSegmentOpen = false;
      assistantSegment = '';
    };

    const closeThinkingSegment = () => {
      // Keep full monologue visible — do not collapse to a one-liner.
      // Soft-trim only to Wasm MAX_MSG_LEN via collapseThinkingDisplay.
      if (thinkingSegmentOpen && thinkingSegment) {
        const kept = collapseThinkingDisplay(thinkingSegment);
        if (kept !== thinkingSegment) {
          if (!bridge.updateLastMessage(MessageKind.Thinking, kept)) {
            /* last row changed — leave as-is */
          }
        }
      }
      thinkingSegmentOpen = false;
      thinkingSegment = '';
    };

    const growThinking = (chunk: string) => {
      if (!chunk) return;
      // A Thinking row is a NON-tool ring row. Once it lands last it becomes a
      // physical separator (#433 locked rule): the next tool opens a NEW card at
      // `1` rather than growing an open tool card below it. The last painted
      // tool card is already committed live (painted on its event), so we only
      // clear the live-paint flag here — never buffer the tool group in host
      // memory until thinking closes (commit-once is removed).
      lastUiKind = 'thinking';
      lastRingRowIsToolRun = false;
      // Thinking is ephemeral UI — do not append to SessionStore.
      // Close assistant so a later text_delta cannot updateLast-fail and
      // re-push a full duplicated assistant segment (text→reason→text).
      closeAssistantSegment();

      if (thinkingSegmentOpen) {
        thinkingSegment = truncateThinkingDisplay(thinkingSegment + chunk);
        if (!bridge.updateLastMessage(MessageKind.Thinking, thinkingSegment)) {
          bridge.pushMessage(MessageKind.Thinking, thinkingSegment);
        }
        return;
      }

      thinkingSegment = truncateThinkingDisplay(chunk);
      bridge.pushMessage(MessageKind.Thinking, thinkingSegment);
      thinkingSegmentOpen = true;
    };

    const growAssistant = (chunk: string) => {
      // Whitespace-only text_delta is NOT a boundary (plan #364): it never
      // opens an assistant bubble, closes thinking, or flushes a tool streak.
      // But it MUST be accumulated faithfully (into the message buffer and any
      // open bubble) so a boundary `\n\n` between streamed segments survives
      // into `finalizeAssistant`. If we dropped it, the multi-segment tail-slice
      // would mis-subtract and glue the finished row against a well-formed
      // authoritative `done.text` (#387 host seam, phase-1 red fixture).
      if (!chunk.trim()) {
        assistantAcc += chunk;
        if (assistantSegmentOpen) {
          assistantSegment += chunk;
          if (!bridge.updateLastMessage(MessageKind.Assistant, assistantSegment)) {
            bridge.pushMessage(MessageKind.Assistant, assistantSegment);
          }
        } else if (assistantStarted) {
          // Boundary whitespace that arrives AFTER the previous segment closed
          // (e.g. a tool closed the bubble): buffer it so the next opened
          // assistant segment leads with it, keeping the inter-segment blank
          // line on the canvas (#387 after-close residual). Never opens an
          // empty bubble on its own (plan #364). Leading whitespace before the
          // FIRST segment (`assistantStarted === false`) is not buffered — it is
          // a tokenization artifact that the authoritative final rewrites.
          pendingAssistantWs += chunk;
        }
        return;
      }
      closeThinkingSegment();
      assistantAcc += chunk;
      if (!assistantSegmentOpen) {
        // Real assistant text begins. The open tool card is already painted live
        // on its events (not buffered), so this is a boundary reset only — cl
        // the live-paint flag so a later tool opens a NEW card; never re-push
        // the already-committed tool row.
        resetLiveToolStreak();
        // Reattach any boundary whitespace buffered after the previous segment
        // closed (tool boundary) so the completed canvas equals authoritative.
        const leading = pendingAssistantWs;
        pendingAssistantWs = '';
        assistantSegment = leading + chunk;
        bridge.pushMessage(MessageKind.Assistant, assistantSegment);
        assistantSegmentOpen = true;
        assistantStarted = true;
        // Real assistant text is a boundary — later tools open a new group.
        lastUiKind = 'assistant';
        return;
      }
      assistantSegment += chunk;
      if (!bridge.updateLastMessage(MessageKind.Assistant, assistantSegment)) {
        // Last row is not assistant — open a fresh bubble with this segment.
        bridge.pushMessage(MessageKind.Assistant, assistantSegment);
      }
      lastUiKind = 'assistant';
    };

    const finalizeAssistant = (finalText: string) => {
      const text = finalText.trim();
      if (!text) return;
      if (!assistantStarted) {
        // The open tool card is already painted live on its events; reset the
        // flag so the assistant reply (and any later tool) is a fresh boundary.
        resetLiveToolStreak();
        bridge.pushMessage(MessageKind.Assistant, text);
        assistantStarted = true;
        assistantSegmentOpen = true;
        assistantSegment = text;
        lastUiKind = 'assistant';
      } else if (assistantSegmentOpen) {
        // Single continuous segment: rewrite to server final when it differs.
        if (assistantAcc === assistantSegment) {
          if (text !== assistantSegment) {
            if (!bridge.updateLastMessage(MessageKind.Assistant, text)) {
              bridge.pushMessage(MessageKind.Assistant, text);
            }
          }
        } else {
          // Multi-segment turn: adjust only the open tail if final extends it.
          const prefixLen = Math.max(0, assistantAcc.length - assistantSegment.length);
          const prefix = assistantAcc.slice(0, prefixLen);
          if (text.startsWith(prefix) && text.length >= prefixLen) {
            const tail = text.slice(prefixLen);
            if (tail && tail !== assistantSegment) {
              if (!bridge.updateLastMessage(MessageKind.Assistant, tail)) {
                bridge.pushMessage(MessageKind.Assistant, tail);
              }
              assistantSegment = tail;
            }
          }
          // else: leave streamed segments as-is; session still gets full text
        }
      } else {
        // Stream ended on a tool line — only push if final adds unseen text.
        if (text !== assistantAcc) {
          bridge.pushMessage(MessageKind.Assistant, text);
          assistantSegmentOpen = true;
          assistantSegment = text;
        }
      }
      assistantAcc = text;
      scheduleImagesFromMarkdown(bridge, text);
    };

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

    if (streamAgent) {
      agentResult = await sendAgentStreamFn(apiPrompt, {
        signal: opts?.signal,
        modelId: opts?.modelId,
        cwd: sessionCwd,
        ...(sessionId ? { sessionId } : {}),
        ...(boundPersonaId ? { personaId: boundPersonaId } : {}),
        ...(sessionSandboxId ? { sandboxId: sessionSandboxId } : {}),
        onEvent: async (ev: AgentStreamEvent) => {
          if (ev.type === 'tool_start' || ev.type === 'tool_result') {
            handleToolEvent(ev);
            return;
          }
          if (ev.type === 'reasoning_delta') {
            growThinking(ev.text);
            return;
          }
          if (ev.type === 'text_delta') {
            growAssistant(ev.text);
            return;
          }
          if (ev.type === 'skill_attached') {
            // Server sends skill_attached events at the START of the turn (before
            // the model). Push the display-only row live; it is a non-tool
            // separator for the tool-run predicate.
            lastRingRowIsToolRun = false;
            lastUiKind = 'assistant';
            next = pushSkillRow(bridge, next, ev);
            // Phase 2 (#517 / adversarial-review Blocker + "fold-before-persist
            // incl. fail/cancel"): every skill_attached event carries the SAME
            // final set, so last-writes-wins here never clears across events, and
            // it is applied BEFORE the model runs — so a success, a 502, or a
            // user Stop/cancel still ends with the host persisting the sticky set
            // as `meta.attachedSkills` (omitted field = leave untouched; `[]` =
            // explicit detach-all).
            if (Array.isArray(ev.attachedSlugs)) {
              next = { ...next, attachedSlugs: [...ev.attachedSlugs] };
            }
            return;
          }
          if (ev.type === 'usage') {
            // Phase 3 (plan #628) — live provider usage mid-stream: fold the
            // context slot immediately so the operator sees token counts before
            // the turn completes. `done.usage` is the final reconcile.
            const liveUsage = sanitizeUsageSummary(ev.usage);
            if (liveUsage) {
              next = { ...next, usage: liveUsage };
              foldStatusSlots(bridge, next);
              opts?.onSessionPatch?.(next);
            }
            return;
          }
          if (ev.type === 'done') {
            sawStreamTerminal = true;
            closeThinkingSegment();
            finalizeAssistant(ev.text ?? assistantAcc);
            // Do not re-push toolTrace — live lines already shown.
            return;
          }
          if (ev.type === 'error') {
            sawStreamTerminal = true;
            closeThinkingSegment();
          }
        },
      });
    } else {
      agentResult = await sendAgentFn(apiPrompt, {
        signal: opts?.signal,
        modelId: opts?.modelId,
        cwd: sessionCwd,
        ...(sessionId ? { sessionId } : {}),
        ...(boundPersonaId ? { personaId: boundPersonaId } : {}),
        ...(sessionSandboxId ? { sandboxId: sessionSandboxId } : {}),
      });
    }

    // Safety net: collapse open thinking when the stream ends without a terminal
    // SSE event (abort, network drop, empty body). Mid-stream closes already ran
    // for tool/text/done/error; this is a no-op when the segment is already closed.
    closeThinkingSegment();

    if (agentResult.ok) {
      // Live tool cards are already painted + session-mirrored on each event;
      // this clears the live state so the JSON/toolTrace fallback below (when
      // present) is the only writer. No re-push of an already-committed card.
      resetLiveToolStreak();
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
      next = appendMessage(next, 'assistant', agentResult.text || assistantAcc);
      scheduleMathFromTexts(
        bridge,
        next.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => m.text),
      );
      next = pushTurnEnd(bridge, next, 'model');
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
      resetLiveToolStreak();
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
        failedSession = appendMessage(failedSession, 'assistant', partial);
      }
      const fail = classifyTurnFailure(
        agentResult.error,
        agentResult.status,
        opts?.signal,
      );
      failedSession = pushTurnEnd(bridge, failedSession, fail.kind, fail.detail);
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
        agentResult.status === 403 &&
        failedSession.activeSandboxId !== undefined &&
        (agentResult.error === SANDBOX_SELECTION_REQUIRED_ERROR ||
          agentResult.error === SANDBOX_FORBIDDEN_ERROR)
      ) {
        failedSession = { ...failedSession, activeSandboxId: undefined };
      }
      lastUiKind =
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
      completeTurn(bridge, false); // stop / error / timeout / empty — no auto-promote
      return {
        result: {
          ok: false,
          error: agentResult.error,
          status: agentResult.status,
        },
        session: failedSession,
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
