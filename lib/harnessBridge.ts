/**
 * Phase 3.6 — typed JS ↔ Wasm harness bridge.
 *
 * Responsibilities:
 *   JS/TS  — fetch `/api/*`, DOM shell, clipboard, this glue
 *   Wasm   — dvui frame loop, transcript chrome, local harness state
 *   Both   — message protocol below (no Gateway secrets in Wasm)
 *
 * Protocol doc: native/harness/README.md (table of messages).
 */

/** Must match `PROTOCOL_VERSION` in `native/harness/src/bridge.zig`. */
export const HARNESS_PROTOCOL_VERSION = 2 as const;

/** XOR constant used by `inv_ping` on the Wasm side. */
export const INV_PING_XOR = 0xa5a5 as const;

export enum Lifecycle {
  Boot = 0,
  Ready = 1,
  Busy = 2,
  Error = 3,
}

export enum MessageKind {
  User = 1,
  Assistant = 2,
  System = 3,
  Error = 4,
}

export type LifecycleName = 'boot' | 'ready' | 'busy' | 'error';

export function lifecycleName(status: Lifecycle): LifecycleName {
  switch (status) {
    case Lifecycle.Boot:
      return 'boot';
    case Lifecycle.Ready:
      return 'ready';
    case Lifecycle.Busy:
      return 'busy';
    case Lifecycle.Error:
      return 'error';
    default:
      return 'error';
  }
}

/** Minimal memory surface (real `WebAssembly.Memory` or test double). */
export type WasmMemoryLike = {
  buffer: ArrayBuffer;
};

/** Minimal Wasm export surface required by the bridge (beyond dvui internals). */
export type HarnessBridgeExports = {
  memory: WasmMemoryLike;
  gpa_u8: (len: number) => number;
  gpa_free: (ptr: number, len: number) => void;
  inv_protocol_version: () => number;
  inv_ping: (x: number) => number;
  inv_set_lifecycle: (status: number) => void;
  inv_get_lifecycle: () => number;
  inv_message_count: () => number;
  inv_begin_batch: () => void;
  inv_end_batch: () => void;
  inv_push_message: (kind: number, ptr: number, len: number) => void;
  inv_clear_messages: () => void;
  inv_echo: (ptr: number, len: number) => number;
  inv_echo_len: () => number;
  inv_echo_copy: (outPtr: number, maxLen: number) => number;
  inv_has_pending_submit: () => number;
  inv_pending_submit_len: () => number;
  inv_pending_submit_copy: (outPtr: number, maxLen: number) => number;
  inv_ack_pending_submit: () => void;
};

const REQUIRED_FNS: Exclude<keyof HarnessBridgeExports, 'memory'>[] = [
  'gpa_u8',
  'gpa_free',
  'inv_protocol_version',
  'inv_ping',
  'inv_set_lifecycle',
  'inv_get_lifecycle',
  'inv_message_count',
  'inv_begin_batch',
  'inv_end_batch',
  'inv_push_message',
  'inv_clear_messages',
  'inv_echo',
  'inv_echo_len',
  'inv_echo_copy',
  'inv_has_pending_submit',
  'inv_pending_submit_len',
  'inv_pending_submit_copy',
  'inv_ack_pending_submit',
];

function isMemoryLike(v: unknown): v is WasmMemoryLike {
  return (
    typeof v === 'object' &&
    v !== null &&
    'buffer' in v &&
    (v as { buffer: unknown }).buffer instanceof ArrayBuffer
  );
}

export function isHarnessBridgeExports(
  exports: WebAssembly.Exports,
): exports is WebAssembly.Exports & HarnessBridgeExports {
  if (!isMemoryLike(exports.memory)) return false;
  for (const name of REQUIRED_FNS) {
    if (typeof exports[name as string] !== 'function') return false;
  }
  return true;
}

export type BridgeMissingExportError = {
  ok: false;
  error: string;
  missing: string[];
};

export type BridgeOk = { ok: true; bridge: HarnessBridge };

export type BridgeCreateResult = BridgeOk | BridgeMissingExportError;

const utf8Encode = new TextEncoder();
const utf8Decode = new TextDecoder();

/**
 * Typed handle over harness Wasm exports.
 * All string traffic is UTF-8 via linear memory + `gpa_u8` / `gpa_free`.
 */
export class HarnessBridge {
  readonly exports: HarnessBridgeExports;

  constructor(exports: HarnessBridgeExports) {
    this.exports = exports;
  }

  static fromInstance(instance: WebAssembly.Instance): BridgeCreateResult {
    const exp = instance.exports;
    if (!isHarnessBridgeExports(exp)) {
      const missing: string[] = [];
      if (!isMemoryLike(exp.memory)) missing.push('memory');
      for (const name of REQUIRED_FNS) {
        if (typeof exp[name as string] !== 'function') missing.push(name);
      }
      return {
        ok: false,
        error:
          missing.length > 0
            ? `Harness Wasm missing bridge exports: ${missing.join(', ')}. Rebuild harness on invincible-do-1 (workflow build-harness).`
            : 'Harness Wasm bridge exports invalid.',
        missing,
      };
    }
    return { ok: true, bridge: new HarnessBridge(exp) };
  }

  protocolVersion(): number {
    return this.exports.inv_protocol_version();
  }

