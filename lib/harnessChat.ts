/**
 * Phase 3.7–3.9 — host-side inference for the harness.
 * Wasm never sees Gateway keys; this module POSTs /api/chat and pushes results
 * through HarnessBridge + optional SessionStore.
 */
import {
  normalizePrompt,
  sendChat,
  validatePrompt,
  type ChatResult,
} from './chatApi';
import {
  HarnessBridge,
  Lifecycle,
  MessageKind,
} from './harnessBridge';
import {
  appendMessage,
  formatPromptWithHistory,
  type SessionSnapshot,
} from './sessionStore';

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
};

export type HarnessTurnResult = {
  result: ChatResult;
  /** Session after this turn (user + assistant/error appended). */
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
    bridge.hydrateMessages(msgs, {
      lifecycle: opts?.lifecycle,
    });
    return;
  }
  for (const m of msgs) {
    bridge.pushMessage(m.kind, m.text);
  }
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
  }

  const result = await send(apiPrompt, { signal: opts?.signal });

  if (result.ok) {
    bridge.pushMessage(MessageKind.Assistant, result.text);
    bridge.setLifecycle(Lifecycle.Ready);
    return result;
  }

  bridge.pushMessage(MessageKind.Error, result.error);
  bridge.setLifecycle(Lifecycle.Ready);
  return result;
}

/**
 * Full agent turn: update session + bridge + Gateway.
 */
export async function runHarnessTurn(
  bridge: HarnessBridge,
  session: SessionSnapshot,
  rawPrompt: string,
  opts?: Omit<RunHarnessChatOptions, 'history'>,
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

  const result = await runHarnessChat(bridge, prompt, {
    ...opts,
    pushUser,
    history: session.messages,
    useHistory: opts?.useHistory,
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
