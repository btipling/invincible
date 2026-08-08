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
import {
  LIVE_TOOL_LINES_MAX,
  type AgentStreamEvent,
} from './agent/agentStream';
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
  type SessionSnapshot,
} from './sessionStore';
import { canLoadEarlier, latestRingStart, sliceMessagesForRing } from './sessionWindow';

/** Match Wasm MAX_MSG_LEN — single thinking bubble cap (live segment). */
export const THINKING_DISPLAY_MAX = 4096;

/** Max Thinking segments pushed per turn before overflow notice. */
export const THINKING_SEGMENTS_MAX = 6;

/** Collapsed thinking one-liner max body chars (before ellipsis). */
export const THINKING_COLLAPSED_MAX = 160;

/** Parent #45 / phase 3 — max system toolTrace lines per turn. */
export const TOOL_TRACE_MAX_LINES = 6;

/** Prompt used for end-to-end smoke (model should reply with PONG). */
export const HARNESS_SMOKE_PROMPT = 'Reply with exactly: PONG';

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

function roleToKind(role: 'user' | 'assistant' | 'system' | 'error'): MessageKind {
  switch (role) {
    case 'user':
      return MessageKind.User;
    case 'assistant':
      return MessageKind.Assistant;
    case 'system':
      return MessageKind.System;
    case 'error':
      return MessageKind.Error;
  }
}

