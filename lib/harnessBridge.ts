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
import {
  HARNESS_SESSION_LABEL_MAX_BYTES,
  isRedisSafeOpaqueId,
  MAX_MODEL_ID_LEN,
  STATUS_SLOT_MAX_BYTES,
} from './sessionCloudCaps';

/** Must match `PROTOCOL_VERSION` in `native/harness/src/bridge.zig`. */
// v13 (plan #538/#541): additive status-slot store — `inv_set_status_slot`,
// `inv_status_slot_len/copy`, `inv_status_slots_clear`. Old exports intact.
// v14 (plan #567): additive whole-turn busy clock — scalar export
// `inv_set_turn_elapsed(secs)`; the Wasm busy row formats/appends ` · mm:ss`.
// v14 addendum (plan #574): additive 10 Hz busy-tick scalar `inv_set_busy_tick`
// driving the 2×4 WARM spinner.
// v15: `inv_set_busy_tick` is now REQUIRED; version bump for the new export
// (old hosts fail-closed via REQUIRED_FNS protocol-mismatch diagnostic).
// v16 (plan #616): model-selection persistence — `inv_set_selected_model`
// (restore-by-id) + `inv_has_pending_model_change` / `inv_ack_pending_model_change`
// (host observes a user Next cycle). All three are now REQUIRED.
// v17: session-rail catalog + pending switch — `inv_clear_session_catalog`,
// `inv_push_session_catalog_entry`, `inv_set_current_session`,
// `inv_has_pending_session_switch` / len / copy / ack. Additive, now REQUIRED.
// v18: submit-queue count — `inv_queued_count` (Wasm-ephemeral FIFO). Additive, now REQUIRED.
export const HARNESS_PROTOCOL_VERSION = 18 as const;

/** XOR constant used by `inv_ping` on the Wasm side. */
export const INV_PING_XOR = 0xa5a5 as const;

/** Must match Zig `MAX_CATALOG`. */
export const MAX_MODEL_CATALOG = 64 as const;
/**
 * Must match Zig `MAX_MODEL_ID_LEN`. Aliased to the SINGLE host source of truth
 * `MAX_MODEL_ID_LEN` in `./sessionCloudCaps` (plan #616 step 5: the caps module
 * is the shared client-safe source for host trim/parse AND server validation).
 * Cross-layer equality with the Zig constant is locked by a test in
 * `sessionCloudCaps.test.ts`.
 */
export { MAX_MODEL_ID_LEN };

/** Must match Zig `MAX_STATUS_SLOTS` (protocol v13, plan #538/#541). */
export const MAX_STATUS_SLOTS = 8 as const;
/**
 * Byte cap on a status-slot value, aliased to the SINGLE host source of truth
 * `STATUS_SLOT_MAX_BYTES` in `./sessionCloudCaps` (PR #543 L8 nit; was a second
 * duplicated 96 literal). Axis of truth for the whole host — every push/read
 * and the fold ellipsizer read this alias. Cross-layer equality (this ==
 * `STATUS_SLOT_MAX_BYTES` == Zig `MAX_STATUS_SLOT_LEN` in
 * `native/harness/src/bridge.zig`) is locked by a test in `sessionCloudCaps.test.ts`.
 */
export const MAX_STATUS_SLOT_LEN = STATUS_SLOT_MAX_BYTES;

