import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessBridge,
  INV_PING_XOR,
  Lifecycle,
  type HarnessBridgeExports,
} from './harnessBridge';
import { createEmptySession, type SessionSnapshot } from './sessionStore';
import {
  applySessionReasoning,
  discardPendingReasoningChange,
  foldPendingReasoningChange,
} from './harnessHostReasoningPersist';

function makeEffortBridge() {
  let buf = new ArrayBuffer(64 * 1024);
  const memory = { get buffer() { return buf; } };
  let nextPtr = 1024;
  const efforts: string[] = [];
  let selected = 0;
  let hasSel = false;
  let pending = false;
  const gpa_u8 = (len: number) => {
    const ptr = nextPtr;
    nextPtr += len + 16;
    return ptr;
  };
  const read = (ptr: number, len: number) =>
    new TextDecoder().decode(new Uint8Array(buf, ptr, len));
  const write = (ptr: number, text: string) => {
    const bytes = new TextEncoder().encode(text);
    new Uint8Array(buf, ptr, bytes.length).set(bytes);
  };
  const stub = () => 0;
  const exports = {
    memory,
    gpa_u8,
    gpa_free: () => {},
    inv_protocol_version: () => HARNESS_PROTOCOL_VERSION,
    inv_ping: (x: number) => (x | 0) ^ INV_PING_XOR,
    inv_set_lifecycle: () => {},
    inv_get_lifecycle: () => Lifecycle.Ready,
    inv_message_count: () => 0,
    inv_message_kind_at: stub,
    inv_message_text_len_at: stub,
    inv_message_text_copy_at: stub,
    inv_begin_batch: () => {},
    inv_end_batch: () => {},
    inv_push_message: () => {},
    inv_update_last_message: stub,
    inv_clear_messages: () => {},
    inv_clear_ring: () => {},
    inv_echo: stub,
    inv_echo_len: stub,
    inv_echo_copy: stub,
    inv_has_pending_submit: stub,
    inv_pending_submit_len: stub,
    inv_pending_submit_copy: stub,
    inv_ack_pending_submit: () => {},
    inv_queued_count: stub,
    inv_set_queue_promote_allowed: () => {},
    inv_queued_insert_front: () => 1,
    inv_set_can_load_earlier: () => {},
    inv_has_pending_load_earlier: stub,
    inv_ack_pending_load_earlier: () => {},
    inv_has_pending_cancel: stub,
    inv_ack_pending_cancel: () => {},
    inv_clear_model_catalog: () => {},
    inv_push_model_catalog_entry: () => 0,
    inv_model_catalog_count: stub,
    inv_selected_model_len: stub,
    inv_selected_model_copy: stub,
    inv_cycle_selected_model: stub,
    inv_set_selected_model: () => 1,
    inv_has_pending_model_change: stub,
    inv_ack_pending_model_change: () => {},
    inv_clear_reasoning_efforts: () => {
      efforts.length = 0;
      selected = 0;
      hasSel = false;
    },
    inv_push_reasoning_effort: (ptr: number, len: number) => {
      if (len <= 0 || len > 32 || efforts.length >= 16) return 0;
      const id = read(ptr, len);
      if (!id || !/^[a-z0-9_-]+$/.test(id)) return 0;
      efforts.push(id);
      return 1;
    },
    inv_reasoning_effort_count: () => efforts.length,
    inv_selected_reasoning_len: () =>
      efforts.length === 0 || !hasSel ? 0 : efforts[Math.min(selected, efforts.length - 1)].length,
    inv_selected_reasoning_copy: (outPtr: number, maxLen: number) => {
      if (efforts.length === 0 || !hasSel) return 0;
      const id = efforts[Math.min(selected, efforts.length - 1)];
      const n = Math.min(maxLen, id.length);
      if (n > 0) write(outPtr, id.slice(0, n));
      return n;
    },
    inv_set_selected_reasoning: (ptr: number, len: number) => {
      if (len === 0) {
        hasSel = false;
        selected = 0;
        return 1;
      }
      const id = read(ptr, len);
      const i = efforts.indexOf(id);
      if (i < 0) return 0;
      selected = i;
      hasSel = true;
      return 1;
    },
    inv_has_pending_reasoning_change: () => (pending ? 1 : 0),
    inv_ack_pending_reasoning_change: () => {
      pending = false;
    },
    inv_set_resolved_provider: (_ptr: number, len: number) => (len <= 32 ? 1 : 0),
    inv_clear_session_catalog: () => {},
    inv_push_session_catalog_entry: () => 0,
    inv_session_catalog_count: stub,
    inv_set_current_session: stub,
    inv_has_pending_session_switch: stub,
    inv_pending_session_switch_len: stub,
    inv_pending_session_switch_copy: stub,
    inv_ack_pending_session_switch: () => {},
    inv_set_status_slot: stub,
    inv_status_slot_len: stub,
    inv_status_slot_copy: stub,
    inv_status_slots_clear: () => {},
    inv_set_turn_elapsed: () => {},
    inv_set_busy_tick: () => {},
    inv_image_cache_put: stub,
    inv_image_cache_clear: () => {},
    inv_math_cache_put: stub,
    inv_math_cache_clear: () => {},
    raisePending() {
      pending = true;
    },
  } as HarnessBridgeExports & { raisePending: () => void };
  return { bridge: new HarnessBridge(exports), exp: exports };
}

