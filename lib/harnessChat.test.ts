import { describe, expect, it, vi } from 'vitest';
import {
  HARNESS_SMOKE_PROMPT,
  runHarnessChat,
  runHarnessTurn,
  selectToolTraceLines,
  TOOL_TRACE_MAX_LINES,
  truncateToolTraceSummary,
} from './harnessChat';
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
import { createEmptySession, formatPromptWithHistory, appendMessage } from './sessionStore';
import { TOOL_TRACE_SUMMARY_MAX_CHARS } from './sandbox/config';

function makeMockExports(): HarnessBridgeExports & {
  __messages: { kind: number; text: string }[];
  __lifecycle: () => Lifecycle;
} {
  let buf = new ArrayBuffer(64 * 1024);
  const memory = {
    get buffer() {
      return buf;
    },
  };
  let nextPtr = 1024;
  let lifecycle = Lifecycle.Boot;
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
  };
}

describe('HARNESS_SMOKE_PROMPT', () => {
  it('asks for exact PONG', () => {
    expect(HARNESS_SMOKE_PROMPT).toMatch(/PONG/);
  });
});

describe('toolTrace host caps', () => {
  it('truncates summaries and caps line count', () => {
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
    expect(lines.length).toBeLessThanOrEqual(TOOL_TRACE_MAX_LINES);
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
      { kind: MessageKind.Error, text: 'AI_GATEWAY_API_KEY is not configured.' },
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
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
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
    ]);
    expect(exp.__messages.map((m) => m.kind)).toEqual([
      MessageKind.System,
      MessageKind.System,
      MessageKind.Assistant,
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
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
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

  it('caps toolTrace to 6 system lines', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const toolTrace = Array.from({ length: 10 }, (_, i) => ({
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
    expect(systems).toHaveLength(TOOL_TRACE_MAX_LINES);
    expect(
      exp.__messages.filter((m) => m.kind === MessageKind.System),
    ).toHaveLength(TOOL_TRACE_MAX_LINES);
  });

  it('history fold ignores system tool lines', async () => {
    let session = createEmptySession();
    session = appendMessage(session, 'user', 'first');
    session = appendMessage(session, 'system', 'write_file a ok');
    session = appendMessage(session, 'assistant', 'done');

    const folded = formatPromptWithHistory(session.messages, 'second');
    expect(folded).not.toContain('write_file');
    expect(folded).toContain('User: first');
    expect(folded).toContain('Assistant: done');
    expect(folded).toContain('User: second');

    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const sendAgent = vi.fn(async (prompt: string): Promise<AgentResult> => {
      expect(prompt).not.toContain('write_file');
      return { ok: true, text: 'ok2' };
    });

    await runHarnessTurn(bridge, session, 'second', {
      sendAgent,
      pushUser: false,
    });
    expect(sendAgent).toHaveBeenCalled();
  });

  it('appends error role on failure', async () => {
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
