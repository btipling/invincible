import { describe, expect, it, vi } from 'vitest';
import {
  coalesceToolRunMessages,
  collapseThinkingDisplay,
  classifyTurnFailure,
  describeTurnEnd,
  isTurnEndLine,
  pushSessionToBridge,
  runHarnessChat,
  restoreLastUiKind,
  runHarnessTurn,
  selectToolTraceLines,
  shouldContinueStreak,
  truncateToolTraceSummary,
} from './harnessChat';
import { HARNESS_RING_MAX } from './sessionWindow';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessBridge,
  INV_PING_XOR,
  Lifecycle,
  MessageKind,
  type HarnessBridgeExports,
} from './harnessBridge';
import type { ChatResult } from './chatApi';
import type { AgentResult } from './agentApi';
import {
  TOOL_RUN_ITEMS_MAX,
  addToolResult,
  addToolStart,
  buildTraceGroups,
  createToolRunGroup,
  decodeToolRun,
  encodeToolRun,
} from './toolRun';
import { SANDBOX_NOT_CONFIGURED_ERROR } from './agentApi';
import { AUTH_REQUIRED_ERROR, SANDBOX_FORBIDDEN_ERROR } from './tenancy/errors';
import { createEmptySession, formatPromptWithHistory, appendMessage, makeMessage } from './sessionStore';
import { TOOL_TRACE_SUMMARY_MAX_CHARS } from './sandbox/config';

function makeMockExports(): HarnessBridgeExports & {
  __messages: { kind: number; text: string }[];
  __lifecycle: () => Lifecycle;
  __canLoadEarlier: () => number;
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
  const messages: { kind: number; text: string }[] = [];

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
    },
    inv_echo: () => 0,
    inv_echo_len: () => 0,
    inv_echo_copy: () => 0,
    inv_has_pending_submit: () => 0,
    inv_pending_submit_len: () => 0,
    inv_pending_submit_copy: () => 0,
    inv_ack_pending_submit: () => {},
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
    inv_image_cache_put: () => 0,
    inv_image_cache_clear: () => {},
    inv_math_cache_put: () => 0,
    inv_math_cache_clear: () => {},
    __messages: messages,
    __lifecycle: () => lifecycle,
    __canLoadEarlier: () => canLoadEarlier,
  };
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

  it('pushes ember error message and stays ready for retry', async () => {
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
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
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

  it('503 exact sandbox-not-configured falls back to chat once', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 503,
      error: SANDBOX_NOT_CONFIGURED_ERROR,
      sandboxNotConfigured: true,
    }));
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'PONG' }));

    const { result, session: next } = await runHarnessTurn(
      bridge,
      createEmptySession(),
      'hi',
      { sendAgent, send, pushUser: false },
    );

    expect(sendAgent).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true, text: 'PONG' });
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'system']);
    expect(next.messages.at(-1)!.text).toBe(describeTurnEnd('chat'));
    expect(exp.__messages.some((m) => m.kind === MessageKind.Assistant)).toBe(true);
  });

  it('agent 500 does not call chat', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 500,
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

  it('503 with non-exact body does not call chat', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // status 503 alone is not enough — sandboxNotConfigured must be set by sendAgent
    // only on the exact SANDBOX_NOT_CONFIGURED_ERROR string.
    const sendAgent = vi.fn(async (): Promise<AgentResult> => ({
      ok: false,
      status: 503,
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
    expect(result).toMatchObject({ error: 'Upstream overloaded', status: 503 });
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
      status: 500,
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


  it('does not send cwd when session has none', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (_p: string, init?: { cwd?: string }) => {
      expect(init?.cwd).toBeUndefined();
      return { ok: true as const, text: 'ok', cwd: '.' };
    });
    const { session: next } = await runHarnessTurn(
      bridge,
      createEmptySession('s'),
      'hi',
      { sendAgent, pushUser: false, streamAgent: false },
    );
    expect(next.cwd).toBe('.');
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
