import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessBridge,
  INV_PING_XOR,
  Lifecycle,
  MessageKind,
  isHarnessBridgeExports,
  lifecycleName,
  messageKindLabel,
  type HarnessBridgeExports,
} from './harnessBridge';

type MockExtras = {
  __messages: { kind: number; text: string }[];
  __setPending: (s: string | null) => void;
  __lifecycle: () => Lifecycle;
};

function makeMockExports(overrides?: Partial<HarnessBridgeExports>): HarnessBridgeExports & MockExtras {
  let buf = new ArrayBuffer(64 * 1024);
  const memory = {
    get buffer() {
      return buf;
    },
  };

  let nextPtr = 1024;
  let lifecycle = Lifecycle.Boot;
  const messages: { kind: number; text: string }[] = [];
  let echo = '';
  let pending: string | null = null;

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

  const gpa_free = (_ptr: number, _len: number) => {
    /* no-op for mock */
  };

  const read = (ptr: number, len: number) =>
    new TextDecoder().decode(new Uint8Array(buf, ptr, len));

  const write = (ptr: number, text: string) => {
    const bytes = new TextEncoder().encode(text);
    new Uint8Array(buf, ptr, bytes.length).set(bytes);
  };

  const base: HarnessBridgeExports & MockExtras = {
    memory,
    gpa_u8,
    gpa_free,
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
    inv_echo: (ptr: number, len: number) => {
      echo = len === 0 ? '' : read(ptr, len);
      return echo.length;
    },
    inv_echo_len: () => echo.length,
    inv_echo_copy: (outPtr: number, maxLen: number) => {
      const n = Math.min(maxLen, echo.length);
      if (n > 0) write(outPtr, echo.slice(0, n));
      return n;
    },
    inv_has_pending_submit: () => (pending != null ? 1 : 0),
    inv_pending_submit_len: () => (pending != null ? pending.length : 0),
    inv_pending_submit_copy: (outPtr: number, maxLen: number) => {
      if (pending == null) return 0;
      const n = Math.min(maxLen, pending.length);
      if (n > 0) write(outPtr, pending.slice(0, n));
      return n;
    },
    inv_ack_pending_submit: () => {
      pending = null;
    },
    __messages: messages,
    __setPending: (s) => {
      pending = s;
    },
    __lifecycle: () => lifecycle,
  };

  return { ...base, ...overrides, __messages: messages, __setPending: base.__setPending, __lifecycle: base.__lifecycle };
}

describe('lifecycleName / messageKindLabel', () => {
  it('maps enums', () => {
    expect(lifecycleName(Lifecycle.Ready)).toBe('ready');
    expect(messageKindLabel(MessageKind.User)).toBe('user');
    expect(messageKindLabel(MessageKind.Error)).toBe('error');
  });
});

describe('isHarnessBridgeExports', () => {
  it('accepts full mock', () => {
    const exp = makeMockExports() as unknown as WebAssembly.Exports;
    expect(isHarnessBridgeExports(exp)).toBe(true);
  });

  it('rejects missing inv_ping', () => {
    const exp = makeMockExports() as unknown as Record<string, unknown>;
    delete exp.inv_ping;
    expect(isHarnessBridgeExports(exp as WebAssembly.Exports)).toBe(false);
  });
});

describe('HarnessBridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fromInstance succeeds with mock exports', () => {
    const exports = makeMockExports();
    const instance = { exports } as unknown as WebAssembly.Instance;
    const result = HarnessBridge.fromInstance(instance);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bridge.protocolVersion()).toBe(HARNESS_PROTOCOL_VERSION);
    }
  });

  it('fromInstance reports missing exports', () => {
    const exports = { memory: new WebAssembly.Memory({ initial: 1 }) } as unknown as WebAssembly.Exports;
    const result = HarnessBridge.fromInstance({ exports } as WebAssembly.Instance);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain('inv_ping');
      expect(result.error).toMatch(/missing bridge exports/i);
    }
  });

  it('ping XOR round-trip', () => {
    const bridge = new HarnessBridge(makeMockExports());
    expect(bridge.ping(0x1234)).toBe(0x1234 ^ INV_PING_XOR);
  });

  it('echo string round-trip JS→Wasm→JS', () => {
    const bridge = new HarnessBridge(makeMockExports());
    expect(bridge.echo('hello-bridge')).toBe('hello-bridge');
    expect(bridge.echo('')).toBe('');
  });

  it('assertRoundTrip passes on mock', () => {
    const bridge = new HarnessBridge(makeMockExports());
    const r = bridge.assertRoundTrip('probe');
    expect(r.protocol).toBe(HARNESS_PROTOCOL_VERSION);
    expect(r.echo).toBe('probe');
  });

  it('assertRoundTrip fails on version mismatch', () => {
    const exports = makeMockExports({
      inv_protocol_version: () => 99,
    });
    const bridge = new HarnessBridge(exports);
    expect(() => bridge.assertRoundTrip()).toThrow(/protocol mismatch/i);
  });

  it('pushMessage writes UTF-8 into wasm then frees', () => {
    const exports = makeMockExports();
    const freeSpy = vi.spyOn(exports, 'gpa_free');
    const bridge = new HarnessBridge(exports);
    bridge.pushMessage(MessageKind.User, 'ping');
    bridge.pushMessage(MessageKind.Assistant, 'pong');
    expect(exports.__messages).toEqual([
      { kind: MessageKind.User, text: 'ping' },
      { kind: MessageKind.Assistant, text: 'pong' },
    ]);
    expect(freeSpy).toHaveBeenCalled();
  });

  it('setLifecycle and clearMessages', () => {
    const exports = makeMockExports();
    const bridge = new HarnessBridge(exports);
    bridge.setLifecycle(Lifecycle.Ready);
    expect(exports.__lifecycle()).toBe(Lifecycle.Ready);
    bridge.pushMessage(MessageKind.System, 'x');
    bridge.clearMessages();
    expect(exports.__messages).toHaveLength(0);
  });

  it('takePendingSubmit reads and acks', () => {
    const exports = makeMockExports();
    exports.__setPending('bridge-stub');
    const bridge = new HarnessBridge(exports);
    expect(bridge.hasPendingSubmit()).toBe(true);
    expect(bridge.takePendingSubmit()).toBe('bridge-stub');
    expect(bridge.hasPendingSubmit()).toBe(false);
    expect(bridge.takePendingSubmit()).toBeNull();
  });
});
