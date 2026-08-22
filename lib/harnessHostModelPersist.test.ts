/**
 * Plan #616 (source #610) — minimum-locked test rows 8, 9, 10 (and row 3
 * fold-stamp half) for the host-side model-persist wiring extracted into
 * lib/harnessHostModelPersist.ts. Uses the same mock-bridge pattern as
 * lib/harnessBridge.test.ts + lib/harnessChat.test.ts — no React render.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessBridge,
  INV_PING_XOR,
  Lifecycle,
  MessageKind,
  type HarnessBridgeExports,
} from './harnessBridge';
import type { IdSessionRepository, CloudPutResult, CloudGetResult } from './sessionRepository';
import {
  createEmptySession,
  type SessionSnapshot,
  type SessionStore,
} from './sessionStore';
import {
  applySessionModel,
  foldPendingModelChange,
  flushPendingThenRestore,
  discardPendingModelChange,
  type ModelPersistSessionRef,
} from './harnessHostModelPersist';

// ---------------------------------------------------------------------------
// mock bridge exports — same shape as harnessBridge.test.ts makeMockExports,
// but just the model-catalog subset we need + required exports.
// ---------------------------------------------------------------------------

type MockExtras = {
  __messages: { kind: number; text: string }[];
  __setCancelPending: (on: boolean) => void;
  __setModelPending: (on: boolean) => void;
  __modelPending: () => boolean;
  __setPending: (s: string | null) => void;
  __setLoadEarlierPending: (on: boolean) => void;
  /** Mirrors Zig `setSelectedModel(index)` — the #617 picker path. */
  __selectByIndex: (index: number) => void;
};

function makeMockExports(overrides?: Partial<HarnessBridgeExports>): HarnessBridgeExports & MockExtras {
  let buf = new ArrayBuffer(64 * 1024);
  const memory = { get buffer() { return buf; } };
  let nextPtr = 1024;
  let lifecycle = Lifecycle.Boot;
  const messages: { kind: number; text: string }[] = [];
  let cancelPending = false;
  let pending: string | null = null;
  let modelPending = false;
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

  const read = (ptr: number, len: number) =>
    new TextDecoder().decode(new Uint8Array(buf, ptr, len));

  const write = (ptr: number, text: string) => {
    const bytes = new TextEncoder().encode(text);
    new Uint8Array(buf, ptr, bytes.length).set(bytes);
  };

  const base: HarnessBridgeExports & MockExtras = {
    memory,
    gpa_u8,
    gpa_free: () => {},
    inv_protocol_version: () => HARNESS_PROTOCOL_VERSION,
    inv_ping: (x: number) => (x | 0) ^ INV_PING_XOR,
    inv_set_lifecycle: (s: number) => { lifecycle = s as Lifecycle; },
    inv_get_lifecycle: () => lifecycle,
    inv_message_count: () => messages.length,
    inv_message_kind_at: (i: number) => (messages[i]?.kind ?? 0),
    inv_message_text_len_at: (i: number) =>
      new TextEncoder().encode(messages[i]?.text ?? '').length,
    inv_message_text_copy_at: (i: number, outPtr: number, maxLen: number) => {
      const text = messages[i]?.text ?? '';
      const n = Math.min(maxLen, text.length);
      if (n > 0) write(outPtr, text.slice(0, n));
      return n;
    },
    inv_begin_batch: () => {},
    inv_end_batch: () => {},
    inv_push_message: (kind: number, ptr: number, len: number) => {
      messages.push({ kind, text: len === 0 ? '' : read(ptr, len) });
    },
    inv_update_last_message: () => 0,
    inv_clear_messages: () => { messages.length = 0; },
    inv_echo: () => 0,
    inv_echo_len: () => 0,
    inv_echo_copy: () => 0,
    inv_has_pending_submit: () => 0,
    inv_pending_submit_len: () => 0,
    inv_pending_submit_copy: () => 0,
    inv_ack_pending_submit: () => {},
    inv_queued_count: () => 0,
    inv_set_queue_promote_allowed: () => {},
    inv_queued_insert_front: () => 1,
    inv_set_can_load_earlier: () => {},
    inv_has_pending_load_earlier: () => 0,
    inv_ack_pending_load_earlier: () => {},
    inv_has_pending_cancel: () => (cancelPending ? 1 : 0),
    inv_ack_pending_cancel: () => { cancelPending = false; },
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
      modelPending = true;
      return selected;
    },
    inv_set_selected_model: (ptr, len) => {
      if (len > 128) return 0;
      const id = len === 0 ? null : read(ptr, len);
      if (id != null && /[\x00-\x20\x7f-\xff]/.test(id)) return 0;
      if (id == null) {
        selected = 0;
        return 1;
      }
      const i = catalog.indexOf(id);
      selected = i >= 0 ? i : 0;
      return 1;
    },
    inv_has_pending_model_change: () => (modelPending ? 1 : 0),
    inv_ack_pending_model_change: () => { modelPending = false; },
    inv_clear_session_catalog: () => {},
    inv_push_session_catalog_entry: () => 0,
    inv_session_catalog_count: () => 0,
    inv_set_current_session: () => 0,
    inv_has_pending_session_switch: () => 0,
    inv_pending_session_switch_len: () => 0,
    inv_pending_session_switch_copy: () => 0,
    inv_ack_pending_session_switch: () => {},
    inv_set_status_slot: () => 0,
    inv_status_slot_len: () => 0,
    inv_status_slot_copy: () => 0,
    inv_status_slots_clear: () => {},
    inv_set_turn_elapsed: () => {},
    inv_set_busy_tick: () => {},
    inv_image_cache_put: () => 0,
    inv_image_cache_clear: () => {},
    inv_math_cache_put: () => 0,
    inv_math_cache_clear: () => {},
    __messages: messages,
    __setCancelPending: (on: boolean) => { cancelPending = !!on; },
    __setModelPending: (on: boolean) => { modelPending = !!on; },
    __modelPending: () => modelPending,
    __setPending: (s: string | null) => { pending = s; },
    __setLoadEarlierPending: () => {},
    __selectByIndex: (index: number) => {
      if (catalog.length === 0 || index < 0 || index >= catalog.length) return;
      if (index === selected) return;
      selected = index;
      modelPending = true;
    },
  };

  return {
    ...base,
    ...overrides,
    __messages: messages,
    __setCancelPending: base.__setCancelPending,
    __setModelPending: base.__setModelPending,
    __modelPending: base.__modelPending,
  };
}

