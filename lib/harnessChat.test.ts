import { describe, expect, it, vi } from 'vitest';
import {
  HARNESS_SMOKE_PROMPT,
  collapseThinkingDisplay,
  classifyTurnFailure,
  describeTurnEnd,
  isTurnEndLine,
  pushSessionToBridge,
  runHarnessChat,
  runHarnessTurn,
  selectToolTraceLines,
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

describe('HARNESS_SMOKE_PROMPT', () => {
  it('asks for exact PONG', () => {
    expect(HARNESS_SMOKE_PROMPT).toMatch(/PONG/);
  });
});

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

  it('pushes system toolTrace then assistant on agent success', async () => {
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

    expect(next.messages.map((m) => m.role)).toEqual([
      'user',
      'system',
      'system',
      'assistant',
      'system',
    ]);
    expect(next.messages.at(-1)!.text).toBe(describeTurnEnd('model'));
    expect(exp.__messages.map((m) => m.kind)).toEqual([
      MessageKind.System,
      MessageKind.System,
      MessageKind.Assistant,
      MessageKind.System,
    ]);
    expect(exp.__messages[0]?.text).toContain('write_file');
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

  it('keeps all toolTrace system lines (no host line-count cap)', async () => {
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

    const systems = next.messages.filter((m) => m.role === 'system');
    expect(systems.filter((m) => !isTurnEndLine(m.text))).toHaveLength(n);
    expect(systems.some((m) => isTurnEndLine(m.text))).toBe(true);
    expect(
      exp.__messages.filter((m) => m.kind === MessageKind.System && !isTurnEndLine(m.text)),
    ).toHaveLength(n);
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
  it('pushes system tool lines before done and grows one assistant bubble', async () => {
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
    const texts = exp.__messages.map((m) => m.text);
    const kinds = exp.__messages.map((m) => m.kind);
    // user may be pushed
    expect(texts.some((t) => t.includes('list_dir · running'))).toBe(true);
    expect(texts.some((t) => t.includes('list_dir · ok'))).toBe(true);
    // single assistant bubble with full text
    const assistants = exp.__messages.filter((m) => m.kind === MessageKind.Assistant);
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.text).toBe('Here you go');
    expect(kinds.filter((k) => k === MessageKind.Assistant)).toHaveLength(1);
    expect(texts.some((t) => t === describeTurnEnd('model'))).toBe(true);
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
    expect(next.messages.some((m) => m.role === 'system' && m.text.includes('read_file'))).toBe(
      true,
    );
    expect(next.messages.some((m) => m.role === 'assistant' && m.text.includes('I read a.ts'))).toBe(
      true,
    );
    expect(
      next.messages.some(
        (m) => m.role === 'system' && m.text === describeTurnEnd('stop'),
      ),
    ).toBe(true);
    const folded = formatPromptWithHistory(next.messages, 'continue');
    expect(folded).toContain('Tool: read_file');
    expect(folded).toContain('I read a.ts');
    // Turn-end markers must not pollute tool history
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
    expect(exp.__messages.some((m) => m.text.includes('list_dir · running'))).toBe(true);
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