/** Status-slot indices (protocol v13, plan #538/#541) — shared with bridge.zig. */
export enum StatusSlot {
  Sandbox = 0,
  Cwd = 1,
  /** Reserved for Phase 2 (git probe). */
  Git = 2,
  /** Context slot (Phase 3 #539) — provider token usage. */
  Context = 3,
}

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
  /** Protocol v8 — model reasoning / thinking monologue (display-only). */
  Thinking = 5,
  /**
   * Protocol v10 — host-aggregated tool-run group (display-only; session role
   * `tool_run`). Payload is the versioned `lib/toolRun.ts` encoder format.
   */
  ToolRun = 6,
  /**
   * Protocol v12 — display-only `Skill attached: <slug>` row (session role
   * `skill_attached`). Additive enum value 7 (next free after ToolRun=6) —
   * NEVER confuse the message-kind value with the protocol version (12).
   */
  SkillAttached = 7,
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
  // Protocol v11 — additive test-facing ring readback (mirrors `messageAt(i)`).
  // Never counts toward the product ring length (`inv_message_count` is unchanged).
  inv_message_kind_at: (i: number) => number;
  inv_message_text_len_at: (i: number) => number;
  inv_message_text_copy_at: (i: number, outPtr: number, maxLen: number) => number;
  inv_begin_batch: () => void;
  inv_end_batch: () => void;
  inv_push_message: (kind: number, ptr: number, len: number) => void;
  inv_update_last_message: (kind: number, ptr: number, len: number) => number;
  inv_clear_messages: () => void;
  inv_echo: (ptr: number, len: number) => number;
  inv_echo_len: () => number;
  inv_echo_copy: (outPtr: number, maxLen: number) => number;
  inv_has_pending_submit: () => number;
  inv_pending_submit_len: () => number;
  inv_pending_submit_copy: (outPtr: number, maxLen: number) => number;
  inv_ack_pending_submit: () => void;
  inv_queued_count: () => number;
  inv_set_can_load_earlier: (v: number) => void;
  inv_has_pending_load_earlier: () => number;
  inv_ack_pending_load_earlier: () => void;
  inv_has_pending_cancel: () => number;
  inv_ack_pending_cancel: () => void;
  inv_clear_model_catalog: () => void;
  inv_push_model_catalog_entry: (ptr: number, len: number) => number;
  inv_model_catalog_count: () => number;
  inv_selected_model_len: () => number;
  inv_selected_model_copy: (outPtr: number, maxLen: number) => number;
  inv_cycle_selected_model: () => number;
  // Protocol v16 (plan #616) — model-selection persistence.
  inv_set_selected_model: (ptr: number, len: number) => number;
  inv_has_pending_model_change: () => number;
  inv_ack_pending_model_change: () => void;
  // Protocol v17 — session-rail catalog + pending switch.
  inv_clear_session_catalog: () => void;
  inv_push_session_catalog_entry: (
    idPtr: number,
    idLen: number,
    labelPtr: number,
    labelLen: number,
  ) => number;
  inv_session_catalog_count: () => number;
  inv_set_current_session: (ptr: number, len: number) => number;
  inv_has_pending_session_switch: () => number;
  inv_pending_session_switch_len: () => number;
  inv_pending_session_switch_copy: (outPtr: number, maxLen: number) => number;
  inv_ack_pending_session_switch: () => void;
  // Protocol v13 — status-slot store (host push + readback + clear).
  inv_set_status_slot: (slot: number, ptr: number, len: number) => number;
  inv_status_slot_len: (slot: number) => number;
  inv_status_slot_copy: (slot: number, outPtr: number, maxLen: number) => number;
  inv_status_slots_clear: () => void;
  // Protocol v14 (plan #567) — whole-turn busy clock: host feeds scalar elapsed
  // seconds; the Wasm busy row formats/appends ` · mm:ss`.
  inv_set_turn_elapsed: (secs: number) => void;
  // Protocol v14 addendum (plan #574) — 10 Hz busy-tick phase for the 2×4
  // spinner: host feeds the pulse phase; the Wasm busy row paints the WARM grid.
  inv_set_busy_tick: (phase: number) => void;
  inv_image_cache_put: (
    urlPtr: number,
    urlLen: number,
    rgbaPtr: number,
    width: number,
    height: number,
  ) => number;
  inv_image_cache_clear: () => void;
  inv_math_cache_put: (
    texPtr: number,
    texLen: number,
    display: number,
    rgbaPtr: number,
    width: number,
    height: number,
  ) => number;
  inv_math_cache_clear: () => void;
};

