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
  type AgentResult,
  type SendAgentFn,
  type ToolTraceEntry,
} from './agentApi';
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
  appendMessage,
  formatPromptWithHistory,
  type SessionSnapshot,
} from './sessionStore';

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
  /** Inject for tests; defaults to sendAgent. */
  sendAgent?: SendAgentFn;
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

/** Mirror session into Wasm (batched hydrate when clearing). Truncated by MAX_MSG_LEN on Zig. */
export function pushSessionToBridge(
  bridge: HarnessBridge,
  session: SessionSnapshot,
  opts?: { clear?: boolean; lifecycle?: import('./harnessBridge').Lifecycle },
): void {
  const msgs = session.messages.map((m) => ({
    kind: roleToKind(m.role),
    text: m.text,
  }));
  if (opts?.clear !== false) {
    resetHarnessImageSession();
    bridge.hydrateMessages(msgs, {
      lifecycle: opts?.lifecycle,
    });
    scheduleImagesFromTexts(
      bridge,
      session.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => m.text),
    );
    return;
  }
  for (const m of msgs) {
    bridge.pushMessage(m.kind, m.text);
  }
  scheduleImagesFromTexts(
    bridge,
    session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => m.text),
  );
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
  }

  const result = await send(apiPrompt, {
    signal: opts?.signal,
    modelId: opts?.modelId,
  });

  if (result.ok) {
    bridge.pushMessage(MessageKind.Assistant, result.text);
    scheduleImagesFromMarkdown(bridge, result.text);
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
  // Always schedule user-body images (Wasm may already show the user line).
  scheduleImagesFromMarkdown(bridge, prompt);
  const preferAgent = opts?.preferAgent !== false;
  const useHistory = opts?.useHistory !== false;
  const sendAgentFn = opts?.sendAgent ?? sendAgent;

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

    const agentResult = await sendAgentFn(apiPrompt, {
      signal: opts?.signal,
      modelId: opts?.modelId,
    });

    if (agentResult.ok) {
      let next = withUser;
      const lines = selectToolTraceLines(agentResult.toolTrace);
      for (const line of lines) {
        bridge.pushMessage(MessageKind.System, line);
        next = appendMessage(next, 'system', line);
      }
      bridge.pushMessage(MessageKind.Assistant, agentResult.text);
      scheduleImagesFromMarkdown(bridge, agentResult.text);
      bridge.setLifecycle(Lifecycle.Ready);
      next = appendMessage(next, 'assistant', agentResult.text);
      return {
        result: { ok: true, text: agentResult.text },
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
        session: appendMessage(withUser, 'error', agentResult.error),
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
