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
  __setLoadEarlierPending: (on: boolean) => void;
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
  let loadEarlier = false;
  let canLoad = 0;
  const catalog: string[] = [];
  let selected = 0;

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
    inv_set_can_load_earlier: (v: number) => {
      canLoad = v ? 1 : 0;
      if (!canLoad) loadEarlier = false;
    },
    inv_has_pending_load_earlier: () => (loadEarlier ? 1 : 0),
    inv_ack_pending_load_earlier: () => {
      loadEarlier = false;
    },
    inv_clear_model_catalog: () => {
      catalog.length = 0;
      selected = 0;
    },
    inv_push_model_catalog_entry: (ptr: number, len: number) => {
      if (len <= 0 || len > 128 || catalog.length >= 64) return 0;
      const id = read(ptr, len);
      if (!id || /[\x00-\x20\x7f-\xff]/.test(id)) return 0;
      catalog.push(id);
      if (catalog.length === 1) selected = 0;
      return 1;
    },
    inv_model_catalog_count: () => catalog.length,
    inv_selected_model_len: () => {
      if (catalog.length === 0) return 0;
      const idx = Math.min(selected, catalog.length - 1);
      return catalog[idx].length;
    },
    inv_selected_model_copy: (outPtr: number, maxLen: number) => {
      if (catalog.length === 0) return 0;
      const idx = Math.min(selected, catalog.length - 1);
      const id = catalog[idx];
      const n = Math.min(maxLen, id.length);
      if (n > 0) write(outPtr, id.slice(0, n));
      return n;
    },
    inv_cycle_selected_model: () => {
      if (catalog.length <= 1) return selected;
      selected = (selected + 1) % catalog.length;
      return selected;
    },
    inv_image_cache_put: () => 0,
    inv_image_cache_clear: () => {},
    inv_math_cache_put: () => 0,
    inv_math_cache_clear: () => {},
    __messages: messages,
    __setPending: (s) => {
      pending = s;
    },
    __setLoadEarlierPending: (on) => {
      loadEarlier = !!on;
    },
    __lifecycle: () => lifecycle,
  };

  return {
    ...base,
    ...overrides,
    __messages: messages,
    __setPending: base.__setPending,
    __setLoadEarlierPending: base.__setLoadEarlierPending,
    __lifecycle: base.__lifecycle,
  };
}

describe('lifecycleName / messageKindLabel', () => {
  it('maps enums', () => {
    expect(lifecycleName(Lifecycle.Ready)).toBe('ready');
    expect(messageKindLabel(MessageKind.User)).toBe('user');
    expect(messageKindLabel(MessageKind.Error)).toBe('error');
    expect(messageKindLabel(MessageKind.Thinking)).toBe('thinking');
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

describe('hydrateMessages (protocol v2)', () => {
  it('clears and batch-pushes', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.User, 'old');
    bridge.hydrateMessages(
      [
        { kind: MessageKind.User, text: 'a' },
        { kind: MessageKind.Assistant, text: 'b' },
      ],
      { lifecycle: Lifecycle.Ready },
    );
    expect(exp.__messages.map((m) => m.text)).toEqual(['a', 'b']);
    expect(exp.__lifecycle()).toBe(Lifecycle.Ready);
    expect(bridge.messageCount()).toBe(2);
  });
});


describe('model catalog protocol v3', () => {
  it('setModelCatalog + getSelectedModel round-trip', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['anthropic/claude-a', 'openai/gpt-b']);
    expect(bridge.modelCatalogCount()).toBe(2);
    expect(bridge.getSelectedModel()).toBe('anthropic/claude-a');
    bridge.cycleSelectedModel();
    expect(bridge.getSelectedModel()).toBe('openai/gpt-b');
  });

  it('catalog replace drops missing selection to first', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['a/m1', 'a/m2']);
    bridge.cycleSelectedModel();
    expect(bridge.getSelectedModel()).toBe('a/m2');
    bridge.setModelCatalog(['b/only']);
    expect(bridge.getSelectedModel()).toBe('b/only');
  });

  it('rejects empty / oversize entry', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    expect(bridge.pushModelCatalogEntry('')).toBe(false);
    expect(bridge.pushModelCatalogEntry('x'.repeat(200))).toBe(false);
    expect(bridge.modelCatalogCount()).toBe(0);
  });

  it('protocol mismatch fails assertRoundTrip', () => {
    const exp = makeMockExports({
      inv_protocol_version: () => 2,
    });
    const bridge = new HarnessBridge(exp);
    expect(() => bridge.assertRoundTrip()).toThrow(/protocol mismatch/);
  });
});

