import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  coalesceToolRunMessages,
  collapseThinkingDisplay,
  classifyTurnFailure,
  classifyTurnRetry,
  AgentRetryError,
  CONTINUE_TURN_PROMPT,
  describeTurnEnd,
  foldStatusSlots,
  getSessionCwd,
  HARNESS_QUEUE_MAX_ITEMS,
  isTurnEndLine,
  parseChangeDirCwd,
  pushSessionToBridge,
  recordLiveCwd,
  refreshGitStatusSlot,
  runHarnessChat,
  restoreLastUiKind,
  runHarnessTurn,
  selectToolTraceLines,
  shouldContinueStreak,
  skillRowText,
  truncateStatusValue,
  truncateToolTraceSummary,
  type LiveCwdSource,
} from './harnessChat';
import { HARNESS_RING_MAX } from './sessionWindow';
import { ATTACH_FOLLOW_UP_NOTE, ATTACH_FOLLOW_UP_DETACH_NOTE } from './turnAttach';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessBridge,
  INV_PING_XOR,
  Lifecycle,
  MessageKind,
  StatusSlot,
  type HarnessBridgeExports,
} from './harnessBridge';
import type { ChatResult } from './chatApi';
import type { AgentResult } from './agentApi';
import type { AgentStreamEvent } from './agent/agentStream';
import {
  TOOL_RUN_ITEMS_MAX,
  addToolResult,
  addToolStart,
  buildTraceGroups,
  createToolRunGroup,
  decodeToolRun,
  encodeToolRun,
} from './toolRun';
import {
  AUTH_REQUIRED_ERROR,
  SANDBOX_FORBIDDEN_ERROR,
  SANDBOX_SELECTION_REQUIRED_ERROR,
  WORKSPACE_INSTANCE_REQUIRED_ERROR,
} from './tenancy/errors';
import { harnessImageSessionGeneration } from './harnessImages';
import { createEmptySession, formatPromptWithHistory, appendMessage, makeMessage } from './sessionStore';
import { TOOL_TRACE_SUMMARY_MAX_CHARS } from './sandbox/config';

function makeMockExports(): HarnessBridgeExports & {
  __messages: { kind: number; text: string }[];
  __lifecycle: () => Lifecycle;
  __canLoadEarlier: () => number;
  __statusSlots: (string | undefined)[];
  __promoteAllowed: () => boolean;
  __queue: string[];
} {
  let buf = new ArrayBuffer(64 * 1024);
  const memory = {
    get buffer() {
      return buf;
    },
  };
  let nextPtr = 1024;
  let lifecycle = Lifecycle.Boot;
  let canLoadEarlier = 0;
  // Protocol v19 (plan #760) — mirrors the Wasm scalar: default true (legacy
  // auto-promote) until the host arms it false on a Stop/error Ready.
  let promoteAllowed = true;
  const messages: { kind: number; text: string }[] = [];
  const statusSlots: (string | undefined)[] = new Array(8).fill(undefined);
  // plan #759 — operator follow-up FIFO mirror (inv_queued_insert_front unshifts).
  const queue: string[] = [];

  const gpa_u8 = (len: number) => {
    if (len <= 0) return 0;
    const ptr = nextPtr;
    nextPtr += len + 16;
    if (ptr + len > buf.byteLength) {
      const bigger = new ArrayBuffer(Math.max(buf.byteLength * 2, ptr + len + 1024));
      new Uint8Array(bigger).set(new Uint8Array(buf));
      buf = bigger;
    }
    return ptr;
  };

  const read = (ptr: number, len: number) =>
    new TextDecoder().decode(new Uint8Array(buf, ptr, len));

  return {
    memory,
    gpa_u8,
    gpa_free: () => {},
    inv_protocol_version: () => HARNESS_PROTOCOL_VERSION,
    inv_ping: (x: number) => (x | 0) ^ INV_PING_XOR,
    inv_set_lifecycle: (s: number) => {
      lifecycle = s as Lifecycle;
    },
    inv_get_lifecycle: () => lifecycle,
    inv_message_count: () => messages.length,
    inv_message_kind_at: (i: number) => (messages[i]?.kind ?? 0),
    inv_message_text_len_at: (i: number) =>
      new TextEncoder().encode(messages[i]?.text ?? '').length,
    inv_message_text_copy_at: (i: number, outPtr: number, maxLen: number) => {
      const text = messages[i]?.text ?? '';
      const bytes = new TextEncoder().encode(text);
      const n = Math.min(maxLen, bytes.length);
      if (n > 0) new Uint8Array(buf, outPtr, n).set(bytes.slice(0, n));
      return n;
    },
    inv_begin_batch: () => {},
    inv_end_batch: () => {},
    inv_push_message: (kind: number, ptr: number, len: number) => {
      messages.push({ kind, text: len === 0 ? '' : read(ptr, len) });
    },
    inv_update_last_message: (kind: number, ptr: number, len: number) => {
      if (messages.length === 0) return 0;
      const last = messages[messages.length - 1]!;
      if (last.kind !== kind) return 0;
      last.text = len === 0 ? '' : read(ptr, len);
      return 1;
    },
    inv_clear_messages: () => {
      messages.length = 0;
      queue.length = 0;
      promoteAllowed = true;
    },
    inv_clear_ring: () => {
      messages.length = 0;
    },
    inv_echo: () => 0,
    inv_echo_len: () => 0,
    inv_echo_copy: () => 0,
    inv_has_pending_submit: () => 0,
    inv_pending_submit_len: () => 0,
    inv_pending_submit_copy: () => 0,
    inv_ack_pending_submit: () => {},
    inv_queued_count: () => queue.length,
    inv_set_queue_promote_allowed: (v: number) => {
      promoteAllowed = v !== 0;
    },
    inv_queued_insert_front: (ptr: number, len: number) => {
      queue.unshift(len === 0 ? '' : read(ptr, len));
      return 1;
    },
    inv_set_can_load_earlier: (v: number) => {
      canLoadEarlier = v ? 1 : 0;
    },
    inv_has_pending_load_earlier: () => 0,
    inv_ack_pending_load_earlier: () => {},
    inv_has_pending_cancel: () => 0,
    inv_ack_pending_cancel: () => {},
    inv_clear_model_catalog: () => {},
    inv_push_model_catalog_entry: () => 0,
    inv_model_catalog_count: () => 0,
    inv_selected_model_len: () => 0,
    inv_selected_model_copy: () => 0,
    inv_cycle_selected_model: () => 0,
    inv_set_selected_model: (_ptr, len) => (len <= 128 ? 1 : 0),
    inv_has_pending_model_change: () => 0,
    inv_ack_pending_model_change: () => {},
    inv_clear_session_catalog: () => {},
    inv_push_session_catalog_entry: () => 0,
    inv_session_catalog_count: () => 0,
    inv_set_current_session: () => 0,
    inv_has_pending_session_switch: () => 0,
    inv_pending_session_switch_len: () => 0,
    inv_pending_session_switch_copy: () => 0,
    inv_ack_pending_session_switch: () => {},
    inv_set_status_slot: (slot, ptr, len) => {
      if (slot < 0 || slot >= 8) return 0;
      if (len > 96) return 0;
      statusSlots[slot] = len === 0 ? undefined : read(ptr, len);
      return 1;
    },
    inv_status_slot_len: (slot) => {
      if (slot < 0 || slot >= 8 || statusSlots[slot] == null) return 0;
      return statusSlots[slot]!.length;
    },
    inv_status_slot_copy: (slot, outPtr, maxLen) => {
      if (slot < 0 || slot >= 8 || statusSlots[slot] == null) return 0;
      const v = statusSlots[slot]!;
      const n = Math.min(maxLen, v.length);
      if (n > 0) new Uint8Array(buf, outPtr, n).set(new TextEncoder().encode(v).slice(0, n));
      return n;
    },
    inv_status_slots_clear: () => {
      for (let i = 0; i < 8; i++) statusSlots[i] = undefined;
    },
    inv_set_turn_elapsed: () => {},
    inv_set_busy_tick: () => {},
    inv_image_cache_put: () => 0,
    inv_image_cache_clear: () => {},
    inv_math_cache_put: () => 0,
    inv_math_cache_clear: () => {},
    __messages: messages,
    __lifecycle: () => lifecycle,
    __canLoadEarlier: () => canLoadEarlier,
    __statusSlots: statusSlots,
    __promoteAllowed: () => promoteAllowed,
    __queue: queue,
  };
}

function statusSlotAt(exp: ReturnType<typeof makeMockExports>, slot: number): string {
  return exp.__statusSlots[slot] ?? '';
}

describe('describeTurnEnd / classifyTurnFailure', () => {
  it('labels model / stop / error clearly', () => {
    expect(describeTurnEnd('model')).toBe('Turn ended · model finished');
    expect(describeTurnEnd('stop')).toBe('Turn ended · you stopped');
    expect(describeTurnEnd('error', 'boom')).toBe('Turn ended · error · boom');
    expect(isTurnEndLine(describeTurnEnd('chat'))).toBe(true);
  });

  it('classifies cancel and timeout', () => {
    expect(classifyTurnFailure('Request cancelled.', 499).kind).toBe('stop');
    expect(classifyTurnFailure('Gateway timeout', 504).kind).toBe('timeout');
    expect(classifyTurnFailure('down', 502).kind).toBe('error');
    const detach = new AbortController();
    detach.abort('detach');
    expect(classifyTurnFailure('Request cancelled.', undefined, detach.signal).kind).toBe(
      'detach',
    );
    const stop = new AbortController();
    stop.abort();
    expect(classifyTurnFailure('Request cancelled.', undefined, stop.signal).kind).toBe('stop');
  });
});

describe('toolTrace host display', () => {
  it('soft-truncates oversize summaries and keeps all non-empty lines', () => {
    const long = 'x'.repeat(TOOL_TRACE_SUMMARY_MAX_CHARS + 50);
    expect(truncateToolTraceSummary(long).length).toBeLessThanOrEqual(
      TOOL_TRACE_SUMMARY_MAX_CHARS,
    );
    const many = Array.from({ length: 10 }, (_, i) => ({
      name: `t${i}`,
      ok: true,
      summary: i === 0 ? '' : `line ${i}`,
    }));
    const lines = selectToolTraceLines(many);
    expect(lines.length).toBe(9);
    expect(lines.every((l) => l.length > 0)).toBe(true);
    expect(lines[0]).toBe('line 1');
  });
});

describe('runHarnessChat', () => {
  it('pushes user + assistant and returns to ready on success', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'PONG' }));

    const result = await runHarnessChat(bridge, '  Reply with exactly: PONG  ', { send });

    expect(result).toEqual({ ok: true, text: 'PONG' });
    expect(send).toHaveBeenCalledWith('Reply with exactly: PONG', expect.any(Object));
    expect(exp.__messages).toEqual([
      { kind: MessageKind.User, text: 'Reply with exactly: PONG' },
      { kind: MessageKind.Assistant, text: 'PONG' },
      { kind: MessageKind.System, text: describeTurnEnd('chat') },
    ]);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
  });

  it('folds history into Gateway prompt', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (_prompt: string): Promise<ChatResult> => ({
      ok: true,
      text: '2',
    }));

    await runHarnessChat(bridge, 'again', {
      send,
      history: [
        { id: '1', role: 'user', text: 'ping', at: 1 },
        { id: '2', role: 'assistant', text: 'pong', at: 2 },
      ],
    });

    expect(send).toHaveBeenCalled();
    const sent = String(send.mock.calls[0]?.[0] ?? '');
    expect(sent).toContain('User: ping');
    expect(sent).toContain('Assistant: pong');
    expect(sent).toContain('User: again');
  });

  it('pushes ember error message and lands on Error on give-up (plan #759)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (): Promise<ChatResult> => ({
      ok: false,
      error: 'AI_GATEWAY_API_KEY is not configured.',
      status: 503,
    }));

    const result = await runHarnessChat(bridge, 'hello', { send });

    expect(result.ok).toBe(false);
    expect(exp.__messages).toEqual([
      { kind: MessageKind.User, text: 'hello' },
      {
        kind: MessageKind.Error,
        text: describeTurnEnd('error', 'AI_GATEWAY_API_KEY is not configured.'),
      },
    ]);
    // plan #759 — a failed turn lands on Error (give-up), never Ready, so the
    // Wasm promote gate (Ready-only) never consumes a queued item. The operator
    // can still re-send (Error is not Busy).
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
    expect(exp.__queue).toHaveLength(0); // empty queue → no Continue insert
  });

  it('rejects empty prompt without calling send', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'nope' }));

    const result = await runHarnessChat(bridge, '   ', { send });

    expect(result.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(exp.__messages[0]?.kind).toBe(MessageKind.Error);
  });
});

describe('protocol v19 promote gate arming (plan #760)', () => {
  it('runHarnessChat success arms promote_allowed=true then Ready', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'PONG' }));
    await runHarnessChat(bridge, 'hi', { send });
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(exp.__promoteAllowed()).toBe(true); // success → auto-promote stays
  });

  it('runHarnessChat give-up (agent error) arms promote_allowed=false then lands Error (plan #759 supersedes #760)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (): Promise<ChatResult> => ({
      ok: false,
      error: 'AI_GATEWAY_API_KEY is not configured.',
      status: 503,
    }));
    await runHarnessChat(bridge, 'hello', { send });
    // A non-stop failure is a give-up → Error (never terminal for the promote
    // gate, so a queued head is never drained). The gate is STILL armed false
    // (plan #760) so a later Stop→Ready also cannot auto-drain.
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
    expect(exp.__promoteAllowed()).toBe(false); // failure / stop → never drain
  });

  it('runHarnessTurn agent success arms promote_allowed=true then Ready', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({ ok: true, text: 'PONG' }));
    await runHarnessTurn(bridge, createEmptySession(), 'hi', { sendAgent });
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(exp.__promoteAllowed()).toBe(true); // success → auto-promote stays
  });

  it('runHarnessTurn Stop (Request cancelled.) arms promote_allowed=false then Ready — no queue drain', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      error: 'Request cancelled.',
      status: 499,
    }));
    const { result } = await runHarnessTurn(bridge, createEmptySession(), 'x', {
      sendAgent,
    });
    expect(result.ok).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    // A user Stop must never drain a queued head — the Wasm terminal-promote
    // block is gated on this scalar.
    expect(exp.__promoteAllowed()).toBe(false);
  });

  it('runHarnessTurn validation arms promote_allowed=false then Ready', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // Actually route through runHarnessTurn (adversarial #763 Nit: the old test
    // called runHarnessChat, so the runHarnessTurn validatePrompt branch was
    // untested under its own name). A blank prompt fails validation BEFORE any
    // agent/chat send, armor false, and land on Ready.
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({ ok: true, text: 'NOPE' }));
    const { result } = await runHarnessTurn(bridge, createEmptySession(), '   ', { sendAgent });
    expect(result.ok).toBe(false);
    expect(sendAgent).not.toHaveBeenCalled(); // validatePrompt short-circuits before any send
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(exp.__promoteAllowed()).toBe(false);
  });
});

