/**
 * Phase 3.7 — host-side inference for the harness.
 * Wasm never sees Gateway keys; this module POSTs /api/chat and pushes results
 * through HarnessBridge.
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

/** Prompt used for end-to-end smoke (model should reply with PONG). */
export const HARNESS_SMOKE_PROMPT = 'Reply with exactly: PONG';

export type RunHarnessChatOptions = {
  signal?: AbortSignal;
  /** Inject for tests; defaults to sendChat. */
  send?: typeof sendChat;
  /**
   * When true (default), push the user line into the transcript.
   * Set false if Wasm already showed the user message before host ack.
   */
  pushUser?: boolean;
};

/**
 * Run one prompt → Gateway → transcript update.
 * Sets lifecycle busy → ready (or keeps ready after soft API errors so the user can retry).
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

  bridge.setLifecycle(Lifecycle.Busy);
  if (pushUser) {
    bridge.pushMessage(MessageKind.User, prompt);
  }

  const result = await send(prompt, { signal: opts?.signal });

  if (result.ok) {
    bridge.pushMessage(MessageKind.Assistant, result.text);
    bridge.setLifecycle(Lifecycle.Ready);
    return result;
  }

  bridge.pushMessage(MessageKind.Error, result.error);
  // Soft failure: ready for another attempt (ember error lives in transcript).
  bridge.setLifecycle(Lifecycle.Ready);
  return result;
}
