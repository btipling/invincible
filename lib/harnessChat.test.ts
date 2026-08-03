import { describe, expect, it, vi } from 'vitest';
import {
  HARNESS_SMOKE_PROMPT,
  runHarnessChat,
  runHarnessTurn,
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
import { createEmptySession } from './sessionStore';

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
    __messages: messages,
    __lifecycle: () => lifecycle,
  };
}

describe('HARNESS_SMOKE_PROMPT', () => {
  it('asks for exact PONG', () => {
    expect(HARNESS_SMOKE_PROMPT).toMatch(/PONG/);
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
  it('appends user + assistant to session', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (): Promise<ChatResult> => ({ ok: true, text: 'PONG' }));
    const session = createEmptySession('s1');

    const { result, session: next } = await runHarnessTurn(bridge, session, 'hi', { send });

    expect(result.ok).toBe(true);
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(next.messages[1]?.text).toBe('PONG');
  });

  it('appends error role on failure', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (): Promise<ChatResult> => ({
      ok: false,
      error: 'down',
    }));

    const { session: next } = await runHarnessTurn(bridge, createEmptySession(), 'x', { send });
    expect(next.messages.map((m) => m.role)).toEqual(['user', 'error']);
  });

  it('pushUser:false does not double-paint user on bridge', async () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    const send = vi.fn(async (): Promise<ChatResult> => ({
      ok: true,
      text: 'PONG',
    }));

    await runHarnessTurn(bridge, createEmptySession(), 'hello', {
      send,
      pushUser: false,
    });

    const userPushes = exp.__messages.filter((m) => m.kind === MessageKind.User);
    expect(userPushes).toHaveLength(0);
    expect(exp.__messages.some((m) => m.kind === MessageKind.Assistant)).toBe(true);
  });

});