describe('runHarnessTurn', () => {
  it('appends user + assistant to session (agent path)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'PONG',
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'NOPE' }));
    const session = createEmptySession('s1');

    const { result, session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      send,
    });

    expect(result.ok).toBe(true);
    expect(sendAgent).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'system']);
    expect(next.messages.at(-1)!.text).toBe(describeTurnEnd('model'));
    expect(next.messages[1]?.text).toBe('PONG');
  });

  it('aggregates toolTrace into one tool_run then assistant on agent success', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'wrote file',
      toolTrace: [
        { name: 'write_file', ok: true, summary: 'write_file hello.txt ok' },
        { name: 'exec', ok: true, summary: 'exec cat exit=0' },
      ],
    }));

    const { session: next } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'do it',
      { sendAgent, pushUser: false },
    );

    // Per-tool System lines are replaced by one display-only tool_run message.
    expect(next.messages.map((m) => m.role)).toEqual([
      'user',
      'tool_run',
      'assistant',
      'system',
    ]);
    expect(next.messages.at(-1)!.text).toBe(describeTurnEnd('model'));
    const toolRun = next.messages.find((m) => m.role === 'tool_run');
    expect(toolRun).toBeDefined();
    const decoded = decodeToolRun(toolRun!.text);
    expect(decoded).not.toBeNull();
    expect(decoded!.items.map((it) => it.name)).toEqual(['write_file', 'exec']);
    expect(decoded!.ok).toBe(2);
    expect(exp.__messages.map((m) => m.kind)).toEqual([
      MessageKind.ToolRun,
      MessageKind.Assistant,
      MessageKind.System,
    ]);
  });

  it('agent hard failure does NOT fall back to chat (hard-fail, phase 3 #476)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // plan #759 — permanent 422 so this terminal/no-fallback test stays
    // single-attempt (retryable 5xx would retry TURN_RETRY_ATTEMPTS times).
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 422,
      error: 'Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.',
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'PONG' }));

    const { result, session: next } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'hi',
      { sendAgent, send, pushUser: false },
    );

    expect(sendAgent).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'error']);
    expect(exp.__messages.some((m) => m.kind === MessageKind.Error)).toBe(true);
  });

  it('agent hard failure does not call chat', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // plan #759 — permanent 422 (terminal); 5xx is retryable and would loop.
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 422,
      error: 'boom',
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'nope' }));

    const { result, session: next } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'x',
      { sendAgent, send, pushUser: false },
    );

    expect(send).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'error']);
    expect(exp.__messages.some((m) => m.kind === MessageKind.Error)).toBe(true);
  });

  it('hard failure with non-exact body does not call chat', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // Any failed agent turn hard-fails (phase 3 #476) — no fallback, regardless
    // of the error body shape. plan #759: permanent 422 (terminal; 5xx would retry).
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 422,
      error: 'Upstream overloaded',
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'nope' }));

    const { result, session: next } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'x',
      { sendAgent, send, pushUser: false },
    );

    expect(send).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: 'Upstream overloaded', status: 422 });
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'error']);
    expect(exp.__messages.some((m) => m.kind === MessageKind.Error)).toBe(true);
  });

  it('agent cancel does not fall back to chat', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      error: 'Request cancelled.',
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'nope' }));

    await runHarnessTurn(bridge, createEmptySession(), 'x', {
      sendAgent,
      send,
      pushUser: false,
    });

    expect(send).not.toHaveBeenCalled();
  });

  it('aggregates a large toolTrace into one bounded tool_run group', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const n = 40;
    const toolTrace = Array.from({ length: n }, (_, i) => ({
      name: `t${i}`,
      ok: true,
      summary: `step ${i}`,
    }));
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'done',
      toolTrace,
    }));

    const { session: next } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'go',
      { sendAgent, pushUser: false },
    );

    const toolRuns = next.messages.filter((m) => m.role === 'tool_run');
    expect(toolRuns).toHaveLength(1);
    const decoded = decodeToolRun(toolRuns[0]!.text);
    expect(decoded).not.toBeNull();
    expect(decoded!.items).toHaveLength(n);
    // Turn-end System line still present, and no bare per-tool System rows remain.
    expect(next.messages.some((m) => m.role === 'system' && isTurnEndLine(m.text))).toBe(true);
    expect(
      next.messages.filter((m) => m.role === 'system' && !isTurnEndLine(m.text)),
    ).toHaveLength(0);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.ToolRun)).toHaveLength(1);
  });

  it('history fold includes system tool lines for continue', async () => {
    let session = createEmptySession();
    session = appendMessage(session, 'user', 'first');
    session = appendMessage(session, 'system', 'write_file a ok');
    session = appendMessage(session, 'assistant', 'done');

    const folded = formatPromptWithHistory(session.messages, 'second');
    expect(folded).toContain('Tool: write_file a ok');
    expect(folded).toContain('User: first');
    expect(folded).toContain('Assistant: done');
    expect(folded).toContain('User: second');

    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (prompt: string): Promise<AgentResult> => {
      expect(prompt).toContain('write_file a ok');
      return { ok: true, text: 'ok2' };
    });

    await runHarnessTurn(bridge, session, 'second', {
      sendAgent,
      pushUser: false,
    });
    expect(sendAgent).toHaveBeenCalled();
  });

  it('appends turn-end error reason on failure', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 422, // plan #759 — permanent (terminal); generic/5xx would retry
      error: 'down',
    }));

    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'x', {
      sendAgent,
    });
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'error']);
    expect(next.messages[1]!.text).toBe(describeTurnEnd('error', 'down'));
    expect(exp.__messages.some((m) => m.text === describeTurnEnd('error', 'down'))).toBe(true);
  });

  it('pushUser:false does not double-paint user on bridge', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'PONG',
    }));

    await runHarnessTurn(bridge, createEmptySession(), 'hello', {
      sendAgent,
      pushUser: false,
    });

    const userPushes = exp.__messages.filter((m) => m.kind === MessageKind.User);
    expect(userPushes).toHaveLength(0);
    expect(exp.__messages.some((m) => m.kind === MessageKind.Assistant)).toBe(true);
  });

  it('preferAgent false uses chat only', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'agent',
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'chat' }));

    const { result } = await runHarnessTurn(bridge, createEmptySession(), 'hi', {
      preferAgent: false,
      sendAgent,
      send,
    });

    expect(sendAgent).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, text: 'chat' });
  });

  it('does not fall back to chat on 403 sandbox forbidden', async () => {
    const mock = makeMockExports();
    const bridge = new HarnessBridge(mock);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      error: SANDBOX_FORBIDDEN_ERROR,
      status: 403,
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({
      ok: true,
      text: 'should-not-run',
    }));
    const { result, session: next } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'hi',
      { sendAgent, send, pushUser: false },
    );
    expect(sendAgent).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(SANDBOX_FORBIDDEN_ERROR);
      expect(result.status).toBe(403);
    }
    expect(next.messages.some((m) => m.role === 'error')).toBe(true);
    expect(mock.__messages.some((m) => m.kind === MessageKind.Error)).toBe(true);
  });

  it('does not fall back to chat on 401 auth required', async () => {
    const mock = makeMockExports();
    const bridge = new HarnessBridge(mock);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      error: AUTH_REQUIRED_ERROR,
      status: 401,
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({
      ok: true,
      text: 'should-not-run',
    }));
    const { result, session: next } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'hi',
      { sendAgent, send, pushUser: false },
    );
    expect(sendAgent).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(AUTH_REQUIRED_ERROR);
      expect(result.status).toBe(401);
    }
    expect(next.messages.some((m) => m.role === 'error')).toBe(true);
    expect(mock.__messages.some((m) => m.kind === MessageKind.Error)).toBe(true);
  });

  it('forwards modelId to sendAgent', async () => {
    const mock = makeMockExports();
    const bridge = new HarnessBridge(mock);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'agent-ok',
      toolTrace: [],
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({
      ok: true,
      text: 'should-not-run',
    }));
    await runHarnessTurn(bridge, createEmptySession(), 'hi', {
      sendAgent,
      send,
      pushUser: false,
      modelId: 'anthropic/claude-a',
    });
    expect(sendAgent).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ modelId: 'anthropic/claude-a' }),
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe('plan #759 — turn errors retry the current turn, never drain the queue', () => {
  /** Run a retry-looping turn under deterministic fake timers (the real
   *  250ms–4s bounded backoff would breach the 5 s vitest default per-test
   *  timeout while the loop runs). Always advances well past the total backoff. */
  async function runRetry<T>(fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    try {
      const pending = fn();
      await vi.advanceTimersByTimeAsync(60_000);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  it('retries a retryable 500 then succeeds on attempt 3 (no user re-push; queue untouched until success)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    exp.__queue.push('queued follow-up');
    let n = 0;
    const sendAgent = vi.fn(async (): Promise<AgentResult> => {
      n += 1;
      if (n < 3) return { ok: false, status: 500, error: 'Gateway upstream flaked' };
      return { ok: true, text: 'finished' };
    });
    const { result, session: next } = await runRetry(() =>
      runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
        sendAgent,
        pushUser: false,
        streamAgent: false,
      }),
    );
    expect(result.ok).toBe(true);
    expect(sendAgent).toHaveBeenCalledTimes(3); // 1 + 2 retries before success
    // Retries never re-push the user line (single user row in the session).
    expect(next.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    // The queue is NEVER consumed by a failure — intact until a successful Ready.
    expect(exp.__queue).toEqual(['queued follow-up']);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready); // success → Ready
    expect(next.messages.at(-1)!.text).toBe(describeTurnEnd('model'));
  });

  it('gives up after 5 retryable failures: Error lifecycle + Continue inserted at QUEUE HEAD (never pops)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    exp.__queue.push('op item A');
    exp.__queue.push('op item B');
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 500,
      error: 'flaked',
    }));
    const { result, session: next } = await runRetry(() =>
      runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
        sendAgent,
        pushUser: false,
        streamAgent: false,
      }),
    );
    expect(result.ok).toBe(false);
    expect(sendAgent).toHaveBeenCalledTimes(5); // 1 + 4 retries
    expect(exp.__lifecycle()).toBe(Lifecycle.Error); // give-up is NOT Ready
    // Queue depth unchanged (no pop) + Continue unshifted as the new head.
    expect(exp.__queue).toEqual([
      CONTINUE_TURN_PROMPT,
      'op item A',
      'op item B',
    ]);
    expect(next.messages.some((m) => m.role === 'error')).toBe(true);
    expect(next.messages.at(-1)!.text).toBe(describeTurnEnd('error', 'flaked'));
  });

  it('gives up after 5 retries with an EMPTY queue: stop, no Continue insert', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 503,
      error: 'flaked',
    }));
    const { result } = await runRetry(() =>
      runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
        sendAgent,
        pushUser: false,
        streamAgent: false,
      }),
    );
    expect(result.ok).toBe(false);
    expect(sendAgent).toHaveBeenCalledTimes(5);
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
    expect(exp.__queue).toEqual([]); // empty queue → no Continue row
  });

  it('queue FULL (16) at give-up: no insert, no pop — operator items untouched (fail closed)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    for (let i = 0; i < HARNESS_QUEUE_MAX_ITEMS; i++) exp.__queue.push(`item ${i}`);
    const before = [...exp.__queue];
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 500,
      error: 'flaked',
    }));
    await runRetry(() =>
      runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
        sendAgent,
        pushUser: false,
        streamAgent: false,
      }),
    );
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
    expect(exp.__queue).toEqual(before); // no insert, no pop, no drop
    expect(exp.__queue[0]).not.toBe(CONTINUE_TURN_PROMPT);
  });

  it('operator Stop on attempt 1: no retry, no Continue, queue intact, Ready (unchanged)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    exp.__queue.push('queued item');
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      error: 'Request cancelled.',
      status: 499,
    }));
    const { result } = await runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(result.ok).toBe(false);
    expect(sendAgent).toHaveBeenCalledTimes(1); // Stop never retries
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready); // Stop keeps Ready as today
    expect(exp.__queue).toEqual(['queued item']); // untouched, no Continue
  });

  it('permanent 401/403: single attempt, straight to give-up (no 5× loop) + Continue-if-queued', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    exp.__queue.push('op');
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 401,
      error: 'unauthorized',
    }));
    const { result } = await runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(result.ok).toBe(false);
    expect(sendAgent).toHaveBeenCalledTimes(1); // no 5× loop on permanent auth
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
    expect(exp.__queue[0]).toBe(CONTINUE_TURN_PROMPT); // give-up + non-empty queue
  });

  it('a retryable TIMEOUT (408) also retries then gives up with Continue (timeout is not permanent)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    exp.__queue.push('op');
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 408,
      error: 'Gateway timeout',
    }));
    const { result } = await runRetry(() =>
      runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
        sendAgent,
        pushUser: false,
        streamAgent: false,
      }),
    );
    expect(result.ok).toBe(false);
    expect(sendAgent).toHaveBeenCalledTimes(5);
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
    expect(exp.__queue[0]).toBe(CONTINUE_TURN_PROMPT);
  });

  it('classifyTurnRetry is the narrow turn predicate (permanent vs retryable statuses)', () => {
    // Non-AgentRetryError input (e.g. withTransientRetry's own abort) fails
    // closed to permanent — the turn never loops on something it can't classify.
    expect(classifyTurnRetry(new Error('x')).kind).toBe('permanent');
    expect(classifyTurnRetry('string').kind).toBe('permanent');
    // Adversarial #844 Nit: detach/stop are permanent even when the HTTP
    // status is missing (pre-paint AbortError). A 5xx error stays retryable;
    // C15 409 is permanent. Pinning AgentRetryError — not only signal.aborted.
    expect(classifyTurnRetry(new AgentRetryError('Request cancelled.', undefined, 'detach')).kind).toBe(
      'permanent',
    );
    expect(classifyTurnRetry(new AgentRetryError('Request cancelled.', undefined, 'stop')).kind).toBe(
      'permanent',
    );
    expect(classifyTurnRetry(new AgentRetryError('flaked', 500, 'error')).kind).toBe('retryable');
    expect(classifyTurnRetry(new AgentRetryError('live lock', 409, 'error')).kind).toBe('permanent');
  });

  it('a LIVE stream that painted then fails is NOT retried (single attempt, no tool/bubble duplication) [adversarial-review Major L1]', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    exp.__queue.push('op item A');
    let calls = 0;
    // Production path is `streamAgent: true` (SSE). Attempt 1 emits a tool card
    // + a text delta (both PAINT to the ring), then returns a retryable 500.
    // Because content already painted, retrying the SAME prompt onto the SAME
    // ring would re-run the tool (side-effect duplication) and push a duplicate
    // assistant bubble. The failure must classify PERMANENT → exactly 1 send.
    const sendAgentStream = vi.fn(
      async (
        _prompt: string,
        init?: { onEvent?: (event: AgentStreamEvent) => void | Promise<void> },
      ): Promise<AgentResult> => {
        calls += 1;
        await init?.onEvent?.({ type: 'tool_start', name: 'exec' });
        await init?.onEvent?.({ type: 'text_delta', text: 'partial reply' });
        return { ok: false, status: 500, error: 'flaked after paint' };
      },
    );
    const { result } = await runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
      sendAgentStream,
      pushUser: false,
      streamAgent: true,
    });
    expect(result.ok).toBe(false);
    expect(sendAgentStream).toHaveBeenCalledTimes(1); // painted → permanent, no retry
    expect(calls).toBe(1);
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
    // Give-up with non-empty queue inserts Continue at head; no attempt 2.
    expect(exp.__queue[0]).toBe(CONTINUE_TURN_PROMPT);
    // Exactly ONE tool card + ONE assistant bubble — the re-send never happened.
    expect(exp.__messages.filter((m) => m.kind === MessageKind.ToolRun)).toHaveLength(1);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.Assistant)).toHaveLength(1);
  });

  it('a live stream that fails BEFORE painting anything still retries (5 attempts) [adversarial-review Minor L6]', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    exp.__queue.push('op item A');
    let calls = 0;
    // Stream that NEVER emits a ring-painting event before failing with a
    // retryable 503 (gateway not ready, nothing painted) → cleanly retryable.
    const sendAgentStream = vi.fn(async (): Promise<AgentResult> => {
      calls += 1;
      return { ok: false, status: 503, error: 'gateway not ready' };
    });
    const { result } = await runRetry(() =>
      runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
        sendAgentStream,
        pushUser: false,
        streamAgent: true,
      }),
    );
    expect(result.ok).toBe(false);
    expect(sendAgentStream).toHaveBeenCalledTimes(5); // nothing painted → retry loop preserved
    expect(calls).toBe(5);
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
    expect(exp.__queue[0]).toBe(CONTINUE_TURN_PROMPT);
  });
});

describe('modelId forwarding', () => {
  it('forwards modelId to send', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'ok' }));
    await runHarnessChat(bridge, 'hi', { send, modelId: 'anthropic/claude-a' });
    expect(send).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ modelId: 'anthropic/claude-a' }),
    );
  });
});

describe('pushSessionToBridge window (protocol v6)', () => {
  it('hydrates at most HARNESS_RING_MAX messages from the latest window', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const total = HARNESS_RING_MAX + 12;
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: Array.from({ length: total }, (_, i) => makeMessage('user', `m${i}`)),
    };
    const start = pushSessionToBridge(bridge, session, { clear: true });
    expect(start).toBe(12);
    expect(exp.__messages).toHaveLength(HARNESS_RING_MAX);
    expect(exp.__messages[0]!.text).toBe('m12');
    expect(exp.__messages[HARNESS_RING_MAX - 1]!.text).toBe(`m${total - 1}`);
    expect(exp.__canLoadEarlier()).toBe(1);
  });

  it('earlier windowStart surfaces older turns and clears can-load at 0', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const total = HARNESS_RING_MAX + 12;
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: Array.from({ length: total }, (_, i) => makeMessage('user', `m${i}`)),
    };
    const start = pushSessionToBridge(bridge, session, { clear: true, windowStart: 0 });
    expect(start).toBe(0);
    expect(exp.__messages).toHaveLength(HARNESS_RING_MAX);
    expect(exp.__messages[0]!.text).toBe('m0');
    expect(exp.__messages[HARNESS_RING_MAX - 1]!.text).toBe(`m${HARNESS_RING_MAX - 1}`);
    expect(exp.__canLoadEarlier()).toBe(0);
  });

  it('short session leaves can-load false', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: Array.from({ length: 10 }, (_, i) => makeMessage('user', `m${i}`)),
    };
    const start = pushSessionToBridge(bridge, session, { clear: true });
    expect(start).toBe(0);
    expect(exp.__messages).toHaveLength(10);
    expect(exp.__canLoadEarlier()).toBe(0);
  });
});

describe('runHarnessTurn stream agent (phase 1)', () => {
  it('aggregates stream tool events into one tool_run and grows one assistant bubble', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();

    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'list files', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'list_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'list_dir',
          ok: true,
          summary: 'list_dir · ok · a.txt',
        });
        await init?.onEvent?.({ type: 'text_delta', text: 'Here' });
        await init?.onEvent?.({ type: 'text_delta', text: ' you go' });
        await init?.onEvent?.({ type: 'done', text: 'Here you go' });
        return { ok: true, text: 'Here you go' };
      },
    });

    expect(result.result.ok).toBe(true);
    // One aggregated ToolRun message (not bare System tool rows).
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    expect(toolRuns).toHaveLength(1);
    const decoded = decodeToolRun(toolRuns[0]!.text);
    expect(decoded).not.toBeNull();
    expect(decoded!.items).toHaveLength(1);
    expect(decoded!.items[0]!.name).toBe('list_dir');
    expect(decoded!.items[0]!.status).toBe('ok');
    // Session persists the tool_run group (display-only role).
    expect(result.session.messages.some((m) => m.role === 'tool_run')).toBe(true);
    // Single assistant bubble with full text.
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe('Here you go');
    expect(exp.__messages.some((m) => m.text === describeTurnEnd('model'))).toBe(true);
  });

  it('grows Thinking on reasoning_delta then tools then assistant', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'think', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'reasoning_delta', text: 'Hmm' });
        await init?.onEvent?.({ type: 'reasoning_delta', text: '…' });
        await init?.onEvent?.({ type: 'tool_start', name: 'list_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'list_dir',
          ok: true,
          summary: 'list_dir · ok · a',
        });
        await init?.onEvent?.({ type: 'text_delta', text: 'Done' });
        await init?.onEvent?.({ type: 'done', text: 'Done' });
        return { ok: true, text: 'Done' };
      },
    });
    expect(result.result.ok).toBe(true);
    const thinking = exp.__messages.filter((m) => m.kind === MessageKind.Thinking);
    expect(thinking).toHaveLength(1);
    // Short monologue stays short after collapse-on-close.
    expect(thinking[0]!.text).toBe('Hmm…');
    expect(exp.__messages.some((m) => m.kind === MessageKind.System)).toBe(true);
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    expect(assistants.some((m) => m.text === 'Done')).toBe(true);
    // Session must not store thinking lines
    expect(
      result.session.messages.every(
        (m) =>
          m.role !== 'system' ||
          m.text.includes('list_dir') ||
          isTurnEndLine(m.text),
      ),
    ).toBe(true);
    expect(result.session.messages.some((m) => m.text.includes('Hmm'))).toBe(false);
  });

  it('keeps full thinking when tools supersede the segment', async () => {
    const long = 'A'.repeat(300);
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    await runHarnessTurn(bridge, session, 'collapse', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'reasoning_delta', text: long });
        await init?.onEvent?.({ type: 'tool_start', name: 'list_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'list_dir',
          ok: true,
          summary: 'list_dir · ✓ ok · a',
        });
        await init?.onEvent?.({ type: 'done', text: 'ok' });
        return { ok: true, text: 'ok' };
      },
    });
    const thinking = exp.__messages.filter((m) => m.kind === MessageKind.Thinking);
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.text).toBe(long);
  });

  it('keeps all thinking segments per turn (no overflow notice)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const n = 20;
    await runHarnessTurn(bridge, session, 'cap', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        for (let i = 0; i < n; i++) {
          await init?.onEvent?.({ type: 'reasoning_delta', text: `seg${i} long enough` });
          await init?.onEvent?.({ type: 'tool_start', name: `t${i}` });
          await init?.onEvent?.({
            type: 'tool_result',
            name: `t${i}`,
            ok: true,
            summary: `t${i} · ✓ ok`,
          });
        }
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });
    const thinking = exp.__messages.filter((m) => m.kind === MessageKind.Thinking);
    expect(thinking).toHaveLength(n);
    expect(
      exp.__messages.some(
        (m) =>
          m.kind === MessageKind.System &&
          m.text.includes('+ more thinking'),
      ),
    ).toBe(false);
  });

  it('interleaved reasoning splits tools into separate live cards, each painted on its event (#433)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const n = 5;
    const result = await runHarnessTurn(bridge, session, 'interleave', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        for (let i = 0; i < n; i++) {
          await init?.onEvent?.({ type: 'reasoning_delta', text: `seg${i}` });
          // A thinking row lands last → this tool opens a NEW card at 1 (not a
          // clone, not a grow of a committed thought-separated card).
          await init?.onEvent?.({ type: 'tool_start', name: `t${i}` });
          await init?.onEvent?.({
            type: 'tool_result',
            name: `t${i}`,
            ok: true,
            summary: `t${i} · ✓ ok`,
          });
          // Live paint: a kind-6 row EXISTS during the turn (never withheld to a
          // boundary), and with a thinking row between tools each tool is its own
          // size-1 card — but never a "1, 1+2, 1+2+3" progressive clone of the same
          // streak, because the last painted row at each tool is a fresh thinking row.
          const runs = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
          expect(runs).toHaveLength(i + 1);
          for (let k = 0; k < runs.length; k++) {
            const d = decodeToolRun(runs[k]!.text);
            expect(d).not.toBeNull();
            expect(d!.items).toHaveLength(1); // thinking split → each card is size 1
            expect(d!.ok).toBe(1);
          }
        }
        await init?.onEvent?.({ type: 'text_delta', text: 'done' });
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });
    expect(result.result.ok).toBe(true);
    // #433 lock: thinking (a non-tool row) last opens a NEW card at 1 per tool —
    // N separate size-1 cards on the bridge, never a single size-N row (commit-once
    // held tools in host memory across thinking and is removed).
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    expect(toolRuns).toHaveLength(n);
    const totalOk = toolRuns.reduce((acc, tr) => acc + (decodeToolRun(tr.text)?.ok ?? 0), 0);
    expect(totalOk).toBe(n);
    // Session mirrors: one display-only tool_run per live card.
    const sessionRuns = result.session.messages.filter((m) => m.role === 'tool_run');
    expect(sessionRuns).toHaveLength(n);
    expect(
      result.session.messages.some(
        (m) => m.role === 'assistant' && m.text === 'done',
      ),
    ).toBe(true);
    // Thinking is ephemeral — one bubble per reasoning block, none persisted, and
    // it never suppressed the live tool cards.
    expect(exp.__messages.filter((m) => m.kind === MessageKind.Thinking)).toHaveLength(n);
    expect(result.session.messages.some((m) => m.text.includes('seg'))).toBe(false);
    const folded = formatPromptWithHistory(result.session.messages, 'continue');
    expect(folded).not.toContain('Tool:');
  });

  it('contiguous no-reasoning streak paints ONE live card that increments to N tools called (#433)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const n = 4;
    const result = await runHarnessTurn(bridge, session, 'tools', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        for (let i = 0; i < n; i++) {
          await init?.onEvent?.({ type: 'tool_start', name: `t${i}` });
          await init?.onEvent?.({
            type: 'tool_result',
            name: `t${i}`,
            ok: true,
            summary: `t${i} · ✓ ok`,
          });
          // Live paint: ONE kind-6 row exists during the turn, grown in place.
          // Its total is i+1 — NOT withheld until assistant text (commit-once dropped).
          const runs = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
          expect(runs).toHaveLength(1);
          const d = decodeToolRun(runs[0]!.text);
          expect(d).not.toBeNull();
          expect(d!.items).toHaveLength(i + 1);
          expect(d!.ok).toBe(i + 1);
        }
        await init?.onEvent?.({ type: 'text_delta', text: 'done' });
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });
    expect(result.result.ok).toBe(true);
    // Contiguous (no-reasoning) streak: still exactly one complete N-item card on
    // the bridge — but it was painted LIVE (growing 1→2→3→4 during the turn), not
    // committed at assistant text. No N×1 stack, no "nothing, then all tools".
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    expect(toolRuns).toHaveLength(1);
    const decoded = decodeToolRun(toolRuns[0]!.text);
    expect(decoded).not.toBeNull();
    expect(decoded!.items).toHaveLength(n);
    const kinds = exp.__messages.map((m) => m.kind);
    expect(kinds.indexOf(MessageKind.ToolRun) + 1).toBe(kinds.indexOf(MessageKind.Assistant));
    const sessionRuns = result.session.messages.filter((m) => m.role === 'tool_run');
    expect(sessionRuns).toHaveLength(1);
    const sessDecoded = decodeToolRun(sessionRuns[0]!.text);
    expect(sessDecoded).not.toBeNull();
    expect(sessDecoded!.items).toHaveLength(n);
  });

  it('real assistant text still ends the group; a later tool opens a new group', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'twogroups', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'read_file' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'read_file',
          ok: true,
          summary: 'read_file · ✓ ok',
        });
        await init?.onEvent?.({ type: 'text_delta', text: 'I read the file.' });
        await init?.onEvent?.({ type: 'tool_start', name: 'write_file' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'write_file',
          ok: true,
          summary: 'write_file · ✓ ok',
        });
        await init?.onEvent?.({ type: 'done', text: 'I read and wrote.' });
        return { ok: true, text: 'I read and wrote.' };
      },
    });
    expect(result.result.ok).toBe(true);
    // Two distinct groups: the first ends at real assistant text, the second is
    // a new group rather than being merged into the first.
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    expect(toolRuns).toHaveLength(2);
    const g1 = decodeToolRun(toolRuns[0]!.text)!;
    const g2 = decodeToolRun(toolRuns[1]!.text)!;
    expect(g1.items.map((i) => i.name)).toEqual(['read_file']);
    expect(g2.items.map((i) => i.name)).toEqual(['write_file']);
    expect(result.session.messages.filter((m) => m.role === 'tool_run')).toHaveLength(2);
  });

  it('collapseThinkingDisplay keeps monologue (no one-liner wall)', () => {
    expect(collapseThinkingDisplay('')).toBe('Thinking');
    expect(collapseThinkingDisplay('short')).toBe('short');
    const long = 'x'.repeat(200);
    expect(collapseThinkingDisplay(long)).toBe(long);
  });

  it('persists partial assistant + tools on cancel so continue has memory', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const { session: next } = await runHarnessTurn(bridge, session, 'work', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'read_file' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'read_file',
          ok: true,
          summary: 'read_file · ✓ ok · a.ts · 3 lines · 10 B',
        });
        await init?.onEvent?.({ type: 'text_delta', text: 'I read a.ts and' });
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(
      next.messages.some(
        (m) => m.role === 'tool_run' && m.text.includes('read_file'),
      ),
    ).toBe(true);
    expect(next.messages.some((m) => m.role === 'assistant' && m.text.includes('I read a.ts'))).toBe(
      true,
    );
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(true);
    const folded = formatPromptWithHistory(next.messages, 'continue');
    // tool_run is display-only and NOT folded into the model prompt (plan #345);
    // the persisted assistant text still carries continuation context.
    expect(folded).not.toContain('Tool: read_file');
    expect(folded).toContain('I read a.ts');
    // Turn-end markers must not pollute history
    expect(folded).not.toContain('Turn ended');
  });

  it('keeps full thinking when stream cancels without SSE terminal', async () => {
    const long = 'B'.repeat(300);
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'cancel-thinking', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'reasoning_delta', text: long });
        // No done/error event — mirrors AbortError mid-read.
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(result.result.ok).toBe(false);
    const thinking = exp.__messages.filter((m) => m.kind === MessageKind.Thinking);
    expect(thinking).toHaveLength(1);
    expect(thinking[0]!.text).toBe(long);
    expect(
      exp.__messages.some(
        (m) => m.kind === MessageKind.System && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(true);
  });

  it('durable detach preserves turnRunId+running and does not paint you-stopped (adversarial #844)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const { DETACH_ABORT_REASON } = await import('./detachTurn');
    const controller = new AbortController();
    const patches: { turnRunId?: string; turnStatus?: string }[] = [];
    const { session: next } = await runHarnessTurn(bridge, session, 'work', {
      streamAgent: true,
      signal: controller.signal,
      onSessionPatch: (s) => {
        patches.push({ turnRunId: s.turnRunId, turnStatus: s.turnStatus });
      },
      sendAgentStream: async (_prompt, init) => {
        await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
        controller.abort(DETACH_ABORT_REASON);
        // Production sendTurnStream AbortError omits turnRunId.
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(next.turnRunId).toBe('wr_live');
    expect(next.turnStatus).toBe('running');
    expect(patches.some((p) => p.turnRunId === 'wr_live' && p.turnStatus === 'running')).toBe(
      true,
    );
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(false);
    expect(next.messages.some((m) => m.role === 'system' && /detached/.test(m.text))).toBe(
      false,
    );
  });

  it('pre-headers detach must not force running on leftover completed id (adversarial #844)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      ...createEmptySession(),
      turnRunId: 'wr_old',
      turnStatus: 'completed' as const,
    };
    const { runHarnessTurn } = await import('./harnessChat');
    const { DETACH_ABORT_REASON } = await import('./detachTurn');
    const controller = new AbortController();
    const { session: next } = await runHarnessTurn(bridge, session, 'work', {
      streamAgent: true,
      signal: controller.signal,
      sendAgentStream: async () => {
        // Production sendTurnStream AbortError shape: no onTurnStarted, no
        // turnRunId on the result (headers never arrived).
        controller.abort(DETACH_ABORT_REASON);
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(next.turnRunId).toBe('wr_old');
    expect(next.turnStatus).toBe('completed');
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(false);
    expect(next.messages.some((m) => m.role === 'system' && /detached/.test(m.text))).toBe(
      false,
    );
  });

  it('pre-headers detach must not force running on leftover cancelling id (adversarial #844)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      ...createEmptySession(),
      turnRunId: 'wr_old',
      turnStatus: 'cancelling' as const,
    };
    const { runHarnessTurn } = await import('./harnessChat');
    const { DETACH_ABORT_REASON } = await import('./detachTurn');
    const controller = new AbortController();
    const { session: next } = await runHarnessTurn(bridge, session, 'work', {
      streamAgent: true,
      signal: controller.signal,
      sendAgentStream: async () => {
        controller.abort(DETACH_ABORT_REASON);
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(next.turnRunId).toBe('wr_old');
    expect(next.turnStatus).toBe('cancelling');
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(false);
  });

  it('onTurnStarted detach keeps this turn id, not leftover completed (adversarial #844)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      ...createEmptySession(),
      turnRunId: 'wr_old',
      turnStatus: 'completed' as const,
    };
    const { runHarnessTurn } = await import('./harnessChat');
    const { DETACH_ABORT_REASON } = await import('./detachTurn');
    const controller = new AbortController();
    const { session: next } = await runHarnessTurn(bridge, session, 'work', {
      streamAgent: true,
      signal: controller.signal,
      sendAgentStream: async (_prompt, init) => {
        await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
        controller.abort(DETACH_ABORT_REASON);
        // Production AbortError omits turnRunId; rely on the onTurnStarted fold.
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(next.turnRunId).toBe('wr_live');
    expect(next.turnStatus).toBe('running');
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(false);
  });

  it('Stop after onTurnStarted clears this-turn running (adversarial #844)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { runHarnessTurn } = await import('./harnessChat');
    const controller = new AbortController();
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'work', {
      streamAgent: true,
      signal: controller.signal,
      sendAgentStream: async (_prompt, init) => {
        await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
        controller.abort();
        // Production abort-after-headers now carries turnRunId; also prove the
        // omit shape still clears via this-turn running.
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(next.turnRunId).toBeUndefined();
    expect(next.turnStatus).toBe('completed');
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(true);
  });

  it('Stop after onTurnStarted with abort result id still clears (adversarial #844)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { runHarnessTurn } = await import('./harnessChat');
    const controller = new AbortController();
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'work', {
      streamAgent: true,
      signal: controller.signal,
      sendAgentStream: async (_prompt, init) => {
        await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
        controller.abort();
        return { ok: false, error: 'Request cancelled.', turnRunId: 'wr_live' };
      },
    });
    expect(next.turnRunId).toBeUndefined();
    expect(next.turnStatus).toBe('completed');
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(true);
  });

  it('pre-headers Stop must not clear leftover completed id (adversarial #844)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      ...createEmptySession(),
      turnRunId: 'wr_old',
      turnStatus: 'completed' as const,
    };
    const { runHarnessTurn } = await import('./harnessChat');
    const controller = new AbortController();
    const { session: next } = await runHarnessTurn(bridge, session, 'work', {
      streamAgent: true,
      signal: controller.signal,
      sendAgentStream: async () => {
        controller.abort();
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(next.turnRunId).toBe('wr_old');
    expect(next.turnStatus).toBe('completed');
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(true);
  });

  it('text then reasoning then text does not duplicate assistant segment', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'interleave', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'text_delta', text: 'Hello' });
        await init?.onEvent?.({ type: 'reasoning_delta', text: 'wait' });
        await init?.onEvent?.({ type: 'text_delta', text: ' world' });
        await init?.onEvent?.({ type: 'done', text: 'Hello world' });
        return { ok: true, text: 'Hello world' };
      },
    });
    expect(result.result.ok).toBe(true);
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    // Must not re-push full "Hello world" while leaving "Hello" (duplicate).
    expect(assistants.map((m) => m.text)).not.toContain('Hello world');
    expect(assistants.some((m) => m.text === 'Hello')).toBe(true);
    expect(assistants.some((m) => m.text === ' world')).toBe(true);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.Thinking)).toHaveLength(1);
    expect(result.session.messages.some((m) => m.role === 'assistant' && m.text === 'Hello world')).toBe(
      true,
    );
  });

  it('opens a new assistant bubble after tools when text was already streaming', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'multi', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'text_delta', text: 'Looking…' });
        await init?.onEvent?.({ type: 'tool_start', name: 'list_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'list_dir',
          ok: true,
          summary: 'list_dir · ok · a.txt',
        });
        await init?.onEvent?.({ type: 'text_delta', text: 'Found a.txt' });
        await init?.onEvent?.({ type: 'done', text: 'Looking…Found a.txt' });
        return { ok: true, text: 'Looking…Found a.txt' };
      },
    });
    expect(result.result.ok).toBe(true);
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    expect(assistants[0]!.text).toBe('Looking…');
    expect(assistants[assistants.length - 1]!.text).toContain('Found a.txt');
    // Tools between assistant bubbles are aggregated into a ToolRun message.
    const toolRun = exp.__messages.find((m) => m.kind === MessageKind.ToolRun);
    expect(toolRun).toBeDefined();
    const decoded = decodeToolRun(toolRun!.text);
    expect(decoded).not.toBeNull();
    expect(decoded!.items[0]!.name).toBe('list_dir');
  });

  it('JSON streamAgent:false still uses end toolTrace', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async () => ({
        ok: true,
        text: 'pong',
        toolTrace: [{ name: 'x', ok: true, summary: 'x · ok · done' }],
      }),
    });
    expect(result.result.ok).toBe(true);
    expect(exp.__messages.some((m) => m.text.includes('x · ok'))).toBe(true);
    expect(exp.__messages.some((m) => m.text === 'pong')).toBe(true);
  });
});