/** Truncate toolTrace summary for bridge (≤240). */
export function truncateToolTraceSummary(
  text: string,
  maxChars: number = TOOL_TRACE_SUMMARY_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Truncate thinking monologue for bridge (≤4096 live). */
export function truncateThinkingDisplay(
  text: string,
  maxChars: number = THINKING_DISPLAY_MAX,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Collapse a finished thinking monologue for ring display (≤160 + ellipsis).
 * Used when tools/text supersede the segment so the ring is not flooded.
 */
export function collapseThinkingDisplay(
  text: string,
  maxChars: number = THINKING_COLLAPSED_MAX,
): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return 'Thinking · collapsed';
  if (one.length <= maxChars) return one;
  return `${one.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Cap and clean toolTrace for host display (≤6 non-empty summaries, ≤240 chars).
 */
export function selectToolTraceLines(
  toolTrace: ToolTraceEntry[] | undefined,
  maxLines: number = TOOL_TRACE_MAX_LINES,
): string[] {
  if (!toolTrace?.length) return [];
  const lines: string[] = [];
  for (const entry of toolTrace) {
    if (lines.length >= maxLines) break;
    const summary = truncateToolTraceSummary((entry.summary ?? '').trim());
    if (!summary) continue;
    lines.push(summary);
  }
  return lines;
}

/** Mirror a SessionStore window (≤48) into Wasm. Returns ringWindowStart used. */
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
  const slice = sliceMessagesForRing(session.messages, windowStart);
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
    bridge.setLifecycle(Lifecycle.Ready);
    return result;
  }

  bridge.pushMessage(MessageKind.Error, result.error);
  bridge.setLifecycle(Lifecycle.Ready);
  return result;
}

function isCancelledAgent(result: AgentResult): boolean {
  return !result.ok && result.error === 'Request cancelled.';
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
    const next = appendMessage(session, 'error', validation);
    bridge.pushMessage(MessageKind.Error, validation);
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
    if (pushUser) {
      bridge.pushMessage(MessageKind.User, prompt);
      userPushedOnBridge = true;
    }

    let agentResult: AgentResult;
    let next = withUser;
    let liveToolLines = 0;
    let overflowNote = false;
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
    let thinkingSegments = 0;
    let thinkingOverflowNote = false;
    let sawStreamTerminal = false;

    const closeAssistantSegment = () => {
      assistantSegmentOpen = false;
      assistantSegment = '';
    };

    const closeThinkingSegment = () => {
      if (thinkingSegmentOpen) {
        const collapsed = collapseThinkingDisplay(thinkingSegment);
        if (!bridge.updateLastMessage(MessageKind.Thinking, collapsed)) {
          // Last row is no longer Thinking — leave ring as-is.
        }
      }
      thinkingSegmentOpen = false;
      thinkingSegment = '';
    };

    const growThinking = (chunk: string) => {
      if (!chunk) return;
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

      if (thinkingSegments >= THINKING_SEGMENTS_MAX) {
        if (!thinkingOverflowNote) {
          const note = `+ more thinking (live cap ${THINKING_SEGMENTS_MAX})`;
          bridge.pushMessage(MessageKind.System, note);
          thinkingOverflowNote = true;
        }
        return;
      }

      thinkingSegment = truncateThinkingDisplay(chunk);
      bridge.pushMessage(MessageKind.Thinking, thinkingSegment);
      thinkingSegmentOpen = true;
      thinkingSegments += 1;
    };

    const growAssistant = (chunk: string) => {
      if (!chunk) return;
      closeThinkingSegment();
      assistantAcc += chunk;
      if (!assistantSegmentOpen) {
        assistantSegment = chunk;
        bridge.pushMessage(MessageKind.Assistant, assistantSegment);
        assistantSegmentOpen = true;
        assistantStarted = true;
        return;
      }
      assistantSegment += chunk;
      if (!bridge.updateLastMessage(MessageKind.Assistant, assistantSegment)) {
        // Last row is not assistant — open a fresh bubble with this segment.
        bridge.pushMessage(MessageKind.Assistant, assistantSegment);
      }
    };

    const finalizeAssistant = (finalText: string) => {
      const text = finalText.trim();
      if (!text) return;
      if (!assistantStarted) {
        bridge.pushMessage(MessageKind.Assistant, text);
        assistantStarted = true;
        assistantSegmentOpen = true;
        assistantSegment = text;
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

    if (streamAgent) {
      agentResult = await sendAgentStreamFn(apiPrompt, {
        signal: opts?.signal,
        modelId: opts?.modelId,
        onEvent: async (ev: AgentStreamEvent) => {
          if (ev.type === 'tool_start' || ev.type === 'tool_result') {
            closeAssistantSegment();
            closeThinkingSegment();
            if (liveToolLines >= LIVE_TOOL_LINES_MAX) {
              if (!overflowNote) {
                const note = `+ more tools (live cap ${LIVE_TOOL_LINES_MAX})`;
                bridge.pushMessage(MessageKind.System, note);
                next = appendMessage(next, 'system', note);
                overflowNote = true;
              }
              return;
            }
            const line =
              ev.type === 'tool_start'
                ? truncateToolTraceSummary(`${ev.name} · running…`)
                : truncateToolTraceSummary(ev.summary);
            if (!line) return;
            bridge.pushMessage(MessageKind.System, line);
            next = appendMessage(next, 'system', line);
            liveToolLines += 1;
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
      });
    }

    // Safety net: collapse open thinking when the stream ends without a terminal
    // SSE event (abort, network drop, empty body). Mid-stream closes already ran
    // for tool/text/done/error; this is a no-op when the segment is already closed.
    closeThinkingSegment();

    if (agentResult.ok) {
      if (!streamAgent || !sawStreamTerminal) {
        // JSON path (or stream that returned JSON): end-of-turn toolTrace + assistant.
        const lines = selectToolTraceLines(agentResult.toolTrace);
        for (const line of lines) {
          bridge.pushMessage(MessageKind.System, line);
          next = appendMessage(next, 'system', line);
        }
        if (!assistantStarted) {
          bridge.pushMessage(MessageKind.Assistant, agentResult.text);
          assistantStarted = true;
        } else {
          bridge.updateLastMessage(MessageKind.Assistant, agentResult.text);
        }
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
      bridge.setLifecycle(Lifecycle.Ready);
      return {
        result: { ok: true, text: agentResult.text || assistantAcc },
        session: next,
      };
    }

    // Cancel or hard agent failure — never fall back to chat.
    if (!agentResult.sandboxNotConfigured || isCancelledAgent(agentResult)) {
      bridge.pushMessage(MessageKind.Error, agentResult.error);
      bridge.setLifecycle(Lifecycle.Ready);
      return {
        result: {
          ok: false,
          error: agentResult.error,
          status: agentResult.status,
        },
        session: appendMessage(next, 'error', agentResult.error),
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
    return {
      result,
      session: appendMessage(withUser, 'assistant', result.text),
    };
  }
  return {
    result,
    session: appendMessage(withUser, 'error', result.error),
  };
}