function makeMockRepo(): IdSessionRepository & { lastPut: { id: string; snap: SessionSnapshot } | null } {
  const repo: IdSessionRepository & { lastPut: { id: string; snap: SessionSnapshot } | null } = {
    enabled: true,
    carrier: 'rollforward' as const,
    lastPut: null,
    get: vi.fn(async (): Promise<CloudGetResult> => ({ action: 'notfound' })),
    put: vi.fn((id: string, snapshot: SessionSnapshot) => {
      repo.lastPut = { id, snap: { ...snapshot } };
    }),
    list: vi.fn(async () => ({ action: 'disabled' as const })),
    create: vi.fn(async () => ({ action: 'disabled' as const })),
    createFirst: vi.fn(async () => ({ action: 'disabled' as const })),
    remove: vi.fn(async () => {}),
    mintUpload: vi.fn(async () => ({ action: 'disabled' as const })),
    putTranscriptObject: vi.fn(async () => false),
    pushEnvelope: vi.fn(async () => ({ action: 'disabled' as const })),
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Row 8: boot with stored id IN catalog → restore-by-id, snapshot keeps it
// ---------------------------------------------------------------------------

describe('applySessionModel — row 8: stored id is in catalog', () => {
  it('restores by id and keeps the field in the snapshot', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['anthropic/claude-a', 'openai/gpt-b']);

    const ref: ModelPersistSessionRef = {
      current: { ...createEmptySession('s1'), selectedModel: 'openai/gpt-b' },
    };
    let persisted: SessionSnapshot | null = null;
    const persist = (next: SessionSnapshot) => { persisted = next; };
    const repo = makeMockRepo();

    applySessionModel(ref.current, bridge, ref, persist, repo);

    // The stored id is in the catalog → getSelectedModel returns it.
    expect(bridge.getSelectedModel()).toBe('openai/gpt-b');
    // No drop — persist was NOT called (no revoke).
    expect(persisted).toBeNull();
    expect(repo.lastPut).toBeNull();
    // Snapshot still has the field (the ref was never mutated to delete it).
    expect(ref.current.selectedModel).toBe('openai/gpt-b');
  });
});

// ---------------------------------------------------------------------------
// Row 9: revoked/absent id → default AND drop from snapshot
// ---------------------------------------------------------------------------