describe('durable stream EOF is detach (plan #852 / source #849)', () => {
  async function runRetry<T>(fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    try {
      const pending = fn();
      await vi.advanceTimersByTimeAsync(60_000);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  }

  it('onTurnStarted + text_delta + ok:true without done is detach, not model-finished', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { session: next, result } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'work',
      {
        streamAgent: true,
        sendAgentStream: async (_prompt, init) => {
          await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
          await init?.onEvent?.({ type: 'text_delta', text: 'partial' });
          return { ok: true, text: 'partial', turnRunId: 'wr_live' };
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(next.turnRunId).toBe('wr_live');
    expect(next.turnStatus).toBe('running');
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('model'),
      ),
    ).toBe(false);
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(false);
    expect(next.messages.some((m) => m.role === 'system' && /detached/.test(m.text))).toBe(
      false,
    );
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
  });

  it('onTurnStarted + empty model response without done is detach, not empty-complete', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { session: next, result } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'work',
      {
        streamAgent: true,
        sendAgentStream: async (_prompt, init) => {
          await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
          return { ok: false, error: 'Empty model response.', turnRunId: 'wr_live' };
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(next.turnRunId).toBe('wr_live');
    expect(next.turnStatus).toBe('running');
    expect(
      next.messages.some(
        (m) => m.role === 'error' && m.text === describeTurnEnd('empty'),
      ),
    ).toBe(false);
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('model'),
      ),
    ).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
  });

  it('onTurnStarted + SSE done still completes as model-finished', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { session: next, result } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'work',
      {
        streamAgent: true,
        sendAgentStream: async (_prompt, init) => {
          await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
          await init?.onEvent?.({ type: 'text_delta', text: 'hello' });
          await init?.onEvent?.({ type: 'done', text: 'hello' });
          return { ok: true, text: 'hello', turnRunId: 'wr_live' };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(next.turnRunId).toBe('wr_live');
    expect(next.turnStatus).toBe('completed');
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('model'),
      ),
    ).toBe(true);
  });

  it('after onTurnStarted, empty/EOF does not POST a second turn', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgentStream = vi.fn(async (_prompt: string, init?: { onTurnStarted?: (info: { turnRunId: string }) => void | Promise<void> }) => {
      await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
      return { ok: false as const, error: 'Empty model response.', turnRunId: 'wr_live' };
    });
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'work', {
      streamAgent: true,
      sendAgentStream,
    });
    expect(sendAgentStream).toHaveBeenCalledTimes(1);
    expect(next.turnStatus).toBe('running');
    expect(next.turnRunId).toBe('wr_live');
  });

  it('leftover completed turnRunId without onTurnStarted still retries empty', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      ...createEmptySession(),
      turnRunId: 'wr_old',
      turnStatus: 'completed' as const,
    };
    const sendAgentStream = vi.fn(async () => ({
      ok: false as const,
      error: 'Empty model response.',
    }));
    const { session: next } = await runRetry(() =>
      runHarnessTurn(bridge, session, 'work', {
        streamAgent: true,
        sendAgentStream,
      }),
    );
    expect(sendAgentStream).toHaveBeenCalledTimes(5);
    expect(next.turnRunId).toBe('wr_old');
    expect(next.turnStatus).toBe('completed');
    expect(
      next.messages.some(
        (m) => m.role === 'error' && m.text === describeTurnEnd('empty'),
      ),
    ).toBe(true);
  });

  it('ok:false with turnRunId header without onTurnStarted is not detach', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'work', {
      streamAgent: true,
      sendAgentStream: async () => ({
        ok: false,
        status: 400,
        error: 'bad prompt',
        turnRunId: 'wr_hdr',
      }),
    });
    expect(next.turnRunId).toBeUndefined();
    expect(next.turnStatus).toBe('completed');
    expect(
      next.messages.some(
        (m) => m.role === 'error' && m.text.startsWith('Turn ended · error'),
      ),
    ).toBe(true);
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
  });

  it('onTurnStarted + SSE error is error fold, not detach, and does not POST again', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgentStream = vi.fn(
      async (
        _prompt: string,
        init?: {
          onTurnStarted?: (info: { turnRunId: string }) => void | Promise<void>;
          onEvent?: (ev: AgentStreamEvent) => void | Promise<void>;
        },
      ) => {
        await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
        await init?.onEvent?.({ type: 'error', error: 'producer failed' });
        return {
          ok: false as const,
          error: 'producer failed',
          turnRunId: 'wr_live',
        };
      },
    );
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'work', {
      streamAgent: true,
      sendAgentStream,
    });
    expect(sendAgentStream).toHaveBeenCalledTimes(1);
    expect(next.turnRunId).toBeUndefined();
    expect(next.turnStatus).toBe('completed');
    expect(
      next.messages.some(
        (m) => m.role === 'error' && m.text.startsWith('Turn ended · error'),
      ),
    ).toBe(true);
    expect(next.messages.some((m) => m.role === 'system' && /detached/.test(m.text))).toBe(
      false,
    );
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
  });

  it('SSE done + finishReason length is Error, not model-finished; assistant stays', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { session: next, result } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'work',
      {
        streamAgent: true,
        sendAgentStream: async (_prompt, init) => {
          await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
          await init?.onEvent?.({ type: 'text_delta', text: 'cut off mid' });
          await init?.onEvent?.({
            type: 'done',
            text: 'cut off mid',
            finishReason: 'length',
          });
          return { ok: true, text: 'cut off mid', turnRunId: 'wr_live' };
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(next.turnStatus).toBe('completed');
    expect(
      next.messages.some((m) => m.role === 'assistant' && m.text === 'cut off mid'),
    ).toBe(true);
    expect(
      next.messages.some(
        (m) =>
          m.role === 'error' &&
          m.text === describeTurnEnd('error', 'output truncated'),
      ),
    ).toBe(true);
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('model'),
      ),
    ).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
  });

  it('SSE error output truncated after text_delta is Error, not model-finished', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { session: next, result } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'work',
      {
        streamAgent: true,
        sendAgentStream: async (_prompt, init) => {
          await init?.onTurnStarted?.({ turnRunId: 'wr_live' });
          await init?.onEvent?.({ type: 'text_delta', text: 'cut off mid' });
          await init?.onEvent?.({ type: 'error', error: 'output truncated' });
          return {
            ok: false as const,
            error: 'output truncated',
            turnRunId: 'wr_live',
          };
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(
      next.messages.some((m) => m.role === 'assistant' && m.text === 'cut off mid'),
    ).toBe(true);
    expect(
      next.messages.some(
        (m) =>
          m.role === 'error' &&
          m.text === describeTurnEnd('error', 'output truncated'),
      ),
    ).toBe(true);
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('model'),
      ),
    ).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
  });
});

describe('toolRun aggregation (protocol v10 / plan #345)', () => {
  it('stream streak beyond TOOL_RUN_ITEMS_MAX rolls a new tool_run group', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const total = TOOL_RUN_ITEMS_MAX + 5;
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'many', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        for (let i = 0; i < total; i++) {
          await init?.onEvent?.({ type: 'tool_start', name: `t${i}` });
          await init?.onEvent?.({
            type: 'tool_result',
            name: `t${i}`,
            ok: true,
            summary: `t${i} · ✓ ok`,
          });
        }
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });
    expect(result.result.ok).toBe(true);
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    // MAX-sized group + one remainder group.
    expect(toolRuns.length).toBeGreaterThan(1);
    let totalCount = 0;
    for (const tr of toolRuns) {
      const d = decodeToolRun(tr.text);
      expect(d).not.toBeNull();
      expect(d!.items.length).toBeLessThanOrEqual(TOOL_RUN_ITEMS_MAX);
      totalCount += d!.items.length;
    }
    expect(totalCount).toBe(total);
  });

  it('pushSessionToBridge maps restored tool_run role to kind 6', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: [
        { id: 'u', role: 'user' as const, text: 'hi', at: 1 },
        {
          id: 't',
          role: 'tool_run' as const,
          text: 'toolrun\t1\t1/0/0\n1\tok\tread_file\tbrief\tdetail',
          at: 2,
        },
        { id: 'a', role: 'assistant' as const, text: 'done', at: 3 },
      ],
    };
    pushSessionToBridge(bridge, session, { clear: false });
    const kinds = exp.__messages.map((m) => m.kind);
    expect(kinds[1]).toBe(MessageKind.ToolRun);
    expect(exp.__messages[1]!.text).toContain('toolrun');
  });
});