describe("imageCachePut (protocol v4)", () => {
  it("copies RGBA into inv_image_cache_put", () => {
    const exp = makeMockExports();
    let seen: { url: string; w: number; h: number; bytes: number } | null = null;
    exp.inv_image_cache_put = (urlPtr, urlLen, rgbaPtr, width, height) => {
      const url = new TextDecoder().decode(
        new Uint8Array(exp.memory.buffer, urlPtr, urlLen),
      );
      seen = { url, w: width, h: height, bytes: width * height * 4 };
      // touch rgba to ensure buffer readable
      void new Uint8Array(exp.memory.buffer, rgbaPtr, width * height * 4)[0];
      return 0;
    };
    const bridge = new HarnessBridge(exp);
    const rgba = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(bridge.imageCachePut("https://example.com/a.png", rgba, 2, 2)).toBe(true);
    expect(seen).toEqual({
      url: "https://example.com/a.png",
      w: 2,
      h: 2,
      bytes: 16,
    });
  });

  it("rejects zero dimensions", () => {
    const bridge = new HarnessBridge(makeMockExports());
    expect(bridge.imageCachePut("https://example.com/a.png", new Uint8Array(16), 0, 2)).toBe(false);
  });
});

describe("mathCachePut (protocol v5)", () => {
  it("copies TeX + RGBA into inv_math_cache_put with display flag", () => {
    const exp = makeMockExports();
    let seen: {
      tex: string;
      display: number;
      w: number;
      h: number;
      bytes: number;
    } | null = null;
    exp.inv_math_cache_put = (
      texPtr,
      texLen,
      display,
      rgbaPtr,
      width,
      height,
    ) => {
      const tex = new TextDecoder().decode(
        new Uint8Array(exp.memory.buffer, texPtr, texLen),
      );
      seen = {
        tex,
        display,
        w: width,
        h: height,
        bytes: width * height * 4,
      };
      void new Uint8Array(exp.memory.buffer, rgbaPtr, width * height * 4)[0];
      return 0;
    };
    const bridge = new HarnessBridge(exp);
    const rgba = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(bridge.mathCachePut("E=mc^2", true, rgba, 2, 2)).toBe(true);
    expect(seen).toEqual({
      tex: "E=mc^2",
      display: 1,
      w: 2,
      h: 2,
      bytes: 16,
    });
    expect(bridge.mathCachePut("x_i", false, rgba, 2, 2)).toBe(true);
    expect(seen).not.toBeNull();
    expect(seen!.display).toBe(0);
  });

  it("rejects empty tex, oversize UTF-8, and zero dims", () => {
    const bridge = new HarnessBridge(makeMockExports());
    const rgba = new Uint8Array(16);
    expect(bridge.mathCachePut("", false, rgba, 2, 2)).toBe(false);
    expect(bridge.mathCachePut("x", false, rgba, 0, 2)).toBe(false);
    // 513 ASCII bytes > MAX_TEX_LEN
    expect(bridge.mathCachePut("x".repeat(513), false, rgba, 2, 2)).toBe(false);
  });
});


describe('load earlier pending (protocol v6)', () => {
  it('takePendingLoadEarlier acks once', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setCanLoadEarlier(true);
    exp.__setLoadEarlierPending(true);
    expect(bridge.takePendingLoadEarlier()).toBe(true);
    expect(bridge.takePendingLoadEarlier()).toBe(false);
  });
});

describe('updateLastMessage (protocol v8 stream growth)', () => {
  it('replaces last message when kind matches', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.pushMessage(MessageKind.Assistant, 'Hel');
    expect(bridge.updateLastMessage(MessageKind.Assistant, 'Hello')).toBe(true);
    expect(exp.__messages.map((m) => m.text)).toEqual(['Hello']);
  });

  it('returns false when kind mismatches or empty', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    expect(bridge.updateLastMessage(MessageKind.Assistant, 'x')).toBe(false);
    bridge.pushMessage(MessageKind.User, 'hi');
    expect(bridge.updateLastMessage(MessageKind.Assistant, 'x')).toBe(false);
    expect(exp.__messages.map((m) => m.text)).toEqual(['hi']);
  });
});