describe('applySessionModel — row 9: stored id NOT in catalog (revoked)', () => {
  it('drops the stored id from the snapshot and persists immediately', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['anthropic/claude-a', 'openai/gpt-b']);

    const originalUpdatedAt = 1723843200000;
    const ref: ModelPersistSessionRef = {
      current: { ...createEmptySession('s1'), selectedModel: 'revoked/old', updatedAt: originalUpdatedAt },
    };
    let persisted: SessionSnapshot | null = null;
    const persist = (next: SessionSnapshot) => { persisted = next; };
    const repo = makeMockRepo();

    applySessionModel(ref.current, bridge, ref, persist, repo);

    // Wasm fell back to index 0 (the first catalog entry).
    expect(bridge.getSelectedModel()).toBe('anthropic/claude-a');
    // The stored id was DROPPED from the session ref.
    expect(ref.current.selectedModel).toBeUndefined();
    // Local persist called with the dropped snapshot.
    expect(persisted).not.toBeNull();
    expect(persisted!.selectedModel).toBeUndefined();
    // updatedAt stamped fresher on both the local persist AND the cloud PUT
    // so LWW peers and shouldAdoptBootServer see the drop (same stamp
    // convention as foldPendingModelChange).
    expect(persisted!.updatedAt).toBeGreaterThan(originalUpdatedAt);
    // Cloud PUT called.
    expect(repo.lastPut).not.toBeNull();
    expect(repo.lastPut!.id).toBe('s1');
    expect(repo.lastPut!.snap.selectedModel).toBeUndefined();
    expect(repo.lastPut!.snap.updatedAt).toBe(persisted!.updatedAt);
  });

  it('does NOT drop on a catalog that failed to load (getSelectedModel returns null)', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // Empty catalog — getSelectedModel() returns null (catalog empty / failed).
    // simulate: no entries, selected = 0, len = 0.

    const ref: ModelPersistSessionRef = {
      current: { ...createEmptySession('s1'), selectedModel: 'revoked/old' },
    };
    let persisted: SessionSnapshot | null = null;
    const persist = (next: SessionSnapshot) => { persisted = next; };
    const repo = makeMockRepo();

    applySessionModel(ref.current, bridge, ref, persist, repo);

    // getSelectedModel returns null (catalog empty → no model string).
    expect(bridge.getSelectedModel()).toBeNull();
    // Snapshot still has the stored id — we never dropped on transport failure.
    expect(ref.current.selectedModel).toBe('revoked/old');
    expect(persisted).toBeNull();
    expect(repo.lastPut).toBeNull();
  });

  it('skips drop when stored id is undefined / absent (no-op, no persist)', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['anthropic/claude-a']);

    const ref: ModelPersistSessionRef = {
      current: { ...createEmptySession('s1') }, // no selectedModel
    };
    let persisted: SessionSnapshot | null = null;
    const persist = (next: SessionSnapshot) => { persisted = next; };
    const repo = makeMockRepo();

    applySessionModel(ref.current, bridge, ref, persist, repo);

    // Falls through — setSelectedModel(null) resets to index 0.
    expect(bridge.getSelectedModel()).toBe('anthropic/claude-a');
    expect(ref.current.selectedModel).toBeUndefined();
    expect(persisted).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 10: New/Clear → setSelectedModel(null), index 0, omit field
// ---------------------------------------------------------------------------