describe('runHarnessTurn session cwd', () => {
  it('passes session cwd and updates on success', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (_p: string, init?: { cwd?: string }) => {
      expect(init?.cwd).toBe('invincible');
      return {
        ok: true as const,
        text: 'done',
        cwd: 'invincible/sub',
      };
    });
    const session = { ...createEmptySession('s'), cwd: 'invincible' };
    const { session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(sendAgent).toHaveBeenCalled();
    expect(next.cwd).toBe('invincible/sub');
  });

  it('keeps prior cwd on failure', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async () => ({
      ok: false as const,
      error: 'boom',
      status: 422, // plan #759 — permanent (terminal); 5xx would retry
    }));
    const session = { ...createEmptySession('s'), cwd: 'keep-me' };
    const { session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(next.cwd).toBe('keep-me');
  });

  it('leaves prior cwd when success omits cwd', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async () => ({
      ok: true as const,
      text: 'http only',
    }));
    const session = { ...createEmptySession('s'), cwd: 'prior' };
    const { session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(next.cwd).toBe('prior');
  });

  it('ignores whitespace-only success cwd', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async () => ({
      ok: true as const,
      text: 'ok',
      cwd: '   ',
    }));
    const session = { ...createEmptySession('s'), cwd: 'prior' };
    const { session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(next.cwd).toBe('prior');
  });

  it('sends the authoritative `cwd` on every turn (default `.` when none known)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (_p: string, init?: { cwd?: string }) => {
      expect(init?.cwd).toBe('.');
      return { ok: true as const, text: 'ok' };
    });
    const { session: next } = await runHarnessTurn(
      bridge,
      createEmptySession('s'),
      'hi',
      { sendAgent, pushUser: false, streamAgent: false },
    );
    expect(sendAgent).toHaveBeenCalled();
    // `.` is the request-time default; a fresh session with no `agentResult.cwd`
    // (and no prior known cwd) stays unset — nothing new to persist.
    expect(next.cwd).toBeUndefined();
  });

  it('a single authoritative getter drives the request cwd', () => {
    expect(getSessionCwd({ ...createEmptySession('s'), cwd: '  invincible/sub  ' })).toBe(
      'invincible/sub',
    );
    expect(getSessionCwd(createEmptySession('s'))).toBe('.');
    expect(getSessionCwd({ ...createEmptySession('s'), cwd: '   ' })).toBe('.');
  });

  it('maps escaping / unsanitary cwd to `.` so a legal P1 record cannot brick a turn (review #453)', () => {
    // `..` / `a/../../b` are LEGAL on the record at P1 (validateMetaFields accepts
    // them), but parseInitialCwd → normalizeWorkspaceRel throws ("escapes root") →
    // /api/agent would 400 every turn. The getter must normalize to `.`.
    expect(getSessionCwd({ ...createEmptySession('s'), cwd: '..' })).toBe('.');
    expect(getSessionCwd({ ...createEmptySession('s'), cwd: 'a/../../b' })).toBe('.');
    // host-absolute / drive / control chars are also never fed to /api/agent.
    expect(getSessionCwd({ ...createEmptySession('s'), cwd: '/etc/passwd' })).toBe('.');
    expect(getSessionCwd({ ...createEmptySession('s'), cwd: 'C:\\Windows' })).toBe('.');
    expect(getSessionCwd({ ...createEmptySession('s'), cwd: 'a\nb' })).toBe('.');
  });

  it('nested in-bounds `..` still normalizes instead of being rejected', () => {
    expect(getSessionCwd({ ...createEmptySession('s'), cwd: 'a/b/../c' })).toBe('a/c');
  });

  it('agent request cwd is `.` (not `..`) when the record persisted an escaping cwd', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (_p: string, init?: { cwd?: string }) => {
      expect(init?.cwd).toBe('.');
      return { ok: true as const, text: 'ok' };
    });
    const session = { ...createEmptySession('s'), cwd: '..' };
    await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(sendAgent).toHaveBeenCalled();
  });

  it('does not persist an unsanitary agentResult.cwd (keeps prior)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async () => ({
      ok: true as const,
      text: 'ok',
      cwd: '/etc/passwd',
    }));
    const session = { ...createEmptySession('s'), cwd: 'prior' };
    const { session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(next.cwd).toBe('prior');
  });

  it('hard-failed agent turn still keeps the prior known cwd', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 422, // plan #759 — permanent (terminal); 5xx would retry
      error: 'Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.',
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'chat ok' }));
    const session = { ...createEmptySession('s'), cwd: 'invincible/src' };
    const { result, session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      send,
      pushUser: false,
      streamAgent: false,
    });
    expect(result.ok).toBe(false);
    expect(next.cwd).toBe('invincible/src');
  });

  it('JSON success omitting agentResult.cwd persists a confirmed change_dir from toolTrace (plan #465)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'moved',
      toolTrace: [
        {
          name: 'change_dir',
          ok: true,
          // Prod shape: the confirmed cwd arrives as a TYPED `cwd` field, not
          // parsed from the truncated display summary (adversarial review #470).
          summary: 'change_dir · ✓ ok · invincible/sub · cwd=invincible/sub',
          cwd: 'invincible/sub',
        },
      ],
    }));
    const session = { ...createEmptySession('s'), cwd: 'invincible' };
    const { result, session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(result.ok).toBe(true);
    // JSON success has no live events; the confirmed change_dir in toolTrace
    // closes the #403 drift when the authoritative `cwd` is absent.
    expect(next.cwd).toBe('invincible/sub');
  });

  it('JSON success with only an errored change_dir (no authoritative cwd) keeps prior (plan #465)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'nope',
      toolTrace: [
        { name: 'change_dir', ok: false, summary: 'change_dir · ✗ failed · ERROR change_dir: no such dir' },
      ],
    }));
    const session = { ...createEmptySession('s'), cwd: 'keep-me' };
    const { result, session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(result.ok).toBe(true);
    // A failed change_dir never records a live cwd, so the prior value is kept.
    expect(next.cwd).toBe('keep-me');
  });

  it('stream cancel after a successful change_dir persists the live cwd (plan #465)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), cwd: 'invincible' };
    const { result, session: next } = await runHarnessTurn(bridge, session, 'cd', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'change_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'change_dir',
          ok: true,
          summary: 'change_dir · ✓ ok · invincible/sub · cwd=invincible/sub',
          // The confirmed cwd rides as a typed field (adversarial review #470).
          changeDirCwd: 'invincible/sub',
        });
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(result.ok).toBe(false);
    // The model moved before the cancel — the next turn boots there, not stale.
    expect(next.cwd).toBe('invincible/sub');
  });

  it('stream hard-error/timeout after a successful change_dir persists the live cwd (plan #465)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), cwd: 'invincible' };
    const { result, session: next } = await runHarnessTurn(bridge, session, 'cd', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'change_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'change_dir',
          ok: true,
          summary: 'change_dir · ✓ ok · invincible/sub · cwd=invincible/sub',
          // The confirmed cwd rides as a typed field (adversarial review #470).
          changeDirCwd: 'invincible/sub',
        });
        await init?.onEvent?.({ type: 'error', error: 'Gateway timeout' });
        // status 422 keeps the timeout kind (message match) but is PERMANENT
        // (plan #759 — a 4xx never backoff-loops a terminal turn).
        return { ok: false, error: 'Gateway timeout', status: 422 };
      },
    });
    expect(result.ok).toBe(false);
    expect(next.cwd).toBe('invincible/sub');
  });

  it('stream failure with only an errored change_dir keeps the prior cwd (plan #465)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), cwd: 'keep-me' };
    const { result, session: next } = await runHarnessTurn(bridge, session, 'cd', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'change_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'change_dir',
          ok: false,
          summary: 'change_dir · ✗ failed · ERROR change_dir: no such dir',
        });
        return { ok: false, error: 'boom', status: 422 }; // plan #759 — terminal
      },
    });
    expect(result.ok).toBe(false);
    // A failed change_dir never records a live cwd — prior value retained.
    expect(next.cwd).toBe('keep-me');
  });

  it('stream success that omits agentResult.cwd still persists a confirmed live cwd (plan #465)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), cwd: 'invincible' };
    const { result, session: next } = await runHarnessTurn(bridge, session, 'cd', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'change_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'change_dir',
          ok: true,
          summary: 'change_dir · ✓ ok · invincible/deep · cwd=invincible/deep',
          // The confirmed cwd rides as a typed field (adversarial review #470).
          changeDirCwd: 'invincible/deep',
        });
        await init?.onEvent?.({ type: 'done', text: 'ok' });
        return { ok: true, text: 'ok' };
      },
    });
    expect(result.ok).toBe(true);
    // Success prefers the authoritative `agentResult.cwd`, but when it is absent
    // the confirmed live cwd closes the #403 drift instead of re-retaining stale.
    expect(next.cwd).toBe('invincible/deep');
  });

  it('stream cancel with a ≥67-char change_dir target persists the FULL path — no `…` corruption (adversarial review #470 Major)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // A workspace-relative target long enough (≥67 chars) that its summarized
    // one-liner would be clipped at TOOL_LINE_SALIENT_MAX and end in `…`.
    const LONG_PATH =
      'packages/frontend/src/components/settings/panels/advanced/billing/extra';
    expect(LONG_PATH.length).toBeGreaterThanOrEqual(67);
    const session = { ...createEmptySession('s'), cwd: 'invincible' };
    const { result, session: next } = await runHarnessTurn(bridge, session, 'cd', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'change_dir' });
        // The typed `changeDirCwd` carries the full raw path; the display summary
        // is already hard-truncated to `…` and must NOT be the persistence source.
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'change_dir',
          ok: true,
          summary: `change_dir · ✓ ok · ${LONG_PATH.slice(0, 60)} · cwd=${LONG_PATH.slice(0, 60)}…`,
          changeDirCwd: LONG_PATH,
        });
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(result.ok).toBe(false);
    // The full long path persists (not a `…#` slice), so the next turn's tools
    // resolve under the real directory.
    expect(next.cwd).toBe(LONG_PATH);
    expect(next.cwd).not.toContain('…');
  });

  it('stream cancel whose summary is truncated but whose typed changeDirCwd carries the full path persists exactly (adversarial review #470 Major)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const LONG_PATH =
      'apps/web/src/features/billing/tenants/settings/panels/advanced/archive-main-2026';
    expect(LONG_PATH.length).toBeGreaterThanOrEqual(80);
    const session = { ...createEmptySession('s'), cwd: 'invincible' };
    const { result, session: next } = await runHarnessTurn(bridge, session, 'cd', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'change_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'change_dir',
          ok: true,
          summary: 'change_dir · ✓ ok · apps/web/… · cwd=…',
          changeDirCwd: LONG_PATH,
        });
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(result.ok).toBe(false);
    // The typed field wins over the truncated summary — no `…` persisted.
    expect(next.cwd).toBe(LONG_PATH);
  });
});

describe('parseChangeDirCwd / recordLiveCwd (plan #465)', () => {
  it('parses the raw success line and the summarized host form', () => {
    expect(parseChangeDirCwd('change_dir invincible/sub: ok cwd=invincible/sub')).toBe(
      'invincible/sub',
    );
    expect(
      parseChangeDirCwd('change_dir · ✓ ok · invincible/sub · cwd=invincible/sub'),
    ).toBe('invincible/sub');
  });

  it('never parses an errored change_dir', () => {
    expect(parseChangeDirCwd('ERROR change_dir: no such directory')).toBeUndefined();
    expect(parseChangeDirCwd('ERROR change_dir: boom')).toBeUndefined();
    expect(parseChangeDirCwd('change_dir · ✗ failed · ERROR change_dir: boom')).toBeUndefined();
  });

  it('never parses empty / non-change_dir text', () => {
    expect(parseChangeDirCwd(undefined)).toBeUndefined();
    expect(parseChangeDirCwd('')).toBeUndefined();
    expect(parseChangeDirCwd('list_dir .: 2 entries')).toBeUndefined();
    expect(parseChangeDirCwd('pwd: invincible')).toBeUndefined();
  });

  it('rejects a truncated capture (… artifact of the 160-char summary cap)', () => {
    // A ≥67-char target pushes the summarized `change_dir · ✓ ok · <path> ·
    // cwd=<path>` past TOOL_LINE_SALIENT_MAX and the clipped tail ends in `…`.
    // That is not a real directory — never return it (adversarial review #470 Major).
    const LONG_PATH =
      'packages/frontend/src/components/settings/panels/advanced/billing/extra';
    expect(LONG_PATH.length).toBeGreaterThanOrEqual(67);
    expect(parseChangeDirCwd(`change_dir ${LONG_PATH}: ok cwd=${LONG_PATH}`)).toBe(
      LONG_PATH,
    );
    // Summarized form truncated to `…` must be rejected, never returned.
    expect(
      parseChangeDirCwd(
        `change_dir · ✓ ok · ${LONG_PATH.slice(0, 60)} · cwd=${LONG_PATH.slice(0, 60)}…`,
      ),
    ).toBeUndefined();
  });

  it('recordLiveCwd keeps the last confirmed value and never regresses on a later undefined', () => {
    let state: LiveCwdSource = { value: undefined, source: undefined };
    state = recordLiveCwd(state, 'invincible/a');
    expect(state.value).toBe('invincible/a');
    // A later, deeper successful change_dir wins.
    state = recordLiveCwd(state, 'invincible/a/b');
    expect(state.value).toBe('invincible/a/b');
    // A failed change_dir (caller gates on ok → passes undefined) must NOT erase
    // the confirmed live cwd.
    state = recordLiveCwd(state, undefined);
    expect(state.value).toBe('invincible/a/b');
  });

  it('recordLiveCwd never persists a truncated (… ) capture', () => {
    let state: LiveCwdSource = { value: undefined, source: undefined };
    state = recordLiveCwd(state, `val…`);
    expect(state.value).toBeUndefined();
    const LONG_PATH =
      'apps/web/src/features/billing/components/settings/panels/advanced/archive';
    state = recordLiveCwd(state, LONG_PATH);
    expect(state.value).toBe(LONG_PATH);
  });
});


describe('lastUiKind boundary predicate helpers (plan #364)', () => {
  it('continues only for a tool_run last row — thinking/assistant/user/error split (#433)', () => {
    // #433 locked rule: only a tool-run last row continues the open card. Every
    // other row (incl. thinking, which was commit-once's streak-continue) is a
    // physical separator that forces a NEW card at 1.
    expect(shouldContinueStreak('tool_run')).toBe(true);
    expect(shouldContinueStreak('thinking')).toBe(false);
    expect(shouldContinueStreak('none')).toBe(false);
    expect(shouldContinueStreak('assistant')).toBe(false);
    expect(shouldContinueStreak('user')).toBe(false);
    expect(shouldContinueStreak('error')).toBe(false);
    // system is a turn-end terminal — never a live continue.
    expect(shouldContinueStreak('system')).toBe(false);
  });

  it('restoreLastUiKind returns none for a fresh session and a boundary for committed roles', () => {
    expect(restoreLastUiKind([])).toBe('none');
    expect(restoreLastUiKind([makeMessage('assistant', 'hi')])).toBe('assistant');
    expect(restoreLastUiKind([makeMessage('user', 'hi')])).toBe('user');
    expect(restoreLastUiKind([makeMessage('system', 'turn')])).toBe('system');
    expect(restoreLastUiKind([makeMessage('error', 'oops')])).toBe('error');
    expect(
      restoreLastUiKind([
        makeMessage('tool_run', 'toolrun\t1\t1/0/0'),
      ]),
    ).toBe('tool_run');
  });
});


describe('runHarnessTurn — lastUiKind boundary predicate (plan #364)', () => {
  it('empty/whitespace-only assistant text_delta is NOT a tool-run boundary', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'tools', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'a' });
        await init?.onEvent?.({ type: 'tool_result', name: 'a', ok: true, summary: 'a ok' });
        // Whitespace-only deltas must NOT split the open streak nor open a bubble.
        await init?.onEvent?.({ type: 'text_delta', text: '   ' });
        await init?.onEvent?.({ type: 'text_delta', text: ' \n\t ' });
        await init?.onEvent?.({ type: 'tool_start', name: 'b' });
        await init?.onEvent?.({ type: 'tool_result', name: 'b', ok: true, summary: 'b ok' });
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });
    expect(result.result.ok).toBe(true);
    // a + b remain ONE group — whitespace-only deltas never split the streak.
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    expect(toolRuns).toHaveLength(1);
    const decoded = decodeToolRun(toolRuns[0].text)!;
    expect(decoded.items.map((i) => i.name)).toEqual(['a', 'b']);
    // No blank assistant bubble was painted by the whitespace deltas.
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    expect(assistants.some((m) => m.text.trim() === '')).toBe(false);
    expect(assistants.some((m) => m.text === 'done')).toBe(true);
  });

  it('restore from a committed last role opens a new group for the first post-reload tool', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // Prior committed turn: tool_run + assistant + system (last role = system).
    const session = createEmptySession('s1');
    session.messages.push(
      makeMessage('tool_run', 'toolrun\t1\t1/0/0\n1\tok\twrite_file\twrite_file ok\t'),
      makeMessage('assistant', 'prev done'),
      makeMessage('system', describeTurnEnd('model')),
    );
    const result = await runHarnessTurn(bridge, session, 'now', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'read_file' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'read_file',
          ok: true,
          summary: 'read_file ok',
        });
        await init?.onEvent?.({ type: 'done', text: 'read it' });
        return { ok: true, text: 'read it' };
      },
    });
    expect(result.result.ok).toBe(true);
    // The new turn commits its OWN fresh row — it must NOT grow the restored one.
    const runs = result.session.messages.filter((m) => m.role === 'tool_run');
    expect(runs).toHaveLength(2);
    const restored = decodeToolRun(runs[0].text)!;
    const fresh = decodeToolRun(runs[1].text)!;
    expect(restored.items.map((i) => i.name)).toEqual(['write_file']);
    expect(fresh.items.map((i) => i.name)).toEqual(['read_file']);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.ToolRun)).toHaveLength(1);
  });

  it('JSON (non-stream) path shares the same tool_run -> assistant -> system end state', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'ran',
      toolTrace: [
        { name: 'exec', ok: true, summary: 'exec ok' },
        { name: 'read_file', ok: false, summary: 'read_file failed' },
      ],
    }));
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'go', {
      sendAgent,
      pushUser: false,
    });
    expect(next.messages.map((m) => m.role)).toEqual([
      'user',
      'tool_run',
      'assistant',
      'system',
    ]);
    expect(next.messages.at(-1)!.text).toBe(describeTurnEnd('model'));
    expect(exp.__messages.map((m) => m.kind)).toEqual([
      MessageKind.ToolRun,
      MessageKind.Assistant,
      MessageKind.System,
    ]);
    const decoded = decodeToolRun(exp.__messages[0].text)!;
    expect(decoded.items.map((i) => i.name)).toEqual(['exec', 'read_file']);
    expect(decoded.fail).toBe(1);
  });
});

describe('hydrate coalesce — reload/hydrate scannability (plan #365)', () => {
  function toolRunText(names: string[], fail?: Set<string>): string {
    const g = createToolRunGroup();
    for (const n of names) {
      addToolResult(g, n, !fail?.has(n), `${n} ok`);
    }
    return encodeToolRun(g)!;
  }

  it('coalesces consecutive tool_run rows on hydrate into a scannable group', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // A long session restores many adjacent tool_run rows (roll-bound streaks /
    // older legacy sessions) that are not separated by a real boundary.
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: [
        makeMessage('user', 'go'),
        makeMessage('tool_run', toolRunText(['a', 'b'])),
        makeMessage('tool_run', toolRunText(['c', 'd'])),
        makeMessage('tool_run', toolRunText(['e'])),
        makeMessage('assistant', 'done'),
      ],
    };
    pushSessionToBridge(bridge, session, { clear: true });
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    // Three adjacent rows coalesce into ONE kind-6 group.
    expect(toolRuns).toHaveLength(1);
    const decoded = decodeToolRun(toolRuns[0].text)!;
    expect(decoded.items.map((i) => i.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(decoded.ok).toBe(5);
    // No duplicate user rows; assistant follows the merged card.
    const kinds = exp.__messages.map((m) => m.kind);
    expect(kinds).toEqual([
      MessageKind.User,
      MessageKind.ToolRun,
      MessageKind.Assistant,
    ]);
  });

  it('never merges across an assistant/user/error boundary', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: [
        makeMessage('user', 'q'),
        makeMessage('tool_run', toolRunText(['a'])),
        makeMessage('assistant', 'did it'),
        makeMessage('tool_run', toolRunText(['b'])),
        makeMessage('assistant', 'then'),
      ],
    };
    pushSessionToBridge(bridge, session, { clear: true });
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    expect(toolRuns).toHaveLength(2);
    expect(decodeToolRun(toolRuns[0].text)!.items.map((i) => i.name)).toEqual(['a']);
    expect(decodeToolRun(toolRuns[1].text)!.items.map((i) => i.name)).toEqual(['b']);
  });

  it('never merges across a system or error turn-end boundary', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: [
        makeMessage('user', 'q'),
        makeMessage('tool_run', toolRunText(['a'])),
        makeMessage('system', describeTurnEnd('model')),
        makeMessage('tool_run', toolRunText(['b'])),
        makeMessage('error', describeTurnEnd('error', 'boom')),
        makeMessage('tool_run', toolRunText(['c'])),
      ],
    };
    pushSessionToBridge(bridge, session, { clear: true });
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    // Any non-`tool_run` row flushes the open run — so adjacent rows split by a
    // System (turn-end) or Error (failure) line each stay their own card.
    expect(toolRuns).toHaveLength(3);
    expect(decodeToolRun(toolRuns[0].text)!.items.map((i) => i.name)).toEqual(['a']);
    expect(decodeToolRun(toolRuns[1].text)!.items.map((i) => i.name)).toEqual(['b']);
    expect(decodeToolRun(toolRuns[2].text)!.items.map((i) => i.name)).toEqual(['c']);
    // Order preserved around the boundary rows.
    const kinds = exp.__messages.map((m) => m.kind);
    const errIdx = kinds.indexOf(MessageKind.Error);
    expect(errIdx).toBeGreaterThan(kinds.indexOf(MessageKind.ToolRun));
  });

  it('decode fail-open keeps a run ending malformed row raw and never drops counts', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: [
        makeMessage('user', 'q'),
        makeMessage('tool_run', toolRunText(['a'])),
        // Malformed/oversize blob must not crash hydrate: stays as raw text and
        // ends the preceding run.
        makeMessage('tool_run', 'not-a-toolrun payload'),
        makeMessage('tool_run', toolRunText(['b'])),
        makeMessage('assistant', 'done'),
      ],
    };
    pushSessionToBridge(bridge, session, { clear: true });
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    // 'a' → one group; malformed → one raw row; 'b' → one group.
    expect(toolRuns).toHaveLength(3);
    expect(exp.__messages.some((m) => m.text === 'not-a-toolrun payload')).toBe(true);
    const mergedOk = toolRuns.filter((tr) => tr.text.startsWith('toolrun'));
    expect(mergedOk.map((tr) => decodeToolRun(tr.text)!.items.map((i) => i.name))).toEqual([
      ['a'],
      ['b'],
    ]);
  });

  it('a run longer than TOOL_RUN_ITEMS_MAX rolls into multiple merged groups', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // Two adjacent rows (each under the per-payload decode cap, combined > the
    // group cap) merge into TWO bounded groups — never one oversized row.
    const half = Math.floor((TOOL_RUN_ITEMS_MAX + 40) / 2);
    const a = Array.from({ length: half }, (_, i) => `a${i}`);
    const b = Array.from({ length: TOOL_RUN_ITEMS_MAX + 40 - half }, (_, i) => `b${i}`);
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: [
        makeMessage('user', 'go'),
        makeMessage('tool_run', toolRunText(a)),
        makeMessage('tool_run', toolRunText(b)),
        makeMessage('assistant', 'done'),
      ],
    };
    pushSessionToBridge(bridge, session, { clear: true });
    const toolRuns = exp.__messages.filter((m) => m.kind === MessageKind.ToolRun);
    expect(toolRuns.length).toBeGreaterThan(1);
    let total = 0;
    for (const tr of toolRuns) {
      const d = decodeToolRun(tr.text);
      expect(d).not.toBeNull();
      expect(d!.items.length).toBeLessThanOrEqual(TOOL_RUN_ITEMS_MAX);
      total += d!.items.length;
    }
    expect(total).toBe(TOOL_RUN_ITEMS_MAX + 40);
  });

  it('coalesceToolRunMessages is a pure no-op for a session with no adjacent tool_run rows', () => {
    const msgs = [
      makeMessage('user', 'hi'),
      makeMessage('tool_run', toolRunText(['a'])),
      makeMessage('assistant', 'ok'),
      makeMessage('tool_run', toolRunText(['b'])),
    ];
    const out = coalesceToolRunMessages(msgs);
    expect(out).toHaveLength(msgs.length);
    expect(out.map((m) => m.text)).toEqual(msgs.map((m) => m.text));
  });
});