const REQUIRED_FNS: Exclude<keyof HarnessBridgeExports, 'memory'>[] = [
  'gpa_u8',
  'gpa_free',
  'inv_protocol_version',
  'inv_ping',
  'inv_set_lifecycle',
  'inv_get_lifecycle',
  'inv_message_count',
  'inv_message_kind_at',
  'inv_message_text_len_at',
  'inv_message_text_copy_at',
  'inv_begin_batch',
  'inv_end_batch',
  'inv_push_message',
  'inv_update_last_message',
  'inv_clear_messages',
  'inv_echo',
  'inv_echo_len',
  'inv_echo_copy',
  'inv_has_pending_submit',
  'inv_pending_submit_len',
  'inv_pending_submit_copy',
  'inv_ack_pending_submit',
  'inv_queued_count',
  'inv_set_can_load_earlier',
  'inv_has_pending_load_earlier',
  'inv_ack_pending_load_earlier',
  'inv_has_pending_cancel',
  'inv_ack_pending_cancel',
  'inv_clear_model_catalog',
  'inv_push_model_catalog_entry',
  'inv_model_catalog_count',
  'inv_selected_model_len',
  'inv_selected_model_copy',
  'inv_cycle_selected_model',
  'inv_set_selected_model',
  'inv_has_pending_model_change',
  'inv_ack_pending_model_change',
  'inv_clear_session_catalog',
  'inv_push_session_catalog_entry',
  'inv_session_catalog_count',
  'inv_set_current_session',
  'inv_has_pending_session_switch',
  'inv_pending_session_switch_len',
  'inv_pending_session_switch_copy',
  'inv_ack_pending_session_switch',
  'inv_set_status_slot',
  'inv_status_slot_len',
  'inv_status_slot_copy',
  'inv_status_slots_clear',
  'inv_set_turn_elapsed',
  'inv_set_busy_tick',
  'inv_image_cache_put',
  'inv_image_cache_clear',
  'inv_math_cache_put',
  'inv_math_cache_clear',
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

  /**
   * Protocol v11 — read the message kind of ring index `i` (tests / readback).
   * Returns a `MessageKind` for a valid index, or 0 (out of range). Additive:
   * never alters `inv_message_count` or paint.
   */
  messageKindAt(i: number): MessageKind {
    return this.exports.inv_message_kind_at(i | 0) as MessageKind;
  }

  /**
   * Protocol v11 — read the body length (UTF-8 bytes) of ring index `i`.
   * Useful for tests to size a copy without guessing.
   */
  messageTextLenAt(i: number): number {
    return this.exports.inv_message_text_len_at(i | 0) >>> 0;
  }

  /**
   * Protocol v11 — read the UTF-8 body of ring index `i`. Returns `''` when out
   * of range or empty. Test-facing readback of the exact bytes the Wasm ring
   * holds.
   */
  messageTextAt(i: number): string {
    const len = this.messageTextLenAt(i);
    if (len === 0) return '';
    const ptr = this.exports.gpa_u8(len);
    if (!ptr) throw new Error('gpa_u8 failed for message readback');
    try {
      const copied = this.exports.inv_message_text_copy_at(i | 0, ptr, len);
      return this.readUtf8(ptr, copied);
    } finally {
      this.exports.gpa_free(ptr, len);
    }
  }

  /** Protocol v11 — read the full message at ring index `i`, or null when OOR. */
  messageAt(i: number): BridgeMessage | null {
    if (i < 0 || i >= this.messageCount()) return null;
    return { kind: this.messageKindAt(i), text: this.messageTextAt(i) };
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

  /**
   * Replace last ring message when kind matches (protocol v7+ stream growth; Thinking kind in v8).
   * Used to grow a streaming assistant/thinking bubble without N new messages.
   */
  updateLastMessage(kind: MessageKind, text: string): boolean {
    const { ptr, len } = this.writeUtf8(text);
    try {
      return this.exports.inv_update_last_message(kind, ptr, len) !== 0;
    } finally {
      this.exports.gpa_free(ptr, len);
    }
  }

  clearMessages(): void {
    this.exports.inv_clear_messages();
  }

  /**
   * Push host-decoded non-premultiplied RGBA into Wasm image cache (protocol v4).
   * Returns true on success.
   */
  imageCachePut(
    url: string,
    rgba: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
  ): boolean {
    if (!url || width <= 0 || height <= 0) return false;
    // Match Wasm MAX_EDGE (1280); reject absurd dims before gpa_u8.
    if (width > 1280 || height > 1280) return false;
    const need = width * height * 4;
    if (!Number.isFinite(need) || need <= 0 || rgba.byteLength < need) return false;
    const urlBytes = this.writeUtf8(url);
    const rgbaPtr = this.exports.gpa_u8(need);
    if (!rgbaPtr) {
      if (urlBytes.len > 0) this.exports.gpa_free(urlBytes.ptr, urlBytes.len);
      return false;
    }
    try {
      new Uint8Array(this.exports.memory.buffer, rgbaPtr, need).set(
        rgba.subarray(0, need),
      );
      const rc = this.exports.inv_image_cache_put(
        urlBytes.ptr,
        urlBytes.len,
        rgbaPtr,
        width | 0,
        height | 0,
      );
      return rc === 0;
    } finally {
      this.exports.gpa_free(rgbaPtr, need);
      if (urlBytes.len > 0) this.exports.gpa_free(urlBytes.ptr, urlBytes.len);
    }
  }

  imageCacheClear(): void {
    this.exports.inv_image_cache_clear();
  }

  /**
   * Push host-rasterized math RGBA into Wasm math cache (protocol v5).
   * display: 0 = inline, 1 = display. Returns true on success.
   * TeX length is UTF-8 bytes (matches Zig MAX_TEX_LEN).
   */
  mathCachePut(
    tex: string,
    display: boolean,
    rgba: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
  ): boolean {
    if (!tex || width <= 0 || height <= 0) return false;
    if (width > 1280 || height > 1280) return false;
    const texUtf8Len = utf8Encode.encode(tex).length;
    if (texUtf8Len === 0 || texUtf8Len > 512) return false;
    const need = width * height * 4;
    if (!Number.isFinite(need) || need <= 0 || rgba.byteLength < need) return false;
    const texBytes = this.writeUtf8(tex);
    const rgbaPtr = this.exports.gpa_u8(need);
    if (!rgbaPtr) {
      if (texBytes.len > 0) this.exports.gpa_free(texBytes.ptr, texBytes.len);
      return false;
    }
    try {
      new Uint8Array(this.exports.memory.buffer, rgbaPtr, need).set(
        rgba.subarray(0, need),
      );
      const rc = this.exports.inv_math_cache_put(
        texBytes.ptr,
        texBytes.len,
        display ? 1 : 0,
        rgbaPtr,
        width | 0,
        height | 0,
      );
      return rc === 0;
    } finally {
      this.exports.gpa_free(rgbaPtr, need);
      if (texBytes.len > 0) this.exports.gpa_free(texBytes.ptr, texBytes.len);
    }
  }

  mathCacheClear(): void {
    this.exports.inv_math_cache_clear();
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

  /** Protocol v18 — Wasm-ephemeral follow-up queue depth. */
  queuedCount(): number {
    return this.exports.inv_queued_count();
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


  setCanLoadEarlier(can: boolean): void {
    this.exports.inv_set_can_load_earlier(can ? 1 : 0);
  }

  /**
   * Read + ack pending Wasm→JS "Load earlier" (protocol v6), or false if none.
   */
  takePendingLoadEarlier(): boolean {
    if (this.exports.inv_has_pending_load_earlier() === 0) return false;
    this.exports.inv_ack_pending_load_earlier();
    return true;
  }

  /**
   * Read + ack pending Wasm→JS cancel (protocol v9 user Stop), or false if none.
   */
  takePendingCancel(): boolean {
    if (this.exports.inv_has_pending_cancel() === 0) return false;
    this.exports.inv_ack_pending_cancel();
    return true;
  }

  clearModelCatalog(): void {
    this.exports.inv_clear_model_catalog();
  }

  /**
   * Push one model id into the Wasm catalog. Returns false if rejected.
   */
  pushModelCatalogEntry(modelId: string): boolean {
    const id = modelId.trim();
    if (!id || id.length > MAX_MODEL_ID_LEN) return false;
    const { ptr, len } = this.writeUtf8(id);
    try {
      return this.exports.inv_push_model_catalog_entry(ptr, len) !== 0;
    } finally {
      if (len > 0) this.exports.gpa_free(ptr, len);
    }
  }

  /** Replace catalog with the given model ids (clears first). */
  setModelCatalog(modelIds: string[]): void {
    this.clearModelCatalog();
    for (const id of modelIds) {
      this.pushModelCatalogEntry(id);
    }
  }

  modelCatalogCount(): number {
    return this.exports.inv_model_catalog_count() >>> 0;
  }

  /** Selected model id, or null if catalog empty. */
  getSelectedModel(): string | null {
    const len = this.exports.inv_selected_model_len() >>> 0;
    if (len === 0) return null;
    const ptr = this.exports.gpa_u8(len);
    if (!ptr) throw new Error('gpa_u8 failed for selected model');
    try {
      const copied = this.exports.inv_selected_model_copy(ptr, len);
      const text = this.readUtf8(ptr, copied).trim();
      return text.length > 0 ? text : null;
    } finally {
      this.exports.gpa_free(ptr, len);
    }
  }

  cycleSelectedModel(): number {
    return this.exports.inv_cycle_selected_model() >>> 0;
  }

  /**
   * Protocol v16 (plan #616) — host restore-by-id. Selects the catalog entry
   * whose id equals `id` (exact match, not index arithmetic), or resets to the
   * default (index 0) when `id` is `null`/empty/not-in-catalog. Returns true
   * when accepted; rejects oversize / non-printable-ASCII ids. Never raises the
   * pending-model-change flag (this is host-driven restore, not a user cycle).
   */
  setSelectedModel(id: string | null): boolean {
    if (id === null || id.length === 0) {
      return this.exports.inv_set_selected_model(0, 0) !== 0;
    }
    const bytes = utf8Encode.encode(id);
    if (bytes.length === 0 || bytes.length > MAX_MODEL_ID_LEN) return false;
    const ptr = this.exports.gpa_u8(bytes.length);
    if (!ptr) return false;
    try {
      new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
      return this.exports.inv_set_selected_model(ptr, bytes.length) !== 0;
    } finally {
      this.exports.gpa_free(ptr, bytes.length);
    }
  }

  /**
   * Protocol v16 (plan #616) — whether the USER cycled the model via Next since
   * the last ack. The host reads the live selection and persists it, then acks.
   */
  hasPendingModelChange(): boolean {
    return this.exports.inv_has_pending_model_change() !== 0;
  }

  /** Protocol v16 (plan #616) — clear the pending-model-change flag. */
  ackPendingModelChange(): void {
    this.exports.inv_ack_pending_model_change();
  }

  clearSessionCatalog(): void {
    this.exports.inv_clear_session_catalog();
  }

  /**
   * Push one session row. Two GPA buffers (id + label), both freed.
   * Rejects empty / non-Redis-safe id, empty / oversize label (host-side).
   */
  pushSessionCatalogEntry(id: string, label: string): boolean {
    if (!isRedisSafeOpaqueId(id)) return false;
    const labelBytes = utf8Encode.encode(label);
    if (labelBytes.length === 0 || labelBytes.length > HARNESS_SESSION_LABEL_MAX_BYTES) {
      return false;
    }
    const idBuf = this.writeUtf8(id);
    const labelBuf = this.writeUtf8(label);
    try {
      return (
        this.exports.inv_push_session_catalog_entry(
          idBuf.ptr,
          idBuf.len,
          labelBuf.ptr,
          labelBuf.len,
        ) !== 0
      );
    } finally {
      if (idBuf.len > 0) this.exports.gpa_free(idBuf.ptr, idBuf.len);
      if (labelBuf.len > 0) this.exports.gpa_free(labelBuf.ptr, labelBuf.len);
    }
  }

  /** Replace catalog (clear + push each; continue on reject) + set current. */
  setSessionCatalog(
    entries: { id: string; label: string }[],
    currentId: string | null,
  ): void {
    this.clearSessionCatalog();
    for (const e of entries) {
      this.pushSessionCatalogEntry(e.id, e.label);
    }
    this.setCurrentSession(currentId);
  }

  sessionCatalogCount(): number {
    return this.exports.inv_session_catalog_count() >>> 0;
  }

  setCurrentSession(id: string | null): boolean {
    if (id === null || id.length === 0) {
      return this.exports.inv_set_current_session(0, 0) !== 0;
    }
    if (!isRedisSafeOpaqueId(id)) return false;
    const { ptr, len } = this.writeUtf8(id);
    try {
      return this.exports.inv_set_current_session(ptr, len) !== 0;
    } finally {
      if (len > 0) this.exports.gpa_free(ptr, len);
    }
  }

  hasPendingSessionSwitch(): boolean {
    return this.exports.inv_has_pending_session_switch() !== 0;
  }

  /** Read + ack pending session-switch id, or null if none. */
  takePendingSessionSwitch(): string | null {
    if (!this.hasPendingSessionSwitch()) return null;
    const len = this.exports.inv_pending_session_switch_len() >>> 0;
    if (len === 0) {
      this.exports.inv_ack_pending_session_switch();
      return null;
    }
    const ptr = this.exports.gpa_u8(len);
    if (!ptr) throw new Error('gpa_u8 failed for pending session switch');
    try {
      const copied = this.exports.inv_pending_session_switch_copy(ptr, len);
      const text = this.readUtf8(ptr, copied).trim();
      this.exports.inv_ack_pending_session_switch();
      return text.length > 0 ? text : null;
    } finally {
      this.exports.gpa_free(ptr, len);
    }
  }

  /**
   * Protocol v13 (plan #538/#541) — set one status slot. A slot value is a
   * bounded UTF-8 string (max `MAX_STATUS_SLOT_LEN` bytes) that the Wasm header
   * band paints (sandbox · cwd …). Returns true when the push was accepted
   * (non-empty, in-range, ≤ cap). Oversize/empty/out-of-range pushes are
   * rejected — this is authoritative, never a silent truncation.
   */
  setStatusSlot(slot: StatusSlot, value: string): boolean {
    if (slot < 0 || slot >= MAX_STATUS_SLOTS) return false;
    const text = value.trim();
    if (!text || text.length === 0) return false;
    const bytes = utf8Encode.encode(text);
    if (bytes.length === 0 || bytes.length > MAX_STATUS_SLOT_LEN) return false;
    const ptr = this.exports.gpa_u8(bytes.length);
    if (!ptr) return false;
    try {
      new Uint8Array(this.exports.memory.buffer, ptr, bytes.length).set(bytes);
      return this.exports.inv_set_status_slot(slot, ptr, bytes.length) !== 0;
    } finally {
      this.exports.gpa_free(ptr, bytes.length);
    }
  }

  /** Protocol v13 — clear one status-slot value (empty slot hides in the pack). */
  clearStatusSlot(slot: StatusSlot): void {
    if (slot < 0 || slot >= MAX_STATUS_SLOTS) return;
    this.exports.inv_set_status_slot(slot, 0, 0);
  }

  /** Protocol v13 — read one status-slot value, or '' when unset / out of range. */
  getStatusSlot(slot: StatusSlot): string {
    const len = this.exports.inv_status_slot_len(slot) >>> 0;
    if (len === 0) return '';
    const ptr = this.exports.gpa_u8(len);
    if (!ptr) throw new Error('gpa_u8 failed for status slot');
    try {
      const copied = this.exports.inv_status_slot_copy(slot, ptr, len);
      return this.readUtf8(ptr, copied);
    } finally {
      this.exports.gpa_free(ptr, len);
    }
  }

  /** Protocol v13 — clear all status slots (Clear / New session / restore empty). */
  clearStatusSlots(): void {
    this.exports.inv_status_slots_clear();
  }

  /**
   * Protocol v14 (plan #567) — the host feeds the whole-turn elapsed wall-clock
   * seconds while a turn is busy; the Wasm busy row formats/appends ` · mm:ss`.
   * `0` clears the clock (idle/stop/error/clear) so no stale `0:00` lingers.
   * Scalar u32 transport — no string/byte budget on the hot path. The host calls
   * this ~1 Hz from its Busy wall-clock effect (the host owns the only reliable
   * wall clock; the Wasm holds a passive display only).
   */
  setTurnElapsed(secs: number): void {
    this.exports.inv_set_turn_elapsed(Math.max(0, Math.floor(secs)) | 0);
  }

  /**
   * Protocol v14 addendum (plan #574) — the host feeds the 10 Hz busy-tick
   * phase for the 2×4 WARM spinner. Scalar u8 transport (truncated): drives the
   * clockwise pulse (`busy_tick % 8`). `phase == 0` = head at bottom-left — also
   * the reduced-motion static value and the idle/Stop/error reset. The host
   * calls this while a turn is Busy; 0 on idle/Stop/error/clear stops the pulse.
   */
  setBusyTick(phase: number): void {
    this.exports.inv_set_busy_tick(Math.max(0, Math.floor(phase)) | 0);
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
    case MessageKind.Thinking:
      return 'thinking';
    case MessageKind.ToolRun:
      return 'tools';
    case MessageKind.SkillAttached:
      return 'skill';
    default:
      return 'msg';
  }
}
