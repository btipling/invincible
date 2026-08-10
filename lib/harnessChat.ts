/**
 * Phase 3.7–3.9 — host-side inference for the harness.
 * Phase 3 (#48): try POST /api/agent first; 503 sandbox-not-configured → /api/chat.
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
  HarnessBridge,
  Lifecycle,
  MessageKind,
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
   * When true (default), try POST /api/agent first; fall back to chat only on
   * exact sandbox-not-configured 503.
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
};

export type HarnessTurnResult = {
  result: ChatResult;
  /** Session after this turn (user + optional system tool lines + assistant/error). */
  session: SessionSnapshot;
};

function roleToKind(role: 'user' | 'assistant' | 'system' | 'error' | 'tool_run'): MessageKind {
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
  }
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
    bridge.setLifecycle(Lifecycle.Ready);
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
    bridge.setLifecycle(Lifecycle.Ready);
    return result;
  }

  const fail = classifyTurnFailure(result.error, result.status, opts?.signal);
  bridge.pushMessage(
    fail.kind === 'stop' ? MessageKind.System : MessageKind.Error,
    describeTurnEnd(fail.kind, fail.detail),
  );
  bridge.setLifecycle(Lifecycle.Ready);
  return result;
}

function isCancelledAgent(result: AgentResult): boolean {
  return !result.ok && result.error === 'Request cancelled.';
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
 * #357). `'tool_run'` marks an open/committed tool streak; `'thinking'` and
 * `'none'` also keep a streak open. `'assistant'`/`'user'`/`'error'` are true
 * boundaries that split the streak. `'system'` is a turn-end terminal row.
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
 * Single grouping predicate: whether an incoming `tool_start`/`tool_result`
 * continues the open tool-run streak (aggregate into the current group) or
 * must open a new group. Thinking between tools keeps a streak; a real painted
 * assistant / user / error splits. `none` (fresh turn start / empty session)
 * continues. `system` is a turn-end terminal — never a live continue.
 */
export function shouldContinueStreak(last: LastUiKind): boolean {
  return last === 'thinking' || last === 'tool_run' || last === 'none';
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
  }
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
    bridge.setLifecycle(Lifecycle.Ready);
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
    let thinkingSegment = '';
    let thinkingSegmentOpen = false;
    let sawStreamTerminal = false;

    // Tool-run aggregation (protocol v10 / plan #345). The host owns the SSE and
    // knows the structured `tool_result.ok`, so it aggregates each uninterrupted
    // tool streak into ONE display-only `tool_run` message (bridge kind 6, session
    // role `tool_run`). Commit-once: the host aggregates the full streak and
    // pushes ONE complete `tool_run` row to the bridge + session on flush at a
    // true boundary (assistant text, turn end, or group-full roll). We never
    // live-push/`update_last` a growing ToolRun row during the streak — the
    // bridge shows tool chrome only when the streak commits.
    let toolRunGroup: ToolRunGroup = createToolRunGroup();

    /**
     * Commit-once (plan #355 / parent #352 decision C). The group lives only in
     * host memory while a streak is open and is written to the bridge + session
     * as a SINGLE complete `tool_run` row at a true boundary (assistant text,
     * turn end, or group-full roll). We never live-push/`update_last` a ToolRun
     * row during the streak — for interleaved or contiguous streaks alike —
     * because `updateLastMessage` only rewrites the LAST ring row: once a
     * Thinking bubble opens above a ToolRun slot that slot can never grow, so a
     * live partial row would end stale (parent locked: live per-tool paint is
     * removed for EVERY streak).
     */
    const flushToolRun = () => {
      const payload = encodeToolRun(toolRunGroup);
      toolRunGroup = createToolRunGroup();
      if (!payload) return;
      bridge.pushMessage(MessageKind.ToolRun, payload);
      next = appendMessage(next, 'tool_run', payload);
      lastUiKind = 'tool_run';
    };

    const handleToolEvent = (ev: AgentStreamEvent) => {
      if (ev.type !== 'tool_start' && ev.type !== 'tool_result') return;
      // Single boundary predicate (plan #364): a split kind (assistant / user /
      // error) opens a new group for this tool. The open group is normally
      // already empty here (the boundary committed it); the flush is a
      // defense-in-depth no-op that keeps one commit path.
      if (!shouldContinueStreak(lastUiKind)) flushToolRun();
      closeAssistantSegment();
      closeThinkingSegment();
      const grows =
        ev.type === 'tool_start' || !hasRunningTool(toolRunGroup, ev.name);
      if (grows && toolRunIsFull(toolRunGroup)) flushToolRun();
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
      }
      // Mark the streak open so a subsequent tool continues the same group. Not
      // a live push — the complete N-item row is still committed once by
      // flushToolRun at a true boundary (exactly one card per streak, never a
      // growing/cloning row).
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
      // Thinking continues a tool streak (never a boundary), per plan #364.
      lastUiKind = 'thinking';
      // Thinking is ephemeral UI — do not append to SessionStore.
      // Close assistant so a later text_delta cannot updateLast-fail and
      // re-push a full duplicated assistant segment (text→reason→text).
      closeAssistantSegment();

      // Commit-once (plan #355 / parent #352 C): thinking is NOT a group
      // boundary. Keep the in-host group open across the think↔tool interleave
      // (the complete row is pushed once at a true boundary by flushToolRun);
      // the incoming Thinking opens above an open (host-held) group — never
      // fragmenting or cloning on the bridge.

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
      // Empty OR whitespace-only text_delta is NOT a boundary (plan #364): it
      // never opens an assistant bubble nor flushes a tool streak.
      if (!chunk.trim()) return;
      closeThinkingSegment();
      assistantAcc += chunk;
      if (!assistantSegmentOpen) {
        // Real assistant text begins — close the open tool-run group so it is a
        // distinct group boundary (won't merge with tools after the reply).
        flushToolRun();
        assistantSegment = chunk;
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
        // Open the reply only after committing any open tool-run group, so the
        // single N-item row lands directly before the assistant bubble (bridge
        // order tool_run → assistant matches session order).
        flushToolRun();
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

    const sessionCwd =
      typeof session.cwd === 'string' && session.cwd.trim()
        ? session.cwd.trim()
        : undefined;

    if (streamAgent) {
      agentResult = await sendAgentStreamFn(apiPrompt, {
        signal: opts?.signal,
        modelId: opts?.modelId,
        ...(sessionCwd != null ? { cwd: sessionCwd } : {}),
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
        ...(sessionCwd != null ? { cwd: sessionCwd } : {}),
      });
    }

    // Safety net: collapse open thinking when the stream ends without a terminal
    // SSE event (abort, network drop, empty body). Mid-stream closes already ran
    // for tool/text/done/error; this is a no-op when the segment is already closed.
    closeThinkingSegment();

    if (agentResult.ok) {
      // Persist any live tool-run group (stream path). No-op when empty.
      flushToolRun();
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
      // Success-only cwd apply (parent #270 / phase 2): never on failure/abort.
      // Non-empty trim only — match send path; avoid sticky whitespace cwd.
      const appliedCwd =
        typeof agentResult.cwd === 'string' ? agentResult.cwd.trim() : '';
      if (appliedCwd) {
        next = { ...next, cwd: appliedCwd };
      }
      bridge.setLifecycle(Lifecycle.Ready);
      return {
        result: { ok: true, text: agentResult.text || assistantAcc },
        session: next,
      };
    }

    // Cancel or hard agent failure — never fall back to chat.
    if (!agentResult.sandboxNotConfigured || isCancelledAgent(agentResult)) {
      // Persist any live tool-run group (display-only, plan #345). Caveat: the
      // aggregated `tool_run` is NOT folded back into the model prompt, so a
      // continue-after-stall turn no longer re-sends tool summaries — the model
      // sees only the persisted assistant prose and may re-run tools or infer
      // results. That is a documented product rule (docs/harness-limits.md); a
      // "continue / finish that" prompt after a mid-tool cancel is the one path
      // most likely to trigger a re-run. We still persist the group so the
      // transcript + Copy show exactly what ran.
      flushToolRun();
      let failedSession = next;
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
      lastUiKind =
        fail.kind === 'error' || fail.kind === 'timeout' ||
        fail.kind === 'empty' || fail.kind === 'validation'
          ? 'error'
          : 'system';
      bridge.setLifecycle(Lifecycle.Ready);
      return {
        result: {
          ok: false,
          error: agentResult.error,
          status: agentResult.status,
        },
        session: failedSession,
      };
    }
    // sandboxNotConfigured → fall through to chat once
  }

  const result = await runHarnessChat(bridge, prompt, {
    signal: opts?.signal,
    send: opts?.send,
    pushUser: pushUser && !userPushedOnBridge,
    history: session.messages,
    useHistory: opts?.useHistory,
    modelId: opts?.modelId,
  });

  if (result.ok) {
    // runHarnessChat already painted Turn ended · chat finished on the bridge.
    let sess = appendMessage(withUser, 'assistant', result.text);
    sess = appendMessage(sess, 'system', describeTurnEnd('chat'));
    return { result, session: sess };
  }
  const fail = classifyTurnFailure(result.error, result.status, opts?.signal);
  // runHarnessChat already painted the end reason on the bridge.
  return {
    result,
    session: appendMessage(
      withUser,
      fail.kind === 'stop' ? 'system' : 'error',
      describeTurnEnd(fail.kind, fail.detail),
    ),
  };
}