describe('#387 host seam — whitespace boundary fidelity (phase-2 roll-in)', () => {
  it('multi-segment whitespace-only boundary reconstitutes authoritative text (previously RED)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const AUTHORITATIVE = 'part one part two\n\nIt will 401';
    const result = await runHarnessTurn(bridge, session, 'repro', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        const onEvent = init?.onEvent;
        await onEvent?.({ type: 'text_delta', text: 'part one ' });
        await onEvent?.({ type: 'text_delta', text: 'part two' });
        // Whitespace-only boundary (`\n\n` after a heading/paragraph). GrowAssistant
        // must accumulate it faithfully: dropping it made the multi-segment
        // tail-slice mis-glue to `...part two` + `It will 401` (#387 host seam).
        await onEvent?.({ type: 'text_delta', text: '\n\n' });
        // A tool closes the first assistant segment.
        await onEvent?.({ type: 'tool_start', name: 'list_dir' });
        await onEvent?.({
          type: 'tool_result',
          name: 'list_dir',
          ok: true,
          summary: 'list_dir · ok · a',
        });
        await onEvent?.({ type: 'text_delta', text: 'It will 401' });
        await onEvent?.({ type: 'done', text: AUTHORITATIVE });
        return { ok: true, text: AUTHORITATIVE };
      },
    });
    expect(result.result.ok).toBe(true);
    // Session settles to the authoritative (well-formed) text.
    const settled = result.session.messages.find((m) => m.role === 'assistant');
    expect(settled?.text).toBe(AUTHORITATIVE);
    // The host never INDUCES glue: the visible assistant bubbles reconstitute the
    // authoritative text across the tool boundary. Dropping the `\n\n` would join
    // them as `...part two` + `It will 401` (missing the blank line).
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    expect(assistants.map((m) => m.text).join('')).toBe(AUTHORITATIVE);
    // Stronger assert (review follow-up): the `\n\n` arrived while the first
    // segment was still open (before the tool), so the FIRST bubble must OWN the
    // boundary — not a wrong split that happens to concatenate.
    expect(assistants[0]!.text).toBe('part one part two\n\n');
  });

  it('single-segment `## What I did` + boundary delta reassembles with the newline intact', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const AUTHORITATIVE =
      '## What I did\n\nThe adversarial review verdict was **CONCERNS**.';
    const result = await runHarnessTurn(bridge, session, 'md', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        const onEvent = init?.onEvent;
        await onEvent?.({ type: 'text_delta', text: '## What I did' });
        await onEvent?.({ type: 'text_delta', text: '\n\n' });
        await onEvent?.({
          type: 'text_delta',
          text: 'The adversarial review verdict was **CONCERNS**.',
        });
        await onEvent?.({ type: 'done', text: AUTHORITATIVE });
        return { ok: true, text: AUTHORITATIVE };
      },
    });
    expect(result.result.ok).toBe(true);
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe(AUTHORITATIVE);
    const settled = result.session.messages.find((m) => m.role === 'assistant');
    expect(settled?.text).toBe(AUTHORITATIVE);
  });

  it('a whitespace-only text_delta does NOT open an empty assistant bubble on its own', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const result = await runHarnessTurn(bridge, session, 'ws', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        const onEvent = init?.onEvent;
        await onEvent?.({ type: 'text_delta', text: '   ' });
        await onEvent?.({ type: 'text_delta', text: 'ok' });
        await onEvent?.({ type: 'done', text: 'ok' });
        return { ok: true, text: 'ok' };
      },
    });
    expect(result.result.ok).toBe(true);
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    // Exactly one assistant row containing the final text (no empty bubble from
    // the leading whitespace-only delta).
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe('ok');
  });

  it('whitespace-only boundary AFTER a tool closed the segment reattaches to the reopened bubble', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession();
    const AUTHORITATIVE = 'part one part two\n\nIt will 401';
    const result = await runHarnessTurn(bridge, session, 'after', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        const onEvent = init?.onEvent;
        await onEvent?.({ type: 'text_delta', text: 'part one ' });
        await onEvent?.({ type: 'text_delta', text: 'part two' });
        // This tool CLOSES the first assistant segment...
        await onEvent?.({ type: 'tool_start', name: 'list_dir' });
        await onEvent?.({
          type: 'tool_result',
          name: 'list_dir',
          ok: true,
          summary: 'list_dir · ok · a',
        });
        // ...so this whitespace-only boundary arrives while NO segment is open.
        // It must be buffered and reattached as the LEADING newline of the next
        // opened segment (#387 after-close residual, review follow-up #1).
        await onEvent?.({ type: 'text_delta', text: '\n\n' });
        await onEvent?.({ type: 'text_delta', text: 'It will 401' });
        await onEvent?.({ type: 'done', text: AUTHORITATIVE });
        return { ok: true, text: AUTHORITATIVE };
      },
    });
    expect(result.result.ok).toBe(true);
    // Session still settles exactly to the authoritative well-formed text.
    const settled = result.session.messages.find((m) => m.role === 'assistant');
    expect(settled?.text).toBe(AUTHORITATIVE);
    // Decision for the after-close order: the blank line attaches as the LEADING
    // newline of the reopened second bubble, so the canvas reconstitutes the
    // exact authoritative text (the tool_run card sits in between, as expected).
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    expect(assistants[0]!.text).toBe('part one part two');
    expect(assistants[assistants.length - 1]!.text).toBe('\n\nIt will 401');
    expect(assistants.map((m) => m.text).join('')).toBe(AUTHORITATIVE);
    // No blank/empty assistant bubble may be created by the whitespace delta.
    expect(assistants.some((m) => m.text.trim() === '')).toBe(false);
  });
});

describe('PONG smoke removal regression lock (#367)', () => {
  it('does not export the host smoke constant', async () => {
    const mod: Record<string, unknown> = await import('./harnessChat');
    // Permanent absence lock: re-adding a dedicated PONG/SMOKE product control
    // must fail this suite, not silently ship.
    expect(mod.HARNESS_SMOKE_PROMPT).toBeUndefined();
    expect(mod.SMOKE_PROMPT).toBeUndefined();
  });
});

describe('runHarnessTurn session activeSandboxId bind', () => {
  it('folds session.activeSandboxId into the agent POST (stream) and reconciles on success', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_active' };
    const { runHarnessTurn } = await import('./harnessChat');
    let sentSandboxId: string | undefined;
    const result = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        sentSandboxId = init?.sandboxId;
        await init?.onEvent?.({ type: 'done', text: 'pong', sandboxId: 'sbx_active' });
        return { ok: true, text: 'pong', sandboxId: 'sbx_active' };
      },
    });
    expect(sentSandboxId).toBe('sbx_active');
    expect(result.result.ok).toBe(true);
    expect(result.session.activeSandboxId).toBe('sbx_active');
  });

  it('folds session.activeSandboxId into the agent POST (JSON) and reconciles on success', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_active' };
    const { runHarnessTurn } = await import('./harnessChat');
    let sentSandboxId: string | undefined;
    const result = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async (_prompt, init) => {
        sentSandboxId = init?.sandboxId;
        return { ok: true, text: 'pong', sandboxId: 'sbx_active' };
      },
    });
    expect(sentSandboxId).toBe('sbx_active');
    expect(result.result.ok).toBe(true);
    expect(result.session.activeSandboxId).toBe('sbx_active');
  });

  it('folds the post-turn EFFECTIVE activeSandboxId (switch target) over the pre-turn sandboxId (JSON, blocker B1)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // Pre-turn bind is `sbx_old`; the turn's `meta_sandbox_switch` moved it.
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_old' };
    const { runHarnessTurn } = await import('./harnessChat');
    let sentSandboxId: string | undefined;
    const result = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async (_prompt, init) => {
        sentSandboxId = init?.sandboxId;
        // Server: resolved (pre-turn) sandboxId BUT effective post-turn switch.
        return {
          ok: true,
          text: 'switched',
          sandboxId: 'sbx_old',
          activeSandboxId: 'sbx_new',
        };
      },
    });
    expect(sentSandboxId).toBe('sbx_old');
    expect(result.result.ok).toBe(true);
    // The switch target wins over the pre-turn `sandboxId` (the B1 bug: the host
    // folded `sbx_old`, silently overwriting the freshly-persisted switch).
    expect(result.session.activeSandboxId).toBe('sbx_new');
  });

  it('folds the post-turn EFFECTIVE activeSandboxId (switch target) over the pre-turn sandboxId (stream, blocker B1)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_old' };
    const { runHarnessTurn } = await import('./harnessChat');
    let sentSandboxId: string | undefined;
    const result = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        sentSandboxId = init?.sandboxId;
        await init?.onEvent?.({
          type: 'done',
          text: 'switched',
          sandboxId: 'sbx_old',
          activeSandboxId: 'sbx_new',
        });
        return {
          ok: true,
          text: 'switched',
          sandboxId: 'sbx_old',
          activeSandboxId: 'sbx_new',
        };
      },
    });
    expect(sentSandboxId).toBe('sbx_old');
    expect(result.result.ok).toBe(true);
    expect(result.session.activeSandboxId).toBe('sbx_new');
  });

  it('does not send sandboxId when session activeSandboxId unset', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = createEmptySession('s');
    const { runHarnessTurn } = await import('./harnessChat');
    let sentSandboxId: string | undefined = 'sentinel';
    await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async (_prompt, init) => {
        sentSandboxId = init?.sandboxId;
        return { ok: true, text: 'pong' };
      },
    });
    expect(sentSandboxId).toBeUndefined();
  });

  it('keeps prior activeSandboxId when the agent success omitted a resolved sandboxId (soft/MCP/http path)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_active' };
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async () => ({ ok: true, text: 'no-fs' }),
    });
    expect(result.session.activeSandboxId).toBe('sbx_active');
  });

  it('hard 403 failure clears the stale activeSandboxId (unusable requested bind)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_dead' };
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async () => ({
        ok: false,
        status: 403,
        error: SANDBOX_FORBIDDEN_ERROR,
      }),
    });
    expect(result.result.ok).toBe(false);
    expect(result.session.activeSandboxId).toBeUndefined();
  });

  it('403 selection-required clears the stale activeSandboxId (grant-honesty class)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_stale' };
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async () => ({
        ok: false,
        status: 403,
        error: SANDBOX_SELECTION_REQUIRED_ERROR,
      }),
    });
    expect(result.result.ok).toBe(false);
    expect(result.session.activeSandboxId).toBeUndefined();
  });

  it('403 WORKSPACE_INSTANCE_REQUIRED keeps the activeSandboxId bind (softContinue, not a poison grant) (review #484 Major)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_vercel' };
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async () => ({
        ok: false,
        status: 403,
        error: WORKSPACE_INSTANCE_REQUIRED_ERROR,
      }),
    });
    expect(result.result.ok).toBe(false);
    // An instance-down bind is a usable GRANT — clearing it here would silently
    // re-resolve to the preferred/single grant on the next turn. The host keeps
    // the session bind so the operator just starts the instance (review #484).
    expect(result.session.activeSandboxId).toBe('sbx_vercel');
  });

  it('non-403 failure keeps the activeSandboxId binding', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_keep' };
    const { runHarnessTurn } = await import('./harnessChat');
    const result = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async () => ({
        ok: false,
        status: 422, // plan #759 — permanent (terminal); 5xx would retry
        error: 'inference down',
      }),
    });
    expect(result.result.ok).toBe(false);
    expect(result.session.activeSandboxId).toBe('sbx_keep');
  });
});

describe('runHarnessTurn session persona carrier (phase 3 #488)', () => {
  it('folds sessionId + personaId into the agent POST (stream path)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      ...createEmptySession('sess_abc123'),
      personaId: 'pers_1',
    };
    let sent: { sessionId?: string; personaId?: string } = {};
    await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        sent = init ?? {};
        await init?.onEvent?.({ type: 'done', text: 'pong' });
        return { ok: true, text: 'pong' };
      },
    });
    expect(sent.sessionId).toBe('sess_abc123');
    expect(sent.personaId).toBe('pers_1');
  });

  it('folds sessionId + personaId into the agent POST (JSON path)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      ...createEmptySession('sess_abc123'),
      personaId: 'pers_1',
    };
    let sent: { sessionId?: string; personaId?: string } = {};
    await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async (_prompt, init) => {
        sent = init ?? {};
        return { ok: true, text: 'pong' };
      },
    });
    expect(sent.sessionId).toBe('sess_abc123');
    expect(sent.personaId).toBe('pers_1');
  });

  it('omits personaId when unset and drops a non-Redis-safe personaId (fail-closed)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      ...createEmptySession('sess_1'),
      personaId: 'bad persona id with :, and *',
    };
    let sent: { personaId?: string } = {};
    await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async (_prompt, init) => {
        sent = init ?? {};
        return { ok: true, text: 'pong' };
      },
    });
    expect(sent.personaId).toBeUndefined();
  });
});

describe('skill attach display (phase 2 #517)', () => {
  it('builds display-only row text for attach/detach outcomes', () => {
    expect(skillRowText({ action: 'attach', slug: 'create-plan', ok: true })).toBe(
      'Skill attached: create-plan',
    );
    expect(skillRowText({ action: 'attach', slug: 'x', ok: false })).toBe(
      'Skill not attached: x',
    );
    expect(skillRowText({ action: 'detach', slug: 'x', ok: true })).toBe(
      'Skill detached: x',
    );
    expect(skillRowText({ action: 'detach', slug: 'x', ok: false })).toBe(
      'Skill not attached: x',
    );
  });

  it('JSON (non-stream) path pushes a display-only skill_attached row from skillEvents', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'will scaffold',
      skillEvents: [{ action: 'attach', slug: 'create-plan', ok: true }],
    }));
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'go', {
      sendAgent,
      pushUser: false,
    });
    // Session carries the display-only skill_attached role.
    const skillRows = next.messages.filter((m) => m.role === 'skill_attached');
    expect(skillRows).toHaveLength(1);
    expect(skillRows[0]!.text).toBe('Skill attached: create-plan');
    // Bridge got a kind-7 skill row (display-only), never the body.
    expect(exp.__messages.some((m) => m.kind === MessageKind.SkillAttached)).toBe(true);
    expect(
      exp.__messages.find((m) => m.kind === MessageKind.SkillAttached)?.text,
    ).toBe('Skill attached: create-plan');
  });

  it('JSON path pushes detach + failure rows too', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'ok',
      skillEvents: [
        { action: 'detach', slug: 'a', ok: true },
        { action: 'attach', slug: 'missing', ok: false, reason: 'unknown skill' },
      ],
    }));
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'go', {
      sendAgent,
      pushUser: false,
    });
    const skillRows = next.messages.filter((m) => m.role === 'skill_attached');
    expect(skillRows.map((m) => m.text)).toEqual([
      'Skill detached: a',
      'Skill not attached: missing',
    ]);
    const bridgeSkill = exp.__messages.filter((m) => m.kind === MessageKind.SkillAttached);
    expect(bridgeSkill.map((m) => m.text)).toEqual([
      'Skill detached: a',
      'Skill not attached: missing',
    ]);
  });

  it('SSE (stream) path pushes skill_attached rows live from onEvent events', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'list', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_prompt, init) => {
        // Server sends skill_attached at the START, before the model.
        await init?.onEvent?.({
          type: 'skill_attached',
          slug: 'create-plan',
          action: 'attach',
          ok: true,
        });
        await init?.onEvent?.({ type: 'text_delta', text: 'done' });
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });
    expect(
      next.messages.some(
        (m) => m.role === 'skill_attached' && m.text === 'Skill attached: create-plan',
      ),
    ).toBe(true);
    expect(exp.__messages.some((m) => m.kind === MessageKind.SkillAttached)).toBe(true);
  });

  it('hydrate maps the persisted skill_attached role to kind 7', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: [
        { id: 'u', role: 'user' as const, text: 'hi', at: 1 },
        {
          id: 'sk',
          role: 'skill_attached' as const,
          text: 'Skill attached: create-plan',
          at: 2,
        },
        { id: 'a', role: 'assistant' as const, text: 'done', at: 3 },
      ],
    };
    pushSessionToBridge(bridge, session, { clear: false });
    const skillRow = exp.__messages.find((m) => m.kind === MessageKind.SkillAttached);
    expect(skillRow).toBeDefined();
    expect(skillRow!.text).toBe('Skill attached: create-plan');
  });

  it('restoreLastUiKind treats a trailing skill_attached row as an assistant boundary', () => {
    // A skill row is a non-tool separator — the first tool after it opens a fresh card.
    expect(restoreLastUiKind([makeMessage('skill_attached', 'Skill attached: x')])).toBe(
      'assistant',
    );
  });

  it('the persisted skill row is NOT folded into the model prompt on continue', () => {
    const session = createEmptySession('s1');
    session.messages.push(
      makeMessage('skill_attached', 'Skill attached: create-plan'),
      makeMessage('assistant', 'done'),
    );
    const folded = formatPromptWithHistory(session.messages, 'next');
    expect(folded).not.toContain('Skill attached');
  });

  it('stream skill_attached events fold the sticky attachedSlugs onto the session (last-writes-wins)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), '/foo then /bar', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_prompt, init) => {
        // Server emits skill_attached at the START; EVERY event carries the
        // same final set, so applying each (last-writes-wins) never clears.
        await init?.onEvent?.({
          type: 'skill_attached',
          slug: 'foo',
          action: 'attach',
          ok: true,
          attachedSlugs: ['foo'],
        });
        await init?.onEvent?.({
          type: 'skill_attached',
          slug: 'bar',
          action: 'attach',
          ok: true,
          attachedSlugs: ['foo', 'bar'],
        });
        await init?.onEvent?.({ type: 'done', text: 'ok' });
        return { ok: true, text: 'ok' };
      },
    });
    expect(next.attachedSlugs).toEqual(['foo', 'bar']);
  });

  it('skill_attached omitted attachedSlugs leaves the set; [] is an explicit detach-all (Nit L6)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), '/a /b', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({
          type: 'skill_attached',
          slug: 'a',
          action: 'attach',
          ok: true,
          attachedSlugs: ['a'],
        });
        // A later event OMITS the field — it must NOT be read as *clear*.
        await init?.onEvent?.({
          type: 'skill_attached',
          slug: 'b',
          action: 'detach',
          ok: false,
          reason: 'not attached',
        });
        // Explicit detach-all: [] clears the set to empty (persisted as "[]").
        await init?.onEvent?.({
          type: 'skill_attached',
          slug: 'x',
          action: 'attach',
          ok: true,
          attachedSlugs: [],
        });
        await init?.onEvent?.({ type: 'done', text: 'ok' });
        return { ok: true, text: 'ok' };
      },
    });
    expect(next.attachedSlugs).toEqual([]);
  });

  it('JSON success path folds agentResult.attachedSlugs onto the session', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'ok',
      attachedSlugs: ['create-plan'],
    }));
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'go', {
      sendAgent,
      pushUser: false,
    });
    expect(next.attachedSlugs).toEqual(['create-plan']);
  });

  it('a FAILED turn still folds the sticky attachedSlugs before persist (fold-before-persist incl. fail/cancel)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      error: 'model boom',
      status: 422, // plan #759 — permanent (terminal); 5xx would retry
      attachedSlugs: ['create-plan'],
    }));
    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'go', {
      sendAgent,
      pushUser: false,
    });
    expect(next.attachedSlugs).toEqual(['create-plan']);
  });
});

describe('status-slot fold (protocol v13, plan #538/#541)', () => {
  it('folds sandbox + cwd into the pack after a successful agent turn (JSON)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_vercel', cwd: 'invincible/sub' };
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'done',
      sandboxId: 'sbx_vercel',
      cwd: 'invincible/sub',
    }));
    await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(statusSlotAt(exp, StatusSlot.Sandbox)).toBe('sandbox sbx_vercel');
    expect(statusSlotAt(exp, StatusSlot.Cwd)).toBe('invincible/sub');
  });

  it('screen: no-FS turn omits cwd but still folds the bind', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_byo' };
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'http only',
      activeSandboxId: 'sbx_byo',
    }));
    await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(statusSlotAt(exp, StatusSlot.Sandbox)).toBe('sandbox sbx_byo');
    expect(statusSlotAt(exp, StatusSlot.Cwd)).toBe('');
  });

  it('pushSessionToBridge folds slots on hydrate (restore)', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      id: 's1',
      updatedAt: 0,
      activeSandboxId: 'sbx_vercel',
      cwd: 'invincible',
      messages: [makeMessage('user', 'hi')],
    };
    pushSessionToBridge(bridge, session, { clear: true });
    expect(statusSlotAt(exp, StatusSlot.Sandbox)).toBe('sandbox sbx_vercel');
    expect(statusSlotAt(exp, StatusSlot.Cwd)).toBe('invincible');
  });

  it('explicit no-bind / no-cwd session clears the slots (mutually safe)', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // Pre-seed stale slots, then fold a bare session → clears them.
    bridge.setStatusSlot(StatusSlot.Sandbox, 'sandbox stale');
    bridge.setStatusSlot(StatusSlot.Cwd, 'stale');
    foldStatusSlots(bridge, createEmptySession('s'));
    expect(statusSlotAt(exp, StatusSlot.Sandbox)).toBe('');
    expect(statusSlotAt(exp, StatusSlot.Cwd)).toBe('');
  });

  it('a FAILED 403 selection-required turn repaints the header to clear the cleared bind (PR #543 L1 Major)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_stale', cwd: 'invincible' };
    // Pre-seed the header with STALE slots — a no-fold fail path would leave them.
    bridge.setStatusSlot(StatusSlot.Sandbox, 'sandbox sbx_old');
    bridge.setStatusSlot(StatusSlot.Cwd, 'stale-cwd');
    const { result, session: next } = await runHarnessTurn(bridge, session, 'hi', {
      streamAgent: false,
      sendAgent: async () => ({
        ok: false,
        status: 403,
        error: SANDBOX_SELECTION_REQUIRED_ERROR,
      }),
    });
    expect(result.ok).toBe(false);
    expect(next.activeSandboxId).toBeUndefined();
    // The cleared bind is repainted away; the retained cwd is re-shown.
    expect(statusSlotAt(exp, StatusSlot.Sandbox)).toBe('');
    expect(statusSlotAt(exp, StatusSlot.Cwd)).toBe('invincible');
  });

  it('a CANCELLED turn still repaints the committed change_dir cwd into the header (PR #543 L1 Major)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), cwd: 'invincible' };
    bridge.setStatusSlot(StatusSlot.Sandbox, 'sandbox stale');
    bridge.setStatusSlot(StatusSlot.Cwd, 'stale-cwd');
    const { result, session: next } = await runHarnessTurn(bridge, session, 'cd', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_p, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'change_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'change_dir',
          ok: true,
          summary: 'change_dir · ✓ ok · invincible/sub · cwd=invincible/sub',
          // The confirmed cwd rides as a typed field (adversarial review #470).
          changeDirCwd: 'invincible/sub',
        });
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(result.ok).toBe(false);
    expect(next.cwd).toBe('invincible/sub');
    // Header repainted to the boot cwd the next turn will actually use; stale cleared.
    expect(statusSlotAt(exp, StatusSlot.Cwd)).toBe('invincible/sub');
    expect(statusSlotAt(exp, StatusSlot.Sandbox)).toBe('');
  });

  it('truncateStatusValue truncates an oversize value to the byte cap with "…" (PR #543 #3)', () => {
    const long = 'a'.repeat(97); // 97 UTF-8 bytes > the 96-cap
    const out = truncateStatusValue(long);
    expect(out).toBe('a'.repeat(93) + '…');
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(96);
    expect(out.endsWith('…')).toBe(true);
  });

  it('truncateStatusValue never splits a UTF-8 code point; short/empty pass harmlessly (PR #543 #3)', () => {
    expect(truncateStatusValue('cwd')).toBe('cwd');
    expect(truncateStatusValue('')).toBe('');
    expect(truncateStatusValue('   ')).toBe('');
    // "₿" (U+20BF) is 3 UTF-8 bytes: cap 96 → budget 93 = 31 × 3, then "…".
    const out = truncateStatusValue('₿'.repeat(40));
    expect(out).toBe('₿'.repeat(31) + '…');
    expect(new TextEncoder().encode(out).length).toBe(31 * 3 + 3);
    // No lone replacement char / broken multi-byte tail from slicing mid-sequence.
    expect(out.includes('\uFFFD')).toBe(false);
  });

  it('a long cwd is truncated into the header slot, never stalled on a stale prior value (PR #543 #3)', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // A workspace-relative cwd ≥ 97 bytes (realistic deep under node_modules).
    const longCwd = 'packages/' + 'a/'.repeat(50) + 'truly';
    expect(new TextEncoder().encode(longCwd).length).toBeGreaterThan(96);
    // Pre-seed a STALE short cwd — the no-truncate bug would leave THIS painted.
    bridge.setStatusSlot(StatusSlot.Cwd, 'stale-cwd');
    const session = { ...createEmptySession('s'), cwd: longCwd, activeSandboxId: 'sbx_v' };
    foldStatusSlots(bridge, session);
    expect(statusSlotAt(exp, StatusSlot.Sandbox)).toBe('sandbox sbx_v');
    // The long cwd lands as an honest truncated-with-ellipsis value (not stale,
    // not a rejected push that silently kept the prior short cwd).
    const painted = statusSlotAt(exp, StatusSlot.Cwd);
    expect(painted).not.toBe('stale-cwd');
    expect(painted.startsWith(longCwd.slice(0, 10))).toBe(true);
    expect(painted.endsWith('…')).toBe(true);
    expect(new TextEncoder().encode(painted).length).toBeLessThanOrEqual(96);
  });
});