  /** Scalar round-trip: Wasm returns `x ^ INV_PING_XOR`. */
  ping(x: number): number {
    return this.exports.inv_ping(x | 0);
  }

  setLifecycle(status: Lifecycle): void {
    this.exports.inv_set_lifecycle(status);
  }

  getLifecycle(): Lifecycle {
    return this.exports.inv_get_lifecycle() as Lifecycle;
  }

  messageCount(): number {
    return this.exports.inv_message_count() >>> 0;
  }

  beginBatch(): void {
    this.exports.inv_begin_batch();
  }

  endBatch(): void {
    this.exports.inv_end_batch();
  }

  /**
   * Host → Wasm full transcript replace (session hydrate / restore).
   * Batched so dvui refreshes once.
   */
  hydrateMessages(
    messages: { kind: MessageKind; text: string }[],
    opts?: { lifecycle?: Lifecycle },
  ): void {
    this.beginBatch();
    try {
      this.clearMessages();
      for (const m of messages) {
        this.pushMessage(m.kind, m.text);
      }
    } finally {
      this.endBatch();
    }
    if (opts?.lifecycle !== undefined) {
      this.setLifecycle(opts.lifecycle);
    }
  }

  pushMessage(kind: MessageKind, text: string): void {
    const { ptr, len } = this.writeUtf8(text);
    try {
      this.exports.inv_push_message(kind, ptr, len);
    } finally {
      this.exports.gpa_free(ptr, len);
    }
  }

  clearMessages(): void {
    this.exports.inv_clear_messages();
  }

  /**
   * JS → Wasm → JS string round-trip without network.
   * Uses inv_echo / inv_echo_copy.
   */
  echo(text: string): string {
    const { ptr, len } = this.writeUtf8(text);
    try {
      this.exports.inv_echo(ptr, len);
    } finally {
      this.exports.gpa_free(ptr, len);
    }
    const outLen = this.exports.inv_echo_len();
    if (outLen === 0) return '';
    const outPtr = this.exports.gpa_u8(outLen);
    if (!outPtr) throw new Error('gpa_u8 failed for echo read');
    try {
      const copied = this.exports.inv_echo_copy(outPtr, outLen);
      return this.readUtf8(outPtr, copied);
    } finally {
      this.exports.gpa_free(outPtr, outLen);
    }
  }

  hasPendingSubmit(): boolean {
    return this.exports.inv_has_pending_submit() !== 0;
  }

  /** Read + ack pending Wasm→JS submit, or null if none. */
  takePendingSubmit(): string | null {
    if (!this.hasPendingSubmit()) return null;
    const len = this.exports.inv_pending_submit_len();
    if (len === 0) {
      this.exports.inv_ack_pending_submit();
      return '';
    }
    const ptr = this.exports.gpa_u8(len);
    if (!ptr) throw new Error('gpa_u8 failed for pending submit');
    try {
      const copied = this.exports.inv_pending_submit_copy(ptr, len);
      const text = this.readUtf8(ptr, copied);
      this.exports.inv_ack_pending_submit();
      return text;
    } finally {
      this.exports.gpa_free(ptr, len);
    }
  }

  /**
   * Verify protocol version + scalar ping + string echo.
   * Throws on failure.
   */
  assertRoundTrip(sample = 'hello-bridge'): { protocol: number; echo: string; ping: number } {
    const protocol = this.protocolVersion();
    if (protocol !== HARNESS_PROTOCOL_VERSION) {
      throw new Error(
        `Harness protocol mismatch: wasm=${protocol} host=${HARNESS_PROTOCOL_VERSION}`,
      );
    }
    const probe = 0x1234;
    const ping = this.ping(probe);
    if (ping !== (probe ^ INV_PING_XOR)) {
      throw new Error(`inv_ping failed: got ${ping}`);
    }
    const echo = this.echo(sample);
    if (echo !== sample) {
      throw new Error(`inv_echo round-trip failed: got ${JSON.stringify(echo)}`);
    }
    return { protocol, echo, ping };
  }

  private writeUtf8(text: string): { ptr: number; len: number } {
    const bytes = utf8Encode.encode(text);
    const len = bytes.length;
    if (len === 0) {
      return { ptr: 0, len: 0 };
    }
    const ptr = this.exports.gpa_u8(len);
    if (!ptr) throw new Error(`gpa_u8(${len}) returned null`);
    // Re-read buffer after alloc (memory may have grown).
    new Uint8Array(this.exports.memory.buffer, ptr, len).set(bytes);
    return { ptr, len };
  }

  private readUtf8(ptr: number, len: number): string {
    if (len === 0) return '';
    return utf8Decode.decode(new Uint8Array(this.exports.memory.buffer, ptr, len));
  }
}

/** Host-side view of a protocol message (for tests / future session model). */
export type BridgeMessage = {
  kind: MessageKind;
  text: string;
};

/** Map a MessageKind to a short label (UI chrome). */
export function messageKindLabel(kind: MessageKind): string {
  switch (kind) {
    case MessageKind.User:
      return 'user';
    case MessageKind.Assistant:
      return 'assistant';
    case MessageKind.System:
      return 'system';
    case MessageKind.Error:
      return 'error';
    default:
      return 'msg';
  }
}