describe('applySessionModel — row 10: New/Clear (no stored id)', () => {
  it('starts on default model and omits selectedModel from snapshot', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['anthropic/claude-a', 'openai/gpt-b']);

    const ref: ModelPersistSessionRef = {
      current: createEmptySession('new'), // no selectedModel
    };
    const repo = makeMockRepo();

    // This simulates the New/Clear host path: applySessionModel on a fresh
    // empty session (selectedModel absent). The host first calls
    // bridge.setSelectedModel(null) separately (part of resetBridge), then
    // on the boot path applySessionModel hits. The function itself just
    // calls setSelectedModel(null) → Wasm index 0, and no persist (null id).
    applySessionModel(ref.current, bridge, ref, () => {}, repo);

    expect(bridge.getSelectedModel()).toBe('anthropic/claude-a');
    // Snapshot never had the field — still absent.
    expect(ref.current.selectedModel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Row 3 fold-stamp: foldPendingModelChange stamps updatedAt > original
// ---------------------------------------------------------------------------

describe('foldPendingModelChange — row 3: stamp updatedAt on Next-cycle persist', () => {
  it('stamps updatedAt: Date.now() and persists local + cloud', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['anthropic/claude-a', 'openai/gpt-b']);
    // User cycled Next — pending flag is raised, live model is now gpt-b.
    bridge.cycleSelectedModel(); // modelPending=true, selected=1 → 'openai/gpt-b'
    expect(bridge.hasPendingModelChange()).toBe(true);
    expect(bridge.getSelectedModel()).toBe('openai/gpt-b');

    const originalUpdatedAt = 1723843200000;
    const ref: ModelPersistSessionRef = {
      current: {
        ...createEmptySession('s1'),
        updatedAt: originalUpdatedAt,
        selectedModel: 'anthropic/claude-a',
      },
    };
    let persisted: SessionSnapshot | null = null;
    const persist = (next: SessionSnapshot) => { persisted = next; };
    const repo = makeMockRepo();

    foldPendingModelChange(bridge, ref, persist, repo, false);

    // Flag is acked.
    expect(bridge.hasPendingModelChange()).toBe(false);
    // Persisted snapshot has the new live model and a FRESHER updatedAt.
    expect(persisted).not.toBeNull();
    expect(persisted!.selectedModel).toBe('openai/gpt-b');
    expect(persisted!.updatedAt).toBeGreaterThan(originalUpdatedAt);
    // Cloud PUT called with the fresher timestamp.
    expect(repo.lastPut).not.toBeNull();
    expect(repo.lastPut!.id).toBe('s1');
    expect(repo.lastPut!.snap.updatedAt).toBe(persisted!.updatedAt);
    expect(repo.lastPut!.snap.selectedModel).toBe('openai/gpt-b');
  });

  it('skips when NOT inflight but no pending flag (no-op)', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['a/m1']);

    const ref: ModelPersistSessionRef = {
      current: { ...createEmptySession('s1'), selectedModel: 'a/m1' },
    };
    let persisted: SessionSnapshot | null = null;
    const persist = (next: SessionSnapshot) => { persisted = next; };
    const repo = makeMockRepo();

    foldPendingModelChange(bridge, ref, persist, repo, false);

    // No pending flag → no persist.
    expect(persisted).toBeNull();
    expect(repo.lastPut).toBeNull();
    expect(ref.current.selectedModel).toBe('a/m1');
  });

  it('skips when inflight (turn running, caller gates before the bridge guard)', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['a/m1', 'b/m2']);
    bridge.cycleSelectedModel(); // pending=true

    const ref: ModelPersistSessionRef = {
      current: { ...createEmptySession('s1'), selectedModel: 'a/m1' },
    };
    let persisted: SessionSnapshot | null = null;
    const persist = (next: SessionSnapshot) => { persisted = next; };
    const repo = makeMockRepo();

    foldPendingModelChange(bridge, ref, persist, repo, true); // inflight=true

    // Skipped — pending flag still raised, no persist.
    expect(bridge.hasPendingModelChange()).toBe(true);
    expect(persisted).toBeNull();
    expect(repo.lastPut).toBeNull();
  });

  it('persists normally — no identity guard (removed tautology, PR #618 review #6)', () => {
    // The prior identity guard (next.id !== sessionRef.current.id) was a
    // tautology: `next` is spread from `sessionRef.current` so the ids
    // always match. JS is single-threaded and the poll handler reads the
    // flag/folds/acks atomically — no other callback can change the session
    // id between the flag read and this fold. Removed in PR #618 review #6.
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['a/m1', 'b/m2']);
    bridge.cycleSelectedModel(); // pending=true

    const ref: ModelPersistSessionRef = {
      current: { ...createEmptySession('s1'), selectedModel: 'a/m1' },
    };
    let persisted: SessionSnapshot | null = null;
    const persist = (next: SessionSnapshot) => { persisted = next; };
    const repo = makeMockRepo();

    foldPendingModelChange(bridge, ref, persist, repo, false);

    // Normal flow: persisted with live model and flag acked.
    expect(persisted).not.toBeNull();
    expect(persisted!.selectedModel).toBe('b/m2');
    expect(bridge.hasPendingModelChange()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge: null/absent live model on fold (should not happen, but safe)
// ---------------------------------------------------------------------------

describe('foldPendingModelChange — edge cases', () => {
  it('deletes selectedModel when live model is null/empty (empty catalog edge)', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    // No catalog → getSelectedModel() returns null.
    exp.__setModelPending(true);

    const ref: ModelPersistSessionRef = {
      current: { ...createEmptySession('s1'), selectedModel: 'old/id' },
    };
    let persisted: SessionSnapshot | null = null;
    const persist = (next: SessionSnapshot) => { persisted = next; };

    foldPendingModelChange(bridge, ref, persist, null, false);

    expect(persisted).not.toBeNull();
    expect(persisted!.selectedModel).toBeUndefined();
    expect(bridge.hasPendingModelChange()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PR #618 re-run 5 Minor L1: flush pick onto current before adopt/switch
// ---------------------------------------------------------------------------

describe('flushPendingThenRestore — pick then switch does not lose the pick', () => {
  it('persists Y on s1, restores s2, acks (picker index setter)', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['anthropic/claude-a', 'openai/gpt-b']);

    const ref: ModelPersistSessionRef = {
      current: {
        ...createEmptySession('s1'),
        updatedAt: 100,
        selectedModel: 'anthropic/claude-a',
      },
    };
    const puts: { id: string; selectedModel?: string }[] = [];
    const persist = (next: SessionSnapshot) => {
      puts.push({ id: next.id, selectedModel: next.selectedModel });
      ref.current = next;
    };
    const repo = makeMockRepo();

    // Status-bar menu pick (Zig setSelectedModel(index)), not Next cycle.
    exp.__selectByIndex(1);
    expect(bridge.hasPendingModelChange()).toBe(true);
    expect(bridge.getSelectedModel()).toBe('openai/gpt-b');

    const incoming: SessionSnapshot = {
      ...createEmptySession('s2'),
      updatedAt: 200,
      selectedModel: 'anthropic/claude-a',
    };
    flushPendingThenRestore(incoming, bridge, ref, persist, repo, false);

    expect(bridge.hasPendingModelChange()).toBe(false);
    expect(bridge.getSelectedModel()).toBe('anthropic/claude-a');
    expect(ref.current.id).toBe('s2');
    expect(puts[0]).toEqual({ id: 's1', selectedModel: 'openai/gpt-b' });
    expect(puts[1]?.id).toBe('s2');
    expect(repo.lastPut?.id).toBe('s1');
    expect(repo.lastPut?.snap.selectedModel).toBe('openai/gpt-b');
  });

  it('is a no-op fold when nothing is pending, then restores incoming', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['anthropic/claude-a', 'openai/gpt-b']);
    const ref: ModelPersistSessionRef = {
      current: { ...createEmptySession('s1'), selectedModel: 'anthropic/claude-a' },
    };
    const persist = (next: SessionSnapshot) => {
      ref.current = next;
    };
    flushPendingThenRestore(
      { ...createEmptySession('s2'), selectedModel: 'openai/gpt-b' },
      bridge,
      ref,
      persist,
      makeMockRepo(),
      false,
    );
    expect(ref.current.id).toBe('s2');
    expect(bridge.getSelectedModel()).toBe('openai/gpt-b');
    expect(bridge.hasPendingModelChange()).toBe(false);
  });
});

describe('discardPendingModelChange — Clear must not PUT', () => {
  it('acks a pending pick without persisting', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['anthropic/claude-a', 'openai/gpt-b']);
    exp.__selectByIndex(1);
    expect(bridge.hasPendingModelChange()).toBe(true);
    discardPendingModelChange(bridge);
    expect(bridge.hasPendingModelChange()).toBe(false);
    expect(bridge.getSelectedModel()).toBe('openai/gpt-b');
  });
});