describe('refreshGitStatusSlot (phase 2, plan #540)', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    global.fetch = realFetch;
  });

  function stubFetch(json: unknown, ok = true, status = 200) {
    fetchMock = vi.fn(async () => ({
      ok,
      status,
      json: async () => json,
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
  }

  it('pushes a non-empty probe value into the Git slot and ellipsizes to the cap', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubFetch({ value: 'feature/x@a1b2c3d' });
    const session = {
      ...createEmptySession('sess_abc123'),
      activeSandboxId: 'sbx_redis_safe',
    };
    await refreshGitStatusSlot(bridge, session);
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('feature/x@a1b2c3d');
    // sandboxId + sessionId carries were folded into the query string.
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('sandboxId=sbx_redis_safe');
    expect(url).toContain('sessionId=sess_abc123');
  });

  it('clears the Git slot on a genuinely empty probe result (no stale prior value)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setStatusSlot(StatusSlot.Git, 'old@123');
    stubFetch({ value: '' });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s'), activeSandboxId: 'sbx_x' });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('');
  });

  it('keeps the last value on network error / non-ok / 429 — never clears on a transient refresh', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setStatusSlot(StatusSlot.Git, 'main@abc');
    // network throw
    fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s') });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc');

    // non-ok
    stubFetch({}, false, 500);
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s') });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc');

    // 429 rate-limited (route never actually sends 429 — see next test for the
    // real wire shape; this guards against a future backend change).
    stubFetch({}, true, 429);
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s') });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc');
  });

  it('a rate-limited 200 ({ git, rate_limited:true, value }) KEEPS the slot, never clears (pr #544 #1)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // The route's in-window reply IS this 200 shape — it carries the cached
    // formatted `value`, which the host must paint (KEEP-last), NOT clear.
    bridge.setStatusSlot(StatusSlot.Git, 'old@123');
    stubFetch({ git: { branch: 'main', sha: 'a1b2c3d' }, rate_limited: true, value: 'main@a1b2c3d' });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s') });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@a1b2c3d');
  });

  it('omits non-Redis-safe carries (never a poisoned query string), still clears on empty', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      ...createEmptySession('bad session :*'),
      activeSandboxId: 'bad sandbox *,',
    };
    stubFetch({ value: 'main@1' });
    await refreshGitStatusSlot(bridge, session);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).not.toContain('activeSandboxId');
    expect(url).not.toContain('bad');
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@1');
  });

  it('ellipsizes an oversize git value to the 96-byte cap before the wire', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const longVal = 'feature/' + 'x'.repeat(120);
    stubFetch({ value: longVal });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s') });
    const painted = statusSlotAt(exp, StatusSlot.Git);
    expect(painted.endsWith('…')).toBe(true);
    expect(new TextEncoder().encode(painted).length).toBeLessThanOrEqual(96);
  });

  it('suppresses a SHA-only probe (sha present, branch absent) — keeps the last honest branch@sha (plan #660)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setStatusSlot(StatusSlot.Git, 'main@abc1234');
    // Detached-HEAD probe: sha=abc1234, no branch → formatted value @abc1234.
    stubFetch({ value: '@abc1234', git: { sha: 'abc1234' } });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s'), activeSandboxId: 'sbx_x' });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc1234');
  });

  it('suppresses a dirty SHA-only probe (sha+dirty, branch absent)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setStatusSlot(StatusSlot.Git, 'main@abc1234');
    // Detached HEAD + dirty tree: sha present, branch absent, dirty=true.
    stubFetch({ value: '@abc1234*', git: { sha: 'abc1234', dirty: true } });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s'), activeSandboxId: 'sbx_x' });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc1234');
  });

  it('passes through an @-prefixed branch name (@hotfix@sha) — structured git.branch is authoritative (L1 fix)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // `git branch @hotfix` is legal; git check-ref-format accepts @-prefixed
    // branch names. Structured fields have both branch AND sha → passes through.
    stubFetch({ value: '@hotfix@abc1234', git: { branch: '@hotfix', sha: 'abc1234' } });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s'), activeSandboxId: 'sbx_x' });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('@hotfix@abc1234');
  });

  it('passes through a normal branch@sha value (both branch and sha present)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubFetch({ value: 'main@abc1234', git: { branch: 'main', sha: 'abc1234' } });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s'), activeSandboxId: 'sbx_x' });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc1234');
  });

  it('passes through a dirty branch@sha value (branch+sha+dirty)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubFetch({ value: 'main@abc1234*', git: { branch: 'main', sha: 'abc1234', dirty: true } });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s'), activeSandboxId: 'sbx_x' });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc1234*');
  });

  it('passes through a branch-only value (branch present, no sha)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubFetch({ value: 'main', git: { branch: 'main' } });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s'), activeSandboxId: 'sbx_x' });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main');
  });

  it('clears the slot on genuinely empty probe after SHA-only was suppressed earlier (not stale)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // First: SHA-only probe → suppressed (keep main@abc).
    bridge.setStatusSlot(StatusSlot.Git, 'main@abc');
    stubFetch({ value: '@xyz', git: { sha: 'xyz' } });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s') });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc');
    // Then: a real clear (empty value) → clear the slot.
    stubFetch({ value: '' });
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s') });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('');
  });

  it('suppression does not fire on network error (keep-last code path — no structured check needed)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setStatusSlot(StatusSlot.Git, 'main@abc');
    // network throw — code path never reaches the structured git guard.
    fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s') });
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc');
  });

  it('suppression does not fire on 429 (keep-last short-circuits before JSON parse)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setStatusSlot(StatusSlot.Git, 'main@abc');
    stubFetch({}, true, 429);
    await refreshGitStatusSlot(bridge, { ...createEmptySession('s') });
    // 429 short-circuits before the JSON parse → before the structured guard.
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc');
  });
});
describe('hydrate/turn-refresh git wiring (phase 2, plan #540 — pr #544 #3)', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  afterEach(() => {
    global.fetch = realFetch;
  });

  function stubFetch(json: unknown, ok = true, status = 200) {
    fetchMock = vi.fn(async () => ({
      ok,
      status,
      json: async () => json,
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
  }

  it('hydrate (pushSessionToBridge) fires the git probe with the session carries', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubFetch({ value: 'main@abc' });
    const session = {
      id: 'sess_hyd',
      updatedAt: 0,
      activeSandboxId: 'sbx_v',
      cwd: 'invincible',
      messages: [makeMessage('user', 'hi')],
    };
    pushSessionToBridge(bridge, session, { clear: true });
    // flush the fire-and-forget refresh microtasks
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalled();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('sandboxId=sbx_v');
    expect(url).toContain('sessionId=sess_hyd');
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('main@abc');
  });

  it('a successful agent turn fires the git probe after the status fold', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubFetch({ value: 'feature@1' });
    const session = { ...createEmptySession('sess_ok'), activeSandboxId: 'sbx_v', cwd: 'invincible' };
    const sendAgent = vi.fn(async () => ({
      ok: true as const,
      text: 'done',
      sandboxId: 'sbx_v',
      cwd: 'invincible/sub',
    }));
    await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalled();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('sessionId=sess_ok');
    // the git slot was painted from the refreshed value
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('feature@1');
  });

  it('a failed/cancelled agent turn fires the git probe alongside the fail fold', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubFetch({ value: 'wip@2' });
    const session = { ...createEmptySession('sess_fail'), activeSandboxId: 'sbx_v', cwd: 'invincible' };
    const sendAgent = vi.fn(async () => ({
      ok: false as const,
      status: 503,
      error: 'Sandbox not configured. Set SANDBOX_URL and SANDBOX_TOKEN.',
    }));
    const { result } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(result.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalled();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('sessionId=sess_fail');
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('wip@2');
  });

  it('an ABORTED turn STILL fires the git probe on the fail path (pr #544 Minor L1 fix)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const controller = new AbortController();
    // Pre-abort: a user Stop leaves `opts.signal` already aborted when this fail
    // path runs — the exact "stale git slot until the cadence tick" gap the
    // reviewer flagged (#544 Minor L1). Without the fix the fail path forwarded
    // `opts?.signal` onto `fetch`, so an aborted signal rejected instantly and
    // the probe was a dead no-op.
    controller.abort();
    // Real `fetch` rejects immediately when handed an already-aborted signal; the
    // stub mirrors that, so the OLD code hits the catch/keep-last and this test
    // would fail (git slot stays stale). The FIX omits the signal on the fail
    // path, so the probe still runs and repaints.
    fetchMock = vi.fn(
      async (_url: string | URL, init?: { signal?: AbortSignal }) => {
        if (init?.signal?.aborted) throw new Error('aborted signal forwarded');
        return {
          ok: true,
          status: 200,
          json: async () => ({ value: 'cancel@fixed' }),
        };
      },
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const session = {
      ...createEmptySession('sess_abort'),
      activeSandboxId: 'sbx_v',
      cwd: 'invincible',
    };
    const sendAgent = vi.fn(async () => ({
      ok: false as const,
      error: 'Request cancelled.',
    }));
    const { result } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    // The fail-path refresh runs WITHOUT the aborted signal, so the probe fires
    // instead of dying as an AbortError; the git slot is repainted.
    expect(fetchMock).toHaveBeenCalled();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/harness/status');
    expect(url).toContain('sessionId=sess_abort');
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('cancel@fixed');
  });

  it('hydrate with clear:false (ring-only) does NOT fire the git probe', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubFetch({ value: 'should-not-paint' });
    const session = {
      id: 's1',
      updatedAt: 0,
      messages: [makeMessage('user', 'hi')],
    };
    pushSessionToBridge(bridge, session, { clear: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(statusSlotAt(exp, StatusSlot.Git)).toBe('');
  });
});

describe('context/usage slot (phase 3, plan #539 / #327)', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  function stubGitOk() {
    // The turn paths fire `refreshGitStatusSlot`; make it a harmless no-op so the
    // context-slot assertions below are deterministic.
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: '' }),
    })) as unknown as typeof fetch;
  }

  it('foldStatusSlots paints the context slot from session.usage and hides on absence', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    foldStatusSlots(bridge, {
      ...createEmptySession('s'),
      usage: { source: 'provider', prompt: 120, completion: 40, total: 160 } as never,
    });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('120 in · 40 out · 160 tok');

    // Absent / non-provider usage → hidden (default), never a fake total.
    const exp2 = makeMockExports();
    const bridge2 = new HarnessBridge(exp2);
    bridge2.setStatusSlot(StatusSlot.Context, 'stale-in');
    foldStatusSlots(bridge2, {
      ...createEmptySession('s'),
      usage: { source: 'estimated', prompt: 5 } as never,
    });
    expect(statusSlotAt(exp2, StatusSlot.Context)).toBe('');
  });

  it('a successful agent turn folds provider usage into the context slot (JSON)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubGitOk();
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'done',
      usage: { source: 'provider', prompt: 300, completion: 100, total: 400 },
    }));
    const { session: next } = await runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('300 in · 100 out · 400 tok');
    expect(next.usage).toEqual({
      source: 'provider',
      prompt: 300,
      completion: 100,
      total: 400,
    });
  });

  it('a successful stream turn folds usage from the done event into the context slot', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubGitOk();
    const { session: next } = await runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_p, init) => {
        await init?.onEvent?.({
          type: 'done',
          text: 'ok',
          usage: { source: 'provider', prompt: 7, completion: 3, total: 10 },
        });
        // Production sendAgentStream parses the done-event usage onto the result;
        // the host folds `agentResult.usage` (not the raw event).
        return {
          ok: true,
          text: 'ok',
          usage: { source: 'provider', prompt: 7, completion: 3, total: 10 },
        };
      },
    });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('7 in · 3 out · 10 tok');
    expect(next.usage).toEqual({
      source: 'provider',
      prompt: 7,
      completion: 3,
      total: 10,
    });
  });

  it('a COMPLETED turn with no provider usage CLEARS the context slot (default hidden), never a stale prior', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubGitOk();
    // Prior turn painted "120 in"; this NEXT completed turn reports no usage.
    bridge.setStatusSlot(StatusSlot.Context, '120 in');
    const session = {
      ...createEmptySession('s'),
      usage: { source: 'provider', prompt: 120 } as never,
    };
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'ok', // completed, but no usage → must hide, not keep the stale 120
    }));
    const { session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(next.usage).toBeUndefined();
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('');
  });

  it('an aborted/cancelled turn carries the prior honest usage forward (never a fake or cleared number)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubGitOk();
    const session = {
      ...createEmptySession('sess'),
      usage: { source: 'provider', prompt: 55, completion: 20 } as never,
    };
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      error: 'Request cancelled.',
    }));
    const { result, session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(result.ok).toBe(false);
    // No completion → no new usage emitted; the prior honest value is kept.
    expect(next.usage).toEqual({ source: 'provider', prompt: 55, completion: 20 });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('55 in · 20 out');
  });

  it('a failed turn keeps the prior usage (no fake usage emitted on a hard error)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubGitOk();
    const session = {
      ...createEmptySession('s'),
      usage: { source: 'provider', prompt: 9, completion: 1, total: 10 } as never,
    };
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 422, // plan #759 — permanent (terminal); 5xx would retry
      error: 'boom',
    }));
    const { result, session: next } = await runHarnessTurn(bridge, session, 'hi', {
      sendAgent,
      pushUser: false,
      streamAgent: false,
    });
    expect(result.ok).toBe(false);
    expect(next.usage).toEqual({ source: 'provider', prompt: 9, completion: 1, total: 10 });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('9 in · 1 out · 10 tok');
  });

  it('Clear/New (empty session) resets the context slot to hidden via fold', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setStatusSlot(StatusSlot.Context, 'stale-in');
    // A fresh empty session (what Clear mints) folds to hidden.
    foldStatusSlots(bridge, createEmptySession('new'));
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('');
  });

  it('the chat (preferAgent:false) success path also folds usage into the context slot', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (): Promise<ChatResult> => ({
      ok: true,
      text: 'chat pong',
      usage: { source: 'provider', prompt: 21, completion: 9, total: 30 },
    }));
    const { result, session: next } = await runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
      preferAgent: false,
      send,
    });
    expect(result.ok).toBe(true);
    expect(next.usage).toEqual({ source: 'provider', prompt: 21, completion: 9, total: 30 });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('21 in · 9 out · 30 tok');
  });

  it('a chat (preferAgent:false) failure keeps the prior usage (no fake usage on no completion)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubGitOk();
    const send = vi.fn(async (): Promise<ChatResult> => ({
      ok: false,
      status: 503,
      error: 'boom',
    }));
    const session = {
      ...createEmptySession('s'),
      usage: { source: 'provider', prompt: 4 } as never,
    };
    const { result, session: next } = await runHarnessTurn(bridge, session, 'hi', {
      preferAgent: false,
      send,
    });
    expect(result.ok).toBe(false);
    expect(next.usage).toEqual({ source: 'provider', prompt: 4 });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('4 in');
  });

  it('hydrate of a session with usage restores the context slot', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = {
      id: 's1',
      updatedAt: 0,
      usage: { source: 'provider', prompt: 5, completion: 2 } as never,
      messages: [makeMessage('user', 'hi')],
    };
    pushSessionToBridge(bridge, session, { clear: true });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('5 in · 2 out');
  });

  it('an oversize/poisoned session usage never paints (sanitized to hidden)', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setStatusSlot(StatusSlot.Context, 'stale');
    // A localStorage-poisoned usage with absurd clamped counts would over-cap →
    // sanitized to undefined on load; the fold treats the value as absent.
    foldStatusSlots(bridge, {
      ...createEmptySession('s'),
      usage: {
        source: 'provider',
        prompt: 1e15,
        completion: 1e15,
        total: 1e15,
        cached: 1e15,
      } as never,
    });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('');
  });

  it('a stream usage event mid-turn folds the context slot before done AND calls onSessionPatch (Phase 3 #628)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubGitOk();
    const patches: Array<Record<string, unknown>> = [];
    const { session: next } = await runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
      streamAgent: true,
      pushUser: false,
      onSessionPatch: (s) => patches.push({ usage: s.usage }),
      sendAgentStream: async (_p, init) => {
        // Mid-stream usage event from a finish part (aggregate).
        await init?.onEvent?.({
          type: 'usage',
          usage: { source: 'provider', prompt: 42, completion: 8, total: 50 },
        });
        // Then the final done reconcile.
        await init?.onEvent?.({
          type: 'done',
          text: 'ok',
          usage: { source: 'provider', prompt: 55, completion: 10, total: 65 },
        });
        return {
          ok: true,
          text: 'ok',
          usage: { source: 'provider', prompt: 55, completion: 10, total: 65 },
        };
      },
    });
    // The mid-stream fold happened — onSessionPatch was called with the live value.
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      usage: { source: 'provider', prompt: 42, completion: 8, total: 50 },
    });
    // The final reconcile wins.
    expect(next.usage).toEqual({
      source: 'provider',
      prompt: 55,
      completion: 10,
      total: 65,
    });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('55 in · 10 out · 65 tok');
  });

  it('done with absent usage after a mid-stream usage event clears to the completed-turn rule (Phase 3 #628)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubGitOk();
    const { session: next } = await runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_p, init) => {
        // Mid-stream usage event.
        await init?.onEvent?.({
          type: 'usage',
          usage: { source: 'provider', prompt: 10, completion: 2 },
        });
        // Done with NO usage — the completed-turn rule clears it.
        await init?.onEvent?.({ type: 'done', text: 'ok' });
        return { ok: true, text: 'ok' };
      },
    });
    expect(next.usage).toBeUndefined();
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('');
  });

  it('abort after a live usage event keeps that summary (fail path does not clear — Phase 3 #628)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    stubGitOk();
    const { session: next } = await runHarnessTurn(bridge, createEmptySession('s'), 'hi', {
      streamAgent: true,
      pushUser: false,
      sendAgentStream: async (_p, init) => {
        // Live usage event arrives before the abort.
        await init?.onEvent?.({
          type: 'usage',
          usage: { source: 'provider', prompt: 30, completion: 5, total: 35 },
        });
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    // The live usage event was folded into the session before the abort.
    // The fail path does NOT clear usage → it carries forward.
    expect(next.usage).toEqual({
      source: 'provider',
      prompt: 30,
      completion: 5,
      total: 35,
    });
    expect(statusSlotAt(exp, StatusSlot.Context)).toBe('30 in · 5 out · 35 tok');
  });
});