describe('applySessionReasoning (plan #898)', () => {
  it('empty options → no selection; get returns null', () => {
    const { bridge } = makeEffortBridge();
    const ref = { current: createEmptySession('s1') };
    applySessionReasoning(ref.current, [], bridge, ref, () => {}, null);
    expect(bridge.getSelectedReasoning()).toBeNull();
    expect(bridge.reasoningEffortCount()).toBe(0);
  });

  it('push [low,high,max]; unset carrier defaults to low (never xhigh)', () => {
    const { bridge } = makeEffortBridge();
    const ref = { current: createEmptySession('s1') };
    applySessionReasoning(ref.current, ['low', 'high', 'max'], bridge, ref, () => {}, null);
    expect(bridge.getSelectedReasoning()).toBe('low');
    expect(bridge.reasoningEffortCount()).toBe(3);
    expect(ref.current.reasoningEffort).toBeUndefined();
  });

  it('stored max restores as xhigh and persists the rewrite', () => {
    const { bridge } = makeEffortBridge();
    const puts: SessionSnapshot[] = [];
    const ref: { current: SessionSnapshot } = {
      current: { ...createEmptySession('s1'), reasoningEffort: 'max' },
    };
    applySessionReasoning(
      ref.current,
      ['low', 'high', 'max'],
      bridge,
      ref,
      (s) => {
        ref.current = s;
        puts.push(s);
      },
      null,
    );
    expect(bridge.getSelectedReasoning()).toBe('xhigh');
    expect(ref.current.reasoningEffort).toBe('xhigh');
    expect(puts[0]?.reasoningEffort).toBe('xhigh');
  });

  it('NEVER_AUTO-only [max] lists xhigh and stays unset (never default)', () => {
    const { bridge } = makeEffortBridge();
    const ref = { current: createEmptySession('s1') };
    const puts: SessionSnapshot[] = [];
    applySessionReasoning(
      ref.current,
      ['max'],
      bridge,
      ref,
      (s) => {
        ref.current = s;
        puts.push(s);
      },
      null,
    );
    expect(bridge.reasoningEffortCount()).toBe(1);
    expect(bridge.getSelectedReasoning()).toBeNull();
    expect(ref.current.reasoningEffort).toBeUndefined();
    expect(puts).toHaveLength(0);
  });

  it('NEVER_AUTO-only [xhigh, max] dedupes to xhigh and stays unset', () => {
    const { bridge } = makeEffortBridge();
    const ref = { current: createEmptySession('s1') };
    applySessionReasoning(ref.current, ['xhigh', 'max'], bridge, ref, () => {}, null);
    expect(bridge.reasoningEffortCount()).toBe(1);
    expect(bridge.getSelectedReasoning()).toBeNull();
  });

  it('restore poison / unknown → default low; drops sticky high on model switch', () => {
    const { bridge } = makeEffortBridge();
    const puts: SessionSnapshot[] = [];
    const ref: { current: SessionSnapshot } = {
      current: { ...createEmptySession('s1'), reasoningEffort: 'high' },
    };
    const persist = (s: SessionSnapshot) => {
      ref.current = s;
      puts.push(s);
    };
    applySessionReasoning(ref.current, ['low', 'medium'], bridge, ref, persist, null);
    expect(bridge.getSelectedReasoning()).toBe('low');
    expect(ref.current.reasoningEffort).toBe('low');
    expect(puts[0]?.reasoningEffort).toBe('low');
  });
});