describe('picker index setter vs restore-by-id (PR #618 re-run 5 Minor L6)', () => {
  it('__selectByIndex raises pending; setSelectedModel(id) does not', () => {
    const exp = makeMockExports();
    const bridge = new HarnessBridge(exp);
    bridge.setModelCatalog(['anthropic/claude-a', 'openai/gpt-b']);
    exp.__selectByIndex(1);
    expect(bridge.hasPendingModelChange()).toBe(true);
    expect(bridge.getSelectedModel()).toBe('openai/gpt-b');
    bridge.ackPendingModelChange();
    expect(bridge.setSelectedModel('anthropic/claude-a')).toBe(true);
    expect(bridge.hasPendingModelChange()).toBe(false);
    expect(bridge.getSelectedModel()).toBe('anthropic/claude-a');
  });
});

describe('HarnessHost wiring lock — foldPendingModelChange must use writeLocalSessionMeta (PR #618 re-run 7 Nit L6)', () => {
  it('foldPendingModelChangeFn is called with writeLocalSessionMeta, not writeLocalSession', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'app/harness/HarnessHost.tsx'),
      'utf-8',
    );
    // Assert the meta-only persist helper exists (avoids a false pass on a
    // source that renamed both sides of the wiring).
    expect(src).toContain(
      'const writeLocalSessionMeta = useCallback((next: SessionSnapshot) => {',
    );
    // Lock: foldPendingModelChangeFn's persist arg is writeLocalSessionMeta.
    // If someone dedupes and points back at writeLocalSession, this fails.
    expect(src).toContain(
      'foldPendingModelChangeFn(b, sessionRef, writeLocalSessionMeta, repoRef.current, inflightRef.current);',
    );
    // Double-check: the fold's own deps array also locks the name.
    expect(src).toContain('}, [writeLocalSessionMeta]);');
  });
});