describe('Phase 2 mid-turn live status bar (plan #627)', () => {
  it('stream change_dir mid-turn updates cwd AND calls onSessionPatch before done (test 2)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), cwd: 'invincible' };
    const patches: string[] = [];
    const { session: next } = await runHarnessTurn(bridge, session, 'cd', {
      streamAgent: true,
      pushUser: false,
      onSessionPatch: (s) => {
        patches.push(s.cwd ?? '(unset)');
      },
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'change_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'change_dir',
          ok: true,
          summary: 'change_dir · ✓ ok · invincible/sub · cwd=invincible/sub',
          changeDirCwd: 'invincible/sub',
        });
        await init?.onEvent?.({ type: 'done', text: 'moved' });
        return { ok: true, text: 'moved' };
      },
    });
    // onSessionPatch was called mid-turn with the new cwd.
    expect(patches).toContain('invincible/sub');
    // Session carries the new cwd.
    expect(next.cwd).toBe('invincible/sub');
    // Status slots were repainted mid-turn.
    expect(statusSlotAt(exp, StatusSlot.Cwd)).toBe('invincible/sub');
  });

  it('stream meta_sandbox_switch mid-turn updates bind + git slot before done (test 3)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), activeSandboxId: 'sbx_old' };
    const patches: Array<string | undefined> = [];
    // The switch branch fires an on-demand `refreshGitStatusSlot(bridge, next)`
    // with the NEW bind — spy that the probe actually hits the wire with
    // `sandboxId=sbx_new` before `done`, so deleting that call (or passing the
    // stale pre-switch `session`) fails here instead of silently keeping the git
    // slot on the old bind until the 10 s cadence.
    const realFetch = global.fetch;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ value: 'feature/x@a1b2c3d' }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { session: next } = await runHarnessTurn(bridge, session, 'switch', {
        streamAgent: true,
        pushUser: false,
        onSessionPatch: (s) => {
          patches.push(s.activeSandboxId);
        },
        sendAgentStream: async (_prompt, init) => {
          await init?.onEvent?.({ type: 'tool_start', name: 'meta_sandbox_switch' });
          await init?.onEvent?.({
            type: 'tool_result',
            name: 'meta_sandbox_switch',
            ok: true,
            summary: 'meta_sandbox_switch · ✓ ok · switched active sandbox to id=sbx_new',
            activeSandboxId: 'sbx_new',
          });
          await init?.onEvent?.({
            type: 'done',
            text: 'switched',
            sandboxId: 'sbx_old',
            activeSandboxId: 'sbx_new',
          });
          return { ok: true, text: 'switched', sandboxId: 'sbx_old', activeSandboxId: 'sbx_new' };
        },
      });
      // onSessionPatch was called mid-turn with the new bind.
      expect(patches).toContain('sbx_new');
      // Session carries the new bind.
      expect(next.activeSandboxId).toBe('sbx_new');
      // Sandbox slot was repainted mid-turn.
      expect(statusSlotAt(exp, StatusSlot.Sandbox)).toBe('sandbox sbx_new');
      // flush the fire-and-forget git probe microtasks
      await new Promise((r) => setTimeout(r, 0));
      // The on-demand git probe fired and carried the NEW bind.
      expect(fetchMock).toHaveBeenCalled();
      const calls = fetchMock.mock.calls as unknown[][];
      const url = String(calls[0]?.[0] ?? '');
      expect(url).toContain('/api/harness/status');
      expect(url).toContain('sandboxId=sbx_new');
      expect(url).not.toContain('sandboxId=sbx_old');
      expect(statusSlotAt(exp, StatusSlot.Git)).toBe('feature/x@a1b2c3d');
    } finally {
      global.fetch = realFetch;
    }
  });

  it('abort after a live change_dir keeps cwd/bind (test 4)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = { ...createEmptySession('s'), cwd: 'invincible', activeSandboxId: 'sbx_v' };
    const patches: string[] = [];
    const { result, session: next } = await runHarnessTurn(bridge, session, 'cd', {
      streamAgent: true,
      pushUser: false,
      onSessionPatch: (s) => {
        patches.push(s.cwd ?? '(unset)');
      },
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'change_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'change_dir',
          ok: true,
          summary: 'change_dir · ✓ ok · invincible/deep · cwd=invincible/deep',
          changeDirCwd: 'invincible/deep',
        });
        return { ok: false, error: 'Request cancelled.' };
      },
    });
    expect(result.ok).toBe(false);
    // onSessionPatch was called mid-turn before the abort.
    expect(patches).toContain('invincible/deep');
    // After abort, cwd is kept (live patch survives).
    expect(next.cwd).toBe('invincible/deep');
    // Bind is also kept (no switch happened, but existing value survives).
    expect(next.activeSandboxId).toBe('sbx_v');
    // Status slots reflect the live patch.
    expect(statusSlotAt(exp, StatusSlot.Cwd)).toBe('invincible/deep');
    expect(statusSlotAt(exp, StatusSlot.Sandbox)).toBe('sandbox sbx_v');
  });

  it('onSessionPatch is NOT awaited — fire-and-forget (test 5)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    let patchResolved = false;
    let patchPromise: Promise<void> | undefined;
    const session = { ...createEmptySession('s'), cwd: 'invincible' };
    const { result } = await runHarnessTurn(bridge, session, 'cd', {
      streamAgent: true,
      pushUser: false,
      onSessionPatch: (_s) => {
        // Simulate a slow persist — the test asserts the turn does not await it.
        patchPromise = new Promise<void>((r) => setTimeout(() => { patchResolved = true; r(); }, 100));
        // Intentionally not returned — the host must not await this.
      },
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'change_dir' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'change_dir',
          ok: true,
          summary: 'change_dir · ✓ ok · invincible/sub · cwd=invincible/sub',
          changeDirCwd: 'invincible/sub',
        });
        await init?.onEvent?.({ type: 'done', text: 'moved' });
        return { ok: true, text: 'moved' };
      },
    });
    expect(result.ok).toBe(true);
    // The turn returned WITHOUT waiting for the slow onSessionPatch.
    // It fires and is forgotten — status bar update is best-effort, not turn-gating.
    expect(patchResolved).toBe(false);
    // Let it drain so the test doesn't leak.
    await patchPromise;
    expect(patchResolved).toBe(true);
  });
});

describe('runHarnessTurn durable-turn fold (plan #811 / D17)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('success with a planted turnRunId folds completed + cursor 0 onto the session', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // JSON path (sendAgent injected) carrying a durable-turn run id.
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: true,
      text: 'PONG',
      turnRunId: 'run_1',
      turnWarning: 'note',
    }));
    const { result, session: next } = await runHarnessTurn(
      bridge,
      createEmptySession('s1'),
      'hi',
      { sendAgent },
    );
    expect(result.ok).toBe(true);
    expect(next.turnRunId).toBe('run_1');
    expect(next.turnStatus).toBe('completed');
    expect(next.turnStreamCursor).toBe(0);
  });

  it('failure with a planted turnRunId clears the id and marks the turn completed', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      error: 'boom',
      status: 422, // plan #759 — permanent (terminal); single attempt, no retry timers
      turnRunId: 'run_2',
    }));
    const { result, session: next } = await runHarnessTurn(
      bridge,
      createEmptySession('s1'),
      'hi',
      { sendAgent },
    );
    expect(result.ok).toBe(false);
    // The D17 failure fold clears the run id and marks the terminal turn
    // completed so a stale `running` never blocks the next C15 start.
    expect(sendAgent).toHaveBeenCalledTimes(1);
    expect(next.turnRunId).toBeUndefined();
    expect(next.turnStatus).toBe('completed');
  });

  it('409 live-lock (C15 double-send) is PERMANENT — single attempt, failure fold fires (adversarial #841 Minor L1)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    exp.__queue.push('op item');
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 409, // C15: run already open — never a transient quota blip
      error: 'run already open (C15 live-lock)',
      turnRunId: 'run_live',
    }));
    const { result, session: next } = await runHarnessTurn(
      bridge,
      createEmptySession('s1'),
      'hi',
      { sendAgent },
    );
    expect(result.ok).toBe(false);
    expect(sendAgent).toHaveBeenCalledTimes(1); // permanent → no 5× retry hammer
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
    expect(exp.__queue[0]).toBe(CONTINUE_TURN_PROMPT); // give-up (+ Continue, never drained)
    // Failure fold clears the stale open run so the next start is not blocked.
    expect(next.turnRunId).toBeUndefined();
    expect(next.turnStatus).toBe('completed');
  });

  it('production default stream path (sendTurnStream, no sendAgent injection) folds the run header', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // Production default: no sendAgent/sendAgentStream injected → streamAgent
    // true → sendTurnStream posts to /api/turns and parses durable fields.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('data: {"type":"text_delta","text":"Hi"}\n\n'));
        c.enqueue(enc.encode('data: {"type":"done","text":"Hi","toolTrace":[]}\n\n'));
        c.close();
      },
    });
    const fetchMock = vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'x-workflow-run-id': 'wr_0000_default',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result, session: next } = await runHarnessTurn(
      bridge,
      createEmptySession('s1'),
      'hi',
    );
    expect(result.ok).toBe(true);
    expect(next.turnRunId).toBe('wr_0000_default');
    expect(next.turnStatus).toBe('completed');
    expect(next.turnStreamCursor).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/turns',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Accept: 'text/event-stream' }),
      }),
    );
  });
});