describe('foldPendingReasoningChange', () => {
  it('user pick high persists and acks', () => {
    const { bridge, exp } = makeEffortBridge();
    const ref = { current: createEmptySession('s1') };
    applySessionReasoning(ref.current, ['low', 'high', 'max'], bridge, ref, () => {}, null);
    expect(bridge.setSelectedReasoning('high')).toBe(true);
    exp.raisePending();
    const puts: SessionSnapshot[] = [];
    foldPendingReasoningChange(
      bridge,
      ref,
      (s) => {
        ref.current = s;
        puts.push(s);
      },
      null,
      false,
    );
    expect(puts[0]?.reasoningEffort).toBe('high');
    expect(bridge.hasPendingReasoningChange()).toBe(false);
  });

  it('discard acks without persist', () => {
    const { bridge, exp } = makeEffortBridge();
    exp.raisePending();
    discardPendingReasoningChange(bridge);
    expect(bridge.hasPendingReasoningChange()).toBe(false);
  });

  it('pending pick on session A does not land on session B', () => {
    const { bridge, exp } = makeEffortBridge();
    const a = createEmptySession('a');
    const b = createEmptySession('b');
    const ref: { current: SessionSnapshot } = { current: a };
    const puts: SessionSnapshot[] = [];
    const persist = (s: SessionSnapshot) => {
      ref.current = s;
      puts.push({ ...s });
    };
    applySessionReasoning(a, ['low', 'high', 'max'], bridge, ref, persist, null);
    expect(bridge.setSelectedReasoning('high')).toBe(true);
    exp.raisePending();
    // Adopt/switch order: fold pending onto CURRENT, then persist incoming,
    // then restore. Fold-after-persist would stamp `high` onto B.
    foldPendingReasoningChange(bridge, ref, persist, null, false);
    persist(b);
    applySessionReasoning(b, ['low', 'high', 'max'], bridge, ref, persist, null);
    expect(puts.some((s) => s.id === 'a' && s.reasoningEffort === 'high')).toBe(true);
    expect(ref.current.id).toBe('b');
    expect(ref.current.reasoningEffort).toBeUndefined();
    expect(bridge.getSelectedReasoning()).toBe('low');
    expect(bridge.hasPendingReasoningChange()).toBe(false);
  });
});

describe('HarnessHost wiring lock — applySessionReasoning must use writeLocalSessionMeta (adversarial-review #902 Major L1)', () => {
  it('applySessionReasoningFn persist arg is writeLocalSessionMeta, not writeLocalSession', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'app/harness/HarnessHost.tsx'),
      'utf-8',
    );
    expect(src).toContain(
      'const writeLocalSessionMeta = useCallback((next: SessionSnapshot, opts?: { paintQuota?: boolean }) => {',
    );
    // Poll path after a model change must not snap ringWindowStartRef.
    expect(src).toContain(
      'applySessionReasoningFn(snap, options, b, sessionRef, writeLocalSessionMeta, repoRef.current);',
    );
    expect(src).toContain(
      'foldPendingReasoningChangeFn(b, sessionRef, writeLocalSessionMeta, repoRef.current, inflightRef.current);',
    );
  });
});