describe('runHarnessTurn attach handshake (plan #813 / E19)', () => {
  function runningSession(
    messages: Array<[role: 'user' | 'assistant' | 'tool_run' | 'system' | 'skill_attached', text: string]> = [
      ['user', 'hello'],
    ],
    extra?: Partial<ReturnType<typeof createEmptySession>>,
  ) {
    let s = createEmptySession('s_attach_1');
    for (const [role, text] of messages) {
      s = appendMessage(s, role, text);
    }
    return {
      ...s,
      turnRunId: 'wr_live',
      turnStatus: 'running' as const,
      ...extra,
    };
  }

  type AttachInit = {
    sessionId: string;
    startIndex?: number;
    onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
    onTurnStarted?: (info: { turnRunId: string }) => void | Promise<void>;
  };

  it('test 2: hot resume at C grows the live assistant suffix, no duplicate, no ring clear', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.Assistant, 'Hello');
    const session = runningSession(
      [
        ['user', 'hello'],
        ['assistant', 'Hello'],
      ],
      { turnStreamCursor: 7 },
    );
    const startIndexes: number[] = [];
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 7,
        dedup: false,
        attachStream: async (runId, opts: AttachInit) => {
          startIndexes.push(opts.startIndex ?? 0);
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'text_delta', text: ' world' });
          await opts.onEvent?.({ type: 'done', text: 'Hello world' });
          return { ok: true, text: 'Hello world', turnRunId: runId };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(startIndexes).toEqual([7]);
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    expect(assistants.map((m) => m.text)).toEqual(['Hello world']);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.User).map((m) => m.text)).toEqual([
      'hello',
    ]);
    expect(next.messages.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual([
      'Hello world',
    ]);
  });

  it('test 2b: F5/boot of originating tab with envelope C>0 attaches at startIndex=0 + dedup, never C', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    const session = runningSession([['user', 'hello']], { turnStreamCursor: 4096 });
    const startIndexes: number[] = [];
    const { result } = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          startIndexes.push(opts.startIndex ?? 0);
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'reasoning_delta', text: 'hmm' });
          await opts.onEvent?.({ type: 'text_delta', text: 'Hi' });
          await opts.onEvent?.({ type: 'done', text: 'Hi' });
          return { ok: true, text: 'Hi', turnRunId: runId };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(startIndexes).toEqual([0]);
    expect(startIndexes).not.toContain(4096);
    expect(exp.__messages.some((m) => m.kind === MessageKind.Thinking && m.text === 'hmm')).toBe(
      true,
    );
    expect(exp.__messages.filter((m) => m.kind === MessageKind.Assistant).map((m) => m.text)).toEqual(
      ['Hi'],
    );
  });

  it('test 2c: cold attach with Blob tool+assistant suffix replays thinking BEFORE tools (adversarial #857)', async () => {
    const g = createToolRunGroup();
    addToolStart(g, 'exec');
    const payload = encodeToolRun(g)!;
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.ToolRun, payload);
    bridge.pushMessage(MessageKind.Assistant, 'Hello');
    const session = runningSession([
      ['user', 'hello'],
      ['tool_run', payload],
      ['assistant', 'Hello'],
    ]);
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'reasoning_delta', text: 'hmm' });
          await opts.onEvent?.({ type: 'tool_start', name: 'exec' });
          await opts.onEvent?.({
            type: 'tool_result',
            name: 'exec',
            ok: true,
            summary: 'ok',
          });
          await opts.onEvent?.({ type: 'text_delta', text: 'Hello' });
          await opts.onEvent?.({ type: 'text_delta', text: ' world' });
          await opts.onEvent?.({ type: 'done', text: 'Hello world' });
          return { ok: true, text: 'Hello world', turnRunId: runId };
        },
      },
    });
    expect(result.ok).toBe(true);
    const kinds = exp.__messages.map((m) => m.kind);
    const thinkAt = kinds.indexOf(MessageKind.Thinking);
    const toolAt = kinds.indexOf(MessageKind.ToolRun);
    const asstAt = kinds.lastIndexOf(MessageKind.Assistant);
    expect(thinkAt).toBeGreaterThanOrEqual(0);
    expect(toolAt).toBeGreaterThan(thinkAt);
    expect(asstAt).toBeGreaterThan(toolAt);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.ToolRun)).toHaveLength(1);
    expect(
      exp.__messages.filter((m) => m.kind === MessageKind.Assistant).map((m) => m.text),
    ).toEqual(['Hello world']);
    expect(next.messages.filter((m) => m.role === 'tool_run')).toHaveLength(1);
    expect(next.messages.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual([
      'Hello world',
    ]);
  });

  it('test 2d: Send-while-running follow-up user is stripped; thinking sits under the old prompt (adversarial #857)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.User, 'follow-up');
    const session = runningSession([['user', 'hello']]);
    const { result, session: next } = await runHarnessTurn(bridge, session, 'follow-up', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'reasoning_delta', text: 'hmm' });
          await opts.onEvent?.({ type: 'text_delta', text: 'Hi' });
          await opts.onEvent?.({ type: 'done', text: 'Hi' });
          return { ok: true, text: 'Hi', turnRunId: runId };
        },
      },
    });
    expect(result.ok).toBe(true);
    const users = exp.__messages.filter((m) => m.kind === MessageKind.User).map((m) => m.text);
    expect(users).toEqual(['hello']);
    expect(users).not.toContain('follow-up');
    const kinds = exp.__messages.map((m) => m.kind);
    const userAt = kinds.indexOf(MessageKind.User);
    const thinkAt = kinds.indexOf(MessageKind.Thinking);
    const asstAt = kinds.indexOf(MessageKind.Assistant);
    expect(userAt).toBeGreaterThanOrEqual(0);
    expect(thinkAt).toBeGreaterThan(userAt);
    expect(asstAt).toBeGreaterThan(thinkAt);
    expect(next.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['hello']);
    expect(next.messages.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual(['Hi']);
    expect(exp.__messages.map((m) => m.text)).not.toContain(ATTACH_FOLLOW_UP_NOTE);
  });

  it('test 2e: Send-while-running hot resume drops follow-up and grows the live assistant (adversarial #857)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.Assistant, 'Hello');
    bridge.pushMessage(MessageKind.User, 'follow-up');
    const session = runningSession(
      [
        ['user', 'hello'],
        ['assistant', 'Hello'],
      ],
      { turnStreamCursor: 7 },
    );
    const startIndexes: number[] = [];
    const { result, session: next } = await runHarnessTurn(bridge, session, 'follow-up', {
      attach: {
        runId: 'wr_live',
        startIndex: 7,
        dedup: false,
        attachStream: async (runId, opts: AttachInit) => {
          startIndexes.push(opts.startIndex ?? 0);
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'text_delta', text: ' world' });
          await opts.onEvent?.({ type: 'done', text: 'Hello world' });
          return { ok: true, text: 'Hello world', turnRunId: runId };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(startIndexes).toEqual([7]);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.User).map((m) => m.text)).toEqual([
      'hello',
    ]);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.Assistant).map((m) => m.text)).toEqual([
      'Hello world',
    ]);
    expect(next.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['hello']);
    expect(exp.__messages.map((m) => m.text)).not.toContain(ATTACH_FOLLOW_UP_NOTE);
  });

  it('test 2d-queue: Send-while-running cold keeps the submit FIFO (adversarial #857)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.User, 'follow-up');
    exp.__queue.push('queued A');
    exp.__queue.push('queued B');
    const session = runningSession([['user', 'hello']]);
    await runHarnessTurn(bridge, session, 'follow-up', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'text_delta', text: 'Hi' });
          await opts.onEvent?.({ type: 'done', text: 'Hi' });
          return { ok: true, text: 'Hi', turnRunId: runId };
        },
      },
    });
    expect(exp.__queue).toEqual(['queued A', 'queued B']);
    expect(exp.__promoteAllowed()).toBe(true); // success completeTurn re-arms
  });

  it('test 2e-queue: Send-while-running hot strip keeps the submit FIFO (adversarial #857)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.Assistant, 'Hello');
    bridge.pushMessage(MessageKind.User, 'follow-up');
    exp.__queue.push('queued A');
    const session = runningSession(
      [
        ['user', 'hello'],
        ['assistant', 'Hello'],
      ],
      { turnStreamCursor: 7 },
    );
    await runHarnessTurn(bridge, session, 'follow-up', {
      attach: {
        runId: 'wr_live',
        startIndex: 7,
        dedup: false,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'text_delta', text: ' world' });
          await opts.onEvent?.({ type: 'done', text: 'Hello world' });
          return { ok: true, text: 'Hello world', turnRunId: runId };
        },
      },
    });
    expect(exp.__queue).toEqual(['queued A']);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.User).map((m) => m.text)).toEqual([
      'hello',
    ]);
  });

  it('test 2h: F5 cold attach (empty prompt) still clears the submit FIFO', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    exp.__queue.push('stale from previous session');
    const session = runningSession([['user', 'hello']]);
    await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'text_delta', text: 'ok' });
          await opts.onEvent?.({ type: 'done', text: 'ok' });
          return { ok: true, text: 'ok', turnRunId: runId };
        },
      },
    });
    expect(exp.__queue).toEqual([]);
  });

  it('test 2i: Send-while-running 503 keeps FIFO and arms promote false', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.User, 'follow-up');
    exp.__queue.push('queued A');
    const session = runningSession([['user', 'hello']]);
    const { result, session: next } = await runHarnessTurn(bridge, session, 'follow-up', {
      attach: {
        runId: 'wr_1',
        startIndex: 0,
        dedup: true,
        attachStream: async () => ({
          ok: false as const,
          status: 503,
          error: 'Unable to attach to run stream (store unavailable).',
          turnRunId: 'wr_1',
        }),
      },
    });
    expect(result.ok).toBe(false);
    expect(exp.__queue).toEqual(['queued A']);
    expect(exp.__promoteAllowed()).toBe(false);
    expect(next.turnStatus).toBe('running');
    expect(exp.__messages.some((m) => isTurnEndLine(m.text))).toBe(false);
  });

  it('test 2f: thinking-only EOF after cold strip then hot resume does not restore Blob suffix (adversarial #857)', async () => {
    const g = createToolRunGroup();
    addToolStart(g, 'exec');
    const payload = encodeToolRun(g)!;
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.ToolRun, payload);
    bridge.pushMessage(MessageKind.Assistant, 'Hello');
    const session = runningSession([
      ['user', 'hello'],
      ['tool_run', payload],
      ['assistant', 'Hello'],
    ]);

    const first = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'reasoning_delta', text: 'hmm' });
          return { ok: true, text: '', turnRunId: runId };
        },
      },
    });
    expect(first.result.ok).toBe(false);
    expect(first.session.turnStatus).toBe('running');
    expect(first.session.turnStreamCursor).toBe(1);
    expect(first.session.messages.some((m) => m.role === 'tool_run')).toBe(false);
    expect(first.session.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual([
      'hello',
    ]);
    expect(exp.__messages.some((m) => m.kind === MessageKind.Thinking && m.text === 'hmm')).toBe(
      true,
    );
    expect(exp.__messages.some((m) => m.kind === MessageKind.ToolRun)).toBe(false);

    const second = await runHarnessTurn(bridge, first.session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: first.session.turnStreamCursor ?? 1,
        dedup: false,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'tool_start', name: 'exec' });
          await opts.onEvent?.({
            type: 'tool_result',
            name: 'exec',
            ok: true,
            summary: 'ok',
          });
          await opts.onEvent?.({ type: 'text_delta', text: 'Hello world' });
          await opts.onEvent?.({ type: 'done', text: 'Hello world' });
          return { ok: true, text: 'Hello world', turnRunId: runId };
        },
      },
    });
    expect(second.result.ok).toBe(true);
    const kinds = exp.__messages.map((m) => m.kind);
    const thinkAt = kinds.indexOf(MessageKind.Thinking);
    const toolAt = kinds.indexOf(MessageKind.ToolRun);
    const asstAt = kinds.lastIndexOf(MessageKind.Assistant);
    expect(thinkAt).toBeGreaterThanOrEqual(0);
    expect(toolAt).toBeGreaterThan(thinkAt);
    expect(asstAt).toBeGreaterThan(toolAt);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.ToolRun)).toHaveLength(1);
    expect(
      exp.__messages.filter((m) => m.kind === MessageKind.Assistant).map((m) => m.text),
    ).toEqual(['Hello world']);
    expect(second.session.messages.filter((m) => m.role === 'tool_run')).toHaveLength(1);
    expect(second.session.messages.filter((m) => m.role === 'assistant').map((m) => m.text)).toEqual([
      'Hello world',
    ]);
  });

  it('test 2g: cold attach uses pushSessionToBridge — image session bump, prior-turn media kept, consecutive tool_run coalesced (adversarial #857)', async () => {
    const g1 = createToolRunGroup();
    addToolStart(g1, 'read_file');
    addToolResult(g1, 'read_file', true, 'ok', undefined);
    const p1 = encodeToolRun(g1)!;
    const g2 = createToolRunGroup();
    addToolStart(g2, 'exec');
    addToolResult(g2, 'exec', true, 'ok', undefined);
    const p2 = encodeToolRun(g2)!;
    const priorAsst = 'see ![shot](https://example.com/a.png)';
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'first');
    bridge.pushMessage(MessageKind.ToolRun, p1);
    bridge.pushMessage(MessageKind.ToolRun, p2);
    bridge.pushMessage(MessageKind.Assistant, priorAsst);
    bridge.pushMessage(MessageKind.User, 'second');
    let session = createEmptySession('s_attach_img');
    session = appendMessage(session, 'user', 'first');
    session = appendMessage(session, 'tool_run', p1);
    session = appendMessage(session, 'tool_run', p2);
    session = appendMessage(session, 'assistant', priorAsst);
    session = appendMessage(session, 'user', 'second');
    session = { ...session, turnRunId: 'wr_live', turnStatus: 'running' };
    const gen = harnessImageSessionGeneration();
    const { result } = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'text_delta', text: 'ok' });
          await opts.onEvent?.({ type: 'done', text: 'ok' });
          return { ok: true, text: 'ok', turnRunId: runId };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(harnessImageSessionGeneration()).toBeGreaterThan(gen);
    expect(
      exp.__messages.some((m) => m.kind === MessageKind.Assistant && m.text === priorAsst),
    ).toBe(true);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.ToolRun)).toHaveLength(1);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.User).map((m) => m.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('test 2j: cold attach usage after streamPainted persists live next, not coldBackup (adversarial #857)', async () => {
    const g = createToolRunGroup();
    addToolStart(g, 'exec');
    const bootPayload = encodeToolRun(g)!;
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.ToolRun, bootPayload);
    bridge.pushMessage(MessageKind.Assistant, 'Hello');
    const session = runningSession([
      ['user', 'hello'],
      ['tool_run', bootPayload],
      ['assistant', 'Hello'],
    ]);
    const patches: Array<{
      assistant: string[];
      toolRun: number;
      usage?: unknown;
    }> = [];
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'reasoning_delta', text: 'hmm' });
          await opts.onEvent?.({ type: 'tool_start', name: 'exec' });
          await opts.onEvent?.({
            type: 'usage',
            usage: { source: 'provider', prompt: 1, completion: 2, total: 3 },
          });
          return { ok: true, text: '', turnRunId: runId };
        },
      },
      onSessionPatch: (s) => {
        patches.push({
          assistant: s.messages.filter((m) => m.role === 'assistant').map((m) => m.text),
          toolRun: s.messages.filter((m) => m.role === 'tool_run').length,
          usage: s.usage,
        });
      },
    });
    expect(result.ok).toBe(false);
    expect(next.turnStatus).toBe('running');
    const started = patches[0];
    expect(started?.assistant).toEqual(['Hello']);
    expect(started?.toolRun).toBe(1);
    const usagePatch = patches.find((p) => p.usage != null);
    expect(usagePatch).toBeTruthy();
    expect(usagePatch!.assistant).toEqual([]);
    expect(usagePatch!.toolRun).toBe(1);
    expect(next.messages.some((m) => m.role === 'assistant' && m.text === 'Hello')).toBe(false);
  });

  it('test 3: two cold consumers both render thinking + text once from startIndex=0 + dedup', async () => {
    const events: AgentStreamEvent[] = [
      { type: 'reasoning_delta', text: 'plan' },
      { type: 'text_delta', text: 'Answer' },
      { type: 'done', text: 'Answer' },
    ];
    async function oneTab() {
      const exp = makeMockExports();
      const bridge = new HarnessBridge(exp);
      bridge.pushMessage(MessageKind.User, 'hello');
      const session = runningSession([['user', 'hello']]);
      const { result } = await runHarnessTurn(bridge, session, '', {
        attach: {
          runId: 'wr_live',
          startIndex: 0,
          dedup: true,
          attachStream: async (runId, opts: AttachInit) => {
            await opts.onTurnStarted?.({ turnRunId: runId });
            for (const ev of events) await opts.onEvent?.(ev);
            return { ok: true, text: 'Answer', turnRunId: runId };
          },
        },
      });
      return { result, exp };
    }
    const a = await oneTab();
    const b = await oneTab();
    expect(a.result.ok).toBe(true);
    expect(b.result.ok).toBe(true);
    for (const tab of [a, b]) {
      expect(tab.exp.__messages.some((m) => m.kind === MessageKind.Thinking && m.text === 'plan')).toBe(
        true,
      );
      expect(
        tab.exp.__messages.filter((m) => m.kind === MessageKind.Assistant).map((m) => m.text),
      ).toEqual(['Answer']);
    }
  });

  it('test 4: poison/absent C while running still GET-attaches at 0 (not hydrate-only)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    const session = runningSession([['user', 'hello']]);
    delete session.turnStreamCursor;
    const called: number[] = [];
    await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          called.push(opts.startIndex ?? 0);
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'text_delta', text: 'ok' });
          await opts.onEvent?.({ type: 'done', text: 'ok' });
          return { ok: true, text: 'ok', turnRunId: runId };
        },
      },
    });
    expect(called).toEqual([0]);
  });

  it('test 5: attach to a completed producer replays at 0 + dedup, no cancel, not left Busy', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const end = describeTurnEnd('model');
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.Assistant, 'Hi');
    bridge.pushMessage(MessageKind.System, end);
    const session = runningSession(
      [
        ['user', 'hello'],
        ['assistant', 'Hi'],
        ['system', end],
      ],
      { turnStatus: 'completed', turnRunId: 'wr_done', turnStreamCursor: 0 },
    );
    const sendAgent = vi.fn(async () => {
      throw new Error('must not cancel / POST');
    });
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      sendAgent,
      attach: {
        runId: 'wr_done',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'text_delta', text: 'Hi' });
          await opts.onEvent?.({ type: 'done', text: 'Hi' });
          return { ok: true, text: 'Hi', turnRunId: runId };
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(sendAgent).not.toHaveBeenCalled();
    expect(next.turnStatus).toBe('completed');
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.Assistant).map((m) => m.text)).toEqual(
      ['Hi'],
    );
    expect(exp.__messages.filter((m) => m.text === end)).toHaveLength(1);
  });

  it('test 6: 404 attach paints EMBER and never calls /api/agent', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = runningSession();
    const sendAgent = vi.fn(async () => {
      throw new Error('sendAgent /api/agent');
    });
    const sendAgentStream = vi.fn(async () => {
      throw new Error('sendAgentStream /api/agent');
    });
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).not.toMatch(/\/api\/agent/);
      return new Response('nope', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { result, session: next } = await runHarnessTurn(bridge, session, '', {
        sendAgent,
        sendAgentStream,
        attach: {
          runId: 'wr_gone',
          startIndex: 0,
          dedup: true,
          attachStream: async () => ({
            ok: false as const,
            status: 404,
            error: 'Run not found: wr_gone',
            turnRunId: 'wr_gone',
          }),
        },
      });
      expect(result.ok).toBe(false);
      expect(sendAgent).not.toHaveBeenCalled();
      expect(sendAgentStream).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.every((c) => !String(c[0]).includes('/api/agent')),
      ).toBe(true);
      expect(exp.__messages.some((m) => m.kind === MessageKind.Error && /Run not found/.test(m.text))).toBe(
        true,
      );
      expect(
        exp.__messages.some((m) => m.kind === MessageKind.Error && isTurnEndLine(m.text)),
      ).toBe(true);
      expect(exp.__lifecycle()).toBe(Lifecycle.Error);
      // Attach 404 is run-gone: clear so a later Send is not C15-409'd.
      expect(next.turnStatus).toBe('completed');
      expect(next.turnRunId).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('test 6b: 503 attach paints EMBER and never calls /api/agent', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = runningSession();
    const sendAgent = vi.fn(async () => {
      throw new Error('sendAgent /api/agent');
    });
    const sendAgentStream = vi.fn(async () => {
      throw new Error('sendAgentStream /api/agent');
    });
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      sendAgent,
      sendAgentStream,
      attach: {
        runId: 'wr_1',
        startIndex: 0,
        dedup: true,
        attachStream: async () => ({
          ok: false as const,
          status: 503,
          error: 'Unable to attach to run stream (store unavailable).',
          turnRunId: 'wr_1',
        }),
      },
    });
    expect(result.ok).toBe(false);
    expect(sendAgent).not.toHaveBeenCalled();
    expect(sendAgentStream).not.toHaveBeenCalled();
    expect(
      exp.__messages.some(
        (m) => m.kind === MessageKind.Error && /store unavailable/.test(m.text),
      ),
    ).toBe(true);
    expect(
      exp.__messages.some((m) => isTurnEndLine(m.text)),
    ).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(next.turnStatus).toBe('running');
    expect(next.turnRunId).toBe('wr_1');
  });

  it('test 6e: 503 after Blob this-run suffix restores the suffix (no user-only persist)', async () => {
    const g = createToolRunGroup();
    addToolStart(g, 'exec');
    const payload = encodeToolRun(g)!;
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.ToolRun, payload);
    const session = runningSession([
      ['user', 'hello'],
      ['tool_run', payload],
    ]);
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_1',
        startIndex: 0,
        dedup: true,
        attachStream: async () => ({
          ok: false as const,
          status: 503,
          error: 'Unable to attach to run stream (store unavailable).',
          turnRunId: 'wr_1',
        }),
      },
    });
    expect(result.ok).toBe(false);
    expect(next.messages.some((m) => m.role === 'tool_run')).toBe(true);
    expect(exp.__messages.some((m) => m.kind === MessageKind.ToolRun)).toBe(true);
    expect(
      exp.__messages.some(
        (m) => m.kind === MessageKind.Error && /store unavailable/.test(m.text),
      ),
    ).toBe(true);
    expect(exp.__messages.some((m) => isTurnEndLine(m.text))).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(next.turnStatus).toBe('running');
  });

  it('test 6c: network attach fail is subscribe-fail — EMBER, Ready, keep running, no Turn ended', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = runningSession();
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_1',
        startIndex: 0,
        dedup: true,
        attachStream: async () => ({
          ok: false as const,
          error: 'Network request failed.',
          turnRunId: 'wr_1',
        }),
      },
    });
    expect(result.ok).toBe(false);
    expect(
      exp.__messages.some(
        (m) => m.kind === MessageKind.Error && /Network request failed/.test(m.text),
      ),
    ).toBe(true);
    expect(exp.__messages.some((m) => isTurnEndLine(m.text))).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(next.turnStatus).toBe('running');
    expect(next.turnRunId).toBe('wr_1');
  });

  it('test 6d: 401 attach is subscribe-fail — EMBER, Ready, keep running, no Turn ended', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = runningSession();
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_1',
        startIndex: 0,
        dedup: true,
        attachStream: async () => ({
          ok: false as const,
          status: 401,
          error: AUTH_REQUIRED_ERROR,
          turnRunId: 'wr_1',
        }),
      },
    });
    expect(result.ok).toBe(false);
    expect(
      exp.__messages.some(
        (m) => m.kind === MessageKind.Error && m.text.includes(AUTH_REQUIRED_ERROR),
      ),
    ).toBe(true);
    expect(exp.__messages.some((m) => isTurnEndLine(m.text))).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(next.turnStatus).toBe('running');
    expect(next.turnRunId).toBe('wr_1');
  });

  it('test 6f: second attach 503 replaces the last subscribe-fail error (no stack)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = runningSession();
    const first = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_1',
        startIndex: 0,
        dedup: true,
        attachStream: async () => ({
          ok: false as const,
          status: 503,
          error: 'Unable to attach to run stream (store unavailable).',
          turnRunId: 'wr_1',
        }),
      },
    });
    expect(first.session.messages.filter((m) => m.role === 'error')).toHaveLength(1);
    const second = await runHarnessTurn(bridge, first.session, '', {
      attach: {
        runId: 'wr_1',
        startIndex: 0,
        dedup: true,
        attachStream: async () => ({
          ok: false as const,
          status: 503,
          error: 'Unable to attach to run stream (retry).',
          turnRunId: 'wr_1',
        }),
      },
    });
    const errors = second.session.messages.filter((m) => m.role === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.text).toMatch(/retry/);
    expect(
      exp.__messages.filter((m) => m.kind === MessageKind.Error && !isTurnEndLine(m.text)),
    ).toHaveLength(1);
    expect(second.session.turnStatus).toBe('running');
  });

  it('test 6g: onTurnStarted + SSE error is give-up, not subscribe-fail (adversarial #857)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = runningSession();
    const sendAgent = vi.fn(async () => {
      throw new Error('must not POST /api/agent');
    });
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      sendAgent,
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({
            type: 'error',
            error: 'producer failed',
            status: 502,
          });
          return {
            ok: false as const,
            error: 'producer failed',
            status: 502,
            turnRunId: runId,
          };
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(sendAgent).not.toHaveBeenCalled();
    expect(next.turnRunId).toBeUndefined();
    expect(next.turnStatus).toBe('completed');
    expect(
      next.messages.some(
        (m) => m.role === 'error' && m.text.startsWith('Turn ended · error'),
      ),
    ).toBe(true);
    expect(next.messages.some((m) => m.role === 'system' && /detached/.test(m.text))).toBe(
      false,
    );
    expect(exp.__lifecycle()).toBe(Lifecycle.Error);
    expect(exp.__messages.some((m) => isTurnEndLine(m.text))).toBe(true);
  });

  it('test 6h: 502 without onTurnStarted stays subscribe-fail (discriminator)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = runningSession();
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_1',
        startIndex: 0,
        dedup: true,
        attachStream: async () => ({
          ok: false as const,
          status: 502,
          error: 'Bad gateway',
          turnRunId: 'wr_1',
        }),
      },
    });
    expect(result.ok).toBe(false);
    expect(next.turnStatus).toBe('running');
    expect(next.turnRunId).toBe('wr_1');
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(exp.__messages.some((m) => isTurnEndLine(m.text))).toBe(false);
    expect(
      exp.__messages.some((m) => m.kind === MessageKind.Error && /Bad gateway/.test(m.text)),
    ).toBe(true);
  });

  it('test 6i: attach Stop after onTurnStarted keeps running, no you-stopped (adversarial #857)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = runningSession();
    const sendAgent = vi.fn(async () => {
      throw new Error('must not POST /api/agent');
    });
    const controller = new AbortController();
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      sendAgent,
      signal: controller.signal,
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'reasoning_delta', text: 'hmm' });
          controller.abort();
          return { ok: false as const, error: 'Request cancelled.', turnRunId: runId };
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(sendAgent).not.toHaveBeenCalled();
    expect(next.turnRunId).toBe('wr_live');
    expect(next.turnStatus).toBe('running');
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(false);
    expect(exp.__messages.some((m) => isTurnEndLine(m.text))).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(exp.__messages.some((m) => m.kind === MessageKind.Thinking && m.text === 'hmm')).toBe(
      true,
    );
  });

  it('test 6j: attach Stop before onTurnStarted keeps running, no subscribe-fail EMBER (adversarial #857)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = runningSession();
    const controller = new AbortController();
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      signal: controller.signal,
      attach: {
        runId: 'wr_1',
        startIndex: 0,
        dedup: true,
        attachStream: async () => {
          controller.abort();
          return { ok: false as const, error: 'Request cancelled.', turnRunId: 'wr_1' };
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(next.turnStatus).toBe('running');
    expect(next.turnRunId).toBe('wr_1');
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(exp.__messages.some((m) => isTurnEndLine(m.text))).toBe(false);
    expect(
      exp.__messages.some((m) => m.kind === MessageKind.Error),
    ).toBe(false);
  });

  it('test 6k: Send-while-running attach Stop keeps running, strips follow-up, no still-attached note (adversarial #857)', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.User, 'follow-up');
    const session = runningSession([['user', 'hello']]);
    const sendAgent = vi.fn(async () => {
      throw new Error('must not POST /api/agent');
    });
    const controller = new AbortController();
    const { result, session: next } = await runHarnessTurn(bridge, session, 'follow-up', {
      sendAgent,
      signal: controller.signal,
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'reasoning_delta', text: 'hmm' });
          controller.abort();
          return { ok: false as const, error: 'Request cancelled.', turnRunId: runId };
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(sendAgent).not.toHaveBeenCalled();
    expect(next.turnRunId).toBe('wr_live');
    expect(next.turnStatus).toBe('running');
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(false);
    expect(exp.__messages.some((m) => isTurnEndLine(m.text))).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(exp.__messages.filter((m) => m.kind === MessageKind.User).map((m) => m.text)).toEqual([
      'hello',
    ]);
    expect(exp.__messages.map((m) => m.text)).not.toContain(ATTACH_FOLLOW_UP_NOTE);
    expect(exp.__messages.map((m) => m.text)).not.toContain(ATTACH_FOLLOW_UP_DETACH_NOTE);
    expect(exp.__messages.some((m) => m.kind === MessageKind.Thinking && m.text === 'hmm')).toBe(
      true,
    );
  });

  it('test 7: dedup skips hydrated this-run assistant/tool_run, never skips reasoning, prior-turn assistant is not a skip target', async () => {
    const g = createToolRunGroup();
    addToolStart(g, 'read_file');
    addToolResult(g, 'read_file', true, 'ok', undefined);
    const payload = encodeToolRun(g)!;

    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'hello');
    bridge.pushMessage(MessageKind.ToolRun, payload);
    bridge.pushMessage(MessageKind.Assistant, 'Hello');
    const session = runningSession([
      ['user', 'hello'],
      ['tool_run', payload],
      ['assistant', 'Hello'],
    ]);
    await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'tool_start', name: 'read_file' });
          await opts.onEvent?.({
            type: 'tool_result',
            name: 'read_file',
            ok: true,
            summary: 'ok',
          });
          await opts.onEvent?.({ type: 'reasoning_delta', text: 'think' });
          await opts.onEvent?.({ type: 'text_delta', text: 'Hello' });
          await opts.onEvent?.({ type: 'text_delta', text: ' world' });
          await opts.onEvent?.({ type: 'done', text: 'Hello world' });
          return { ok: true, text: 'Hello world', turnRunId: runId };
        },
      },
    });
    expect(exp.__messages.filter((m) => m.kind === MessageKind.ToolRun)).toHaveLength(1);
    expect(
      exp.__messages
        .filter((m) => m.kind === MessageKind.Assistant)
        .map((m) => m.text)
        .join(''),
    ).toBe('Hello world');
    expect(exp.__messages.some((m) => m.kind === MessageKind.Thinking && m.text === 'think')).toBe(
      true,
    );

    const exp2 = makeMockExports();
    const bridge2 = new HarnessBridge(exp2);
    bridge2.pushMessage(MessageKind.User, 'first');
    bridge2.pushMessage(MessageKind.Assistant, 'OLD');
    bridge2.pushMessage(MessageKind.User, 'second');
    let s2 = createEmptySession('s_attach_2');
    s2 = appendMessage(s2, 'user', 'first');
    s2 = appendMessage(s2, 'assistant', 'OLD');
    s2 = appendMessage(s2, 'user', 'second');
    s2 = { ...s2, turnRunId: 'wr_live', turnStatus: 'running' };
    await runHarnessTurn(bridge2, s2, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'text_delta', text: 'NEW' });
          await opts.onEvent?.({ type: 'done', text: 'NEW' });
          return { ok: true, text: 'NEW', turnRunId: runId };
        },
      },
    });
    expect(
      exp2.__messages.filter((m) => m.kind === MessageKind.Assistant).map((m) => m.text),
    ).toEqual(['OLD', 'NEW']);
  });

  it('test 8: attach EOF without done/error is detach, keep running, no Turn ended', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const session = runningSession();
    const { result, session: next } = await runHarnessTurn(bridge, session, '', {
      attach: {
        runId: 'wr_live',
        startIndex: 0,
        dedup: true,
        attachStream: async (runId, opts: AttachInit) => {
          await opts.onTurnStarted?.({ turnRunId: runId });
          await opts.onEvent?.({ type: 'text_delta', text: 'partial' });
          return { ok: true, text: 'partial', turnRunId: runId };
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(next.turnRunId).toBe('wr_live');
    expect(next.turnStatus).toBe('running');
    expect(next.turnStreamCursor).toBe(1);
    expect(next.messages.some((m) => m.role === 'system' && isTurnEndLine(m.text))).toBe(false);
    expect(next.messages.some((m) => m.role === 'error' && isTurnEndLine(m.text))).toBe(false);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
  });

  it('test 9: POST D17 path advances C on each SSE frame; persistTurn sees C; complete zeros it', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const cursors: Array<number | undefined> = [];
    const { session: next } = await runHarnessTurn(bridge, createEmptySession('s1'), 'hi', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onTurnStarted?.({ turnRunId: 'wr_post' });
        await init?.onEvent?.({ type: 'text_delta', text: 'He' });
        await init?.onEvent?.({ type: 'text_delta', text: 'llo' });
        await init?.onEvent?.({
          type: 'usage',
          usage: { source: 'provider', prompt: 1, completion: 2 },
        });
        await init?.onEvent?.({ type: 'done', text: 'Hello' });
        return { ok: true, text: 'Hello', turnRunId: 'wr_post' };
      },
      onSessionPatch: (s) => {
        cursors.push(s.turnStreamCursor);
      },
    });
    expect(cursors.some((c) => typeof c === 'number' && c > 0)).toBe(true);
    expect(cursors).toContain(3); // 2 text_delta + usage, patched on usage
    expect(next.turnStreamCursor).toBe(0);
    expect(next.turnStatus).toBe('completed');
  });
});
