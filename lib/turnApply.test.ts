/**
 * E20 (plan #814) — unit tests for the shared `applyTurnEvent` consumer
 * (`lib/turnApply.ts`). Covers the plan's Testing rows 2, 3, 4:
 * - attach producer (cold, dedup) routes through one shared apply — tool /
 *   assistant / skill dedup, reasoning-never-skip, usage fold, done/error
 *   terminal (`sawStreamTerminal`).
 * - hot-resume parity: legacy (dedup off) vs attach (dedup on, no hydrated
 *   this-run) produce the IDENTICAL ring + session for the same event sequence.
 * - `streamPainted` fail-closed gate arms on every paint event and is never
 *   dropped.
 * Plus the E19 cursor lock: every parsed frame advances `heapC`
 * (including skipped-by-dedup) and persists as `turnStreamCursor`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  HARNESS_PROTOCOL_VERSION,
  HarnessBridge,
  INV_PING_XOR,
  MessageKind,
  StatusSlot,
  type HarnessBridgeExports,
} from './harnessBridge';
import type { AgentStreamEvent } from './agent/agentStream';
import type { UsageSummary } from './agent/usageSummary';
import {
  appendMessage,
  createEmptySession,
  type SessionSnapshot,
} from './sessionStore';
import { createToolRunGroup, decodeToolRun } from './toolRun';
import {
  closeThinkingSegment,
  createApplyTurnEvent,
  resetLiveToolStreak,
  type TurnApplyCtx,
} from './turnApply';

/** Same mock-exports pattern as `lib/harnessChat.test.ts` (real bridge semantics). */
function makeMockExports(): HarnessBridgeExports & {
  __messages: { kind: number; text: string }[];
  __statusSlots: (string | undefined)[];
} {
  let buf = new ArrayBuffer(64 * 1024);
  const memory = { get buffer() { return buf; } };
  let nextPtr = 1024;
  const messages: { kind: number; text: string }[] = [];
  const statusSlots: (string | undefined)[] = new Array(8).fill(undefined);

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
  const write = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    const ptr = gpa_u8(bytes.length);
    if (bytes.length > 0) new Uint8Array(buf, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  };

  return {
    memory,
    gpa_u8,
    gpa_free: () => {},
    inv_protocol_version: () => HARNESS_PROTOCOL_VERSION,
    inv_ping: (x: number) => (x | 0) ^ INV_PING_XOR,
    inv_set_lifecycle: () => {},
    inv_get_lifecycle: () => 1,
    inv_message_count: () => messages.length,
    inv_message_kind_at: (i: number) => messages[i]?.kind ?? 0,
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
    inv_clear_ring: () => {
      messages.length = 0;
    },
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
    inv_has_pending_cancel: () => 0,
    inv_ack_pending_cancel: () => {},
    inv_clear_model_catalog: () => {},
    inv_push_model_catalog_entry: () => 0,
    inv_model_catalog_count: () => 0,
    inv_selected_model_len: () => 0,
    inv_selected_model_copy: () => 0,
    inv_cycle_selected_model: () => 0,
    inv_set_selected_model: (_ptr, len) => (len <= 128 ? 1 : 0),
    inv_has_pending_model_change: () => 0,
    inv_ack_pending_model_change: () => {},
    inv_clear_session_catalog: () => {},
    inv_push_session_catalog_entry: () => 0,
    inv_session_catalog_count: () => 0,
    inv_set_current_session: () => 0,
    inv_has_pending_session_switch: () => 0,
    inv_pending_session_switch_len: () => 0,
    inv_pending_session_switch_copy: () => 0,
    inv_ack_pending_session_switch: () => {},
    inv_set_status_slot: (slot, ptr, len) => {
      if (slot < 0 || slot >= 8) return 0;
      if (len > 96) return 0;
      statusSlots[slot] = len === 0 ? undefined : read(ptr, len);
      return 1;
    },
    inv_status_slot_len: (slot) => {
      if (slot < 0 || slot >= 8 || statusSlots[slot] == null) return 0;
      return statusSlots[slot]!.length;
    },
    inv_status_slot_copy: (slot, outPtr, maxLen) => {
      if (slot < 0 || slot >= 8 || statusSlots[slot] == null) return 0;
      const v = statusSlots[slot]!;
      const n = Math.min(maxLen, v.length);
      if (n > 0) new Uint8Array(buf, outPtr, n).set(new TextEncoder().encode(v).slice(0, n));
      return n;
    },
    inv_status_slots_clear: () => {
      for (let i = 0; i < 8; i++) statusSlots[i] = undefined;
    },
    inv_set_turn_elapsed: () => {},
    inv_set_busy_tick: () => {},
    inv_image_cache_put: () => 0,
    inv_image_cache_clear: () => {},
    inv_math_cache_put: () => 0,
    inv_math_cache_clear: () => {},
    __messages: messages,
    __statusSlots: statusSlots,
  };
}

function makeBridge() {
  const exp = makeMockExports();
  return { exp, bridge: new HarnessBridge(exp) };
}

function makeCtx(
  session: SessionSnapshot = createEmptySession(),
  overrides: Partial<TurnApplyCtx> = {},
): TurnApplyCtx {
  return {
    next: session,
    heapC: 0,
    streamPainted: false,
    dedup: false,
    hydratedAssistant: '',
    hydratedTools: [],
    replayedStarts: {},
    replayedResults: {},
    toolRunGroup: createToolRunGroup(),
    openToolRunId: null,
    lastRingRowIsToolRun: false,
    lastUiKind: 'none',
    assistantStarted: false,
    assistantAcc: '',
    assistantSegment: '',
    assistantSegmentOpen: false,
    pendingAssistantWs: '',
    thinkingSegment: '',
    thinkingSegmentOpen: false,
    sawStreamTerminal: false,
    liveCwd: { value: undefined, source: undefined },
    patchSession: () => {},
    ...overrides,
  };
}

const ring = (exp: { __messages: { kind: number; text: string }[] }) =>
  exp.__messages.map((m) => ({ kind: m.kind, text: m.text }));

describe('applyTurnEvent — cursor + paint gate (E19/#813 + #759 locks)', () => {
  it('advances heapC and persists turnStreamCursor on EVERY parsed frame, including dedup-skipped', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx(createEmptySession(), {
      dedup: true,
      // Hydrated this-run tool: the cold-attach replay of the same call is skipped.
      hydratedTools: [{ name: 'exec', status: 'ok' }],
    });
    const apply = createApplyTurnEvent(bridge, ctx);

    await apply({ type: 'tool_start', name: 'exec' });
    expect(ctx.heapC).toBe(1);
    expect(ctx.next.turnStreamCursor).toBe(1);

    await apply({ type: 'tool_result', name: 'exec', ok: true, summary: 'done' });
    expect(ctx.heapC).toBe(2);
    expect(ctx.next.turnStreamCursor).toBe(2);

    // The hydrated call was skipped — no ring paint at all.
    expect(ring(exp)).toEqual([]);
    expect(ctx.toolRunGroup.items).toHaveLength(0);
  });

  it('arms streamPainted on every paint event (tool/text/reasoning/skill) and never on usage', async () => {
    const { bridge } = makeBridge();

    const usageCtx = makeCtx();
    await createApplyTurnEvent(bridge, usageCtx)({
      type: 'usage',
      usage: { source: 'provider', total: 10 },
    });
    expect(usageCtx.streamPainted).toBe(false);

    for (const ev of [
      { type: 'tool_start', name: 'exec' },
      { type: 'tool_result', name: 'exec', ok: true, summary: 'ok' },
      { type: 'reasoning_delta', text: 'hmm' },
      { type: 'text_delta', text: 'hi' },
      { type: 'skill_attached', slug: 'docs', action: 'attach', ok: true },
    ] as AgentStreamEvent[]) {
      const ctx = makeCtx();
      await createApplyTurnEvent(bridge, ctx)(ev);
      expect(ctx.streamPainted).toBe(true);
    }
  });

  it('reasoning_delta is NEVER skipped on cold attach (thinking not in Blob)', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx(createEmptySession(), { dedup: true });
    await createApplyTurnEvent(bridge, ctx)({ type: 'reasoning_delta', text: 'thinking out' });

    expect(ring(exp)).toEqual([{ kind: MessageKind.Thinking, text: 'thinking out' }]);
    expect(ctx.thinkingSegmentOpen).toBe(true);
    expect(ctx.thinkingSegment).toBe('thinking out');
  });
});

describe('applyTurnEvent — attach producer parity (plan row 2)', () => {
  it('usage folds the context slot live and persists via patchSession', async () => {
    const { exp, bridge } = makeBridge();
    const patchSession = vi.fn();
    const ctx = makeCtx(createEmptySession(), { patchSession });
    const usage: UsageSummary = { source: 'provider', prompt: 10, completion: 5, total: 15 };
    await createApplyTurnEvent(bridge, ctx)({ type: 'usage', usage });

    expect(ctx.next.usage).toEqual(usage);
    expect(exp.__statusSlots[StatusSlot.Context]).toContain('15');
    expect(patchSession).toHaveBeenCalledWith(ctx.next);
  });

  it('done is terminal: sawStreamTerminal set, thinking closed, assistant finalized', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx();
    const apply = createApplyTurnEvent(bridge, ctx);
    await apply({ type: 'reasoning_delta', text: 'hm' });
    await apply({ type: 'text_delta', text: 'Hello' });
    await apply({ type: 'done', text: 'Hello world' });

    expect(ctx.sawStreamTerminal).toBe(true);
    expect(ctx.thinkingSegmentOpen).toBe(false);
    expect(ctx.assistantAcc).toBe('Hello world');
    expect(ring(exp)).toEqual([
      { kind: MessageKind.Thinking, text: 'hm' },
      { kind: MessageKind.Assistant, text: 'Hello world' },
    ]);
  });

  it('error is terminal too: sawStreamTerminal set + thinking closed (no assistant push)', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx();
    const apply = createApplyTurnEvent(bridge, ctx);
    await apply({ type: 'reasoning_delta', text: 'hm' });
    await apply({ type: 'error', error: 'boom', status: 502 });

    expect(ctx.sawStreamTerminal).toBe(true);
    expect(ctx.thinkingSegmentOpen).toBe(false);
    expect(ring(exp)).toEqual([{ kind: MessageKind.Thinking, text: 'hm' }]);
  });

  it('cold-attach dedup: hydrated tool calls/results are skipped, hydrated assistant text is not re-pushed', async () => {
    const { exp, bridge } = makeBridge();
    // Realistic this-run window (rows after the last user line, as the host's
    // cold-attach hydrate computes them): a hydrated skill row — a cold replay
    // of the same stream must not duplicate it, nor re-push the hydrated
    // assistant text at `done`.
    let session = createEmptySession();
    session = appendMessage(session, 'user', 'go');
    session = appendMessage(session, 'skill_attached', 'Skill attached: docs');
    const ctx = makeCtx(session, {
      dedup: true,
      hydratedTools: [{ name: 'exec', status: 'ok' }],
      hydratedAssistant: 'already said',
    });
    const apply = createApplyTurnEvent(bridge, ctx);

    await apply({ type: 'tool_start', name: 'exec' });
    await apply({ type: 'tool_result', name: 'exec', ok: true, summary: 'ls -la' });
    await apply({ type: 'text_delta', text: 'already said' }); // replayed === hydrated → skip
    await apply({
      type: 'skill_attached',
      slug: 'docs',
      action: 'attach',
      ok: true,
      attachedSlugs: ['docs'],
    });
    await apply({ type: 'done', text: 'already said' });

    // Nothing painted — every event was dedup-skipped or terminal-quiet; the
    // hydrated rows live on the host-built ring, never duplicated here.
    expect(ring(exp)).toEqual([]);
    expect(ctx.assistantAcc).toBe('already said');
    expect(ctx.assistantStarted).toBe(true); // skip gate: no duplicate finalize push
    expect(ctx.sawStreamTerminal).toBe(true);
    // Sticky skill set still folds last-writes-wins (#517) even on the skip path.
    expect(ctx.next.attachedSlugs).toEqual(['docs']);
  });

  it('cold-attach grow-suffix: hydrated prefix is replayed exactly once, only the suffix grows', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx(createEmptySession(), {
      dedup: true,
      hydratedAssistant: 'Hello wor',
      lastUiKind: 'assistant',
      assistantSegmentOpen: true,
      assistantStarted: true,
      assistantSegment: 'Hello wor',
    });
    ctx.next = appendMessage(ctx.next, 'assistant', 'Hello wor');

    await createApplyTurnEvent(bridge, ctx)({ type: 'text_delta', text: 'Hello world' });

    expect(ctx.assistantAcc).toBe('Hello world');
    expect(ring(exp)).toEqual([{ kind: MessageKind.Assistant, text: 'Hello world' }]);
  });
});

describe('applyTurnEvent — producer parity (plan row 3)', () => {
  const EVENTS = [
    { type: 'skill_attached', slug: 'docs', action: 'attach', ok: true },
    { type: 'tool_start', name: 'exec' },
    { type: 'tool_result', name: 'exec', ok: true, summary: 'ls' },
    { type: 'reasoning_delta', text: 'thinking' },
    { type: 'text_delta', text: 'Answer' },
    { type: 'usage', usage: { source: 'provider', total: 42 } },
    { type: 'done', text: 'Answer final' },
  ] as AgentStreamEvent[];

  it('legacy (dedup off) and attach (dedup on, nothing hydrated) produce an identical ring + session', async () => {
    const legacy = makeBridge();
    const attach = makeBridge();
    const legacyCtx = makeCtx(createEmptySession());
    const attachCtx = makeCtx(createEmptySession(), { dedup: true });

    const legacyApply = createApplyTurnEvent(legacy.bridge, legacyCtx);
    const attachApply = createApplyTurnEvent(attach.bridge, attachCtx);
    for (const ev of EVENTS) {
      await legacyApply(ev);
      await attachApply(ev);
    }

    expect(ring(legacy.exp)).toEqual(ring(attach.exp));
    expect(legacyCtx.heapC).toBe(attachCtx.heapC);
    expect(legacyCtx.streamPainted).toBe(attachCtx.streamPainted);
    expect(legacyCtx.sawStreamTerminal).toBe(attachCtx.sawStreamTerminal);
    expect(legacyCtx.assistantAcc).toBe(attachCtx.assistantAcc);
    expect(JSON.stringify(legacyCtx.toolRunGroup)).toBe(
      JSON.stringify(attachCtx.toolRunGroup),
    );
    // `id`/`at`/`updatedAt` are stamped with `Date.now()` in two independent
    // makeCtx calls — volatile noise, not behavior. Blank all three so the
    // comparison locks STRUCTURE (roles/texts/order), not clock skew.
    const strip = (s: SessionSnapshot) =>
      JSON.stringify({
        ...s,
        id: '',
        updatedAt: 0,
        messages: s.messages.map((m) => ({ ...m, id: '', at: 0 })),
      });
    expect(strip(legacyCtx.next)).toBe(strip(attachCtx.next));
  });
});

describe('applyTurnEvent — streamPainted fail-closed gate (plan row 4)', () => {
  it('arms on paint events and stays armed (monotonic within the turn)', async () => {
    const { bridge } = makeBridge();
    const ctx = makeCtx();
    const apply = createApplyTurnEvent(bridge, ctx);
    await apply({ type: 'text_delta', text: 'painted' });
    expect(ctx.streamPainted).toBe(true);
    await apply({ type: 'usage', usage: { source: 'provider', total: 1 } });
    expect(ctx.streamPainted).toBe(true);
    await apply({ type: 'done', text: 'painted' });
    expect(ctx.streamPainted).toBe(true);
  });
});

describe('applyTurnEvent — live tool card (protocol v11 / #433)', () => {
  it('paints ONE kind-6 card per event and completes the running item on the result', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx();
    const apply = createApplyTurnEvent(bridge, ctx);

    await apply({ type: 'tool_start', name: 'exec' });
    expect(ring(exp)).toHaveLength(1);
    expect(ring(exp)[0]!.kind).toBe(MessageKind.ToolRun);
    expect(ctx.lastRingRowIsToolRun).toBe(true);
    expect(ctx.openToolRunId).not.toBeNull();
    expect(ctx.lastUiKind).toBe('tool_run');

    await apply({ type: 'tool_result', name: 'exec', ok: true, summary: 'ls -la' });
    // Same card grown in place — still exactly one row.
    expect(ring(exp)).toHaveLength(1);
    const decoded = decodeToolRun(ring(exp)[0]!.text);
    expect(decoded?.items).toHaveLength(1);
    expect(decoded?.items[0]?.status).toBe('ok');
    // Session mirrors the ring (appendMessage on the open card's start).
    expect(ctx.next.messages).toHaveLength(1);
    expect(ctx.next.messages[0]?.role).toBe('tool_run');
  });

  it('a confirmed change_dir records live cwd, folds the status slot, and patches the session', async () => {
    const { exp, bridge } = makeBridge();
    const patchSession = vi.fn();
    const session = { ...createEmptySession(), cwd: 'src' };
    const ctx = makeCtx(session, { patchSession });
    const apply = createApplyTurnEvent(bridge, ctx);

    await apply({ type: 'tool_start', name: 'change_dir' });
    await apply({
      type: 'tool_result',
      name: 'change_dir',
      ok: true,
      summary: 'change_dir docs: ok cwd=docs',
      changeDirCwd: 'docs',
    });

    expect(ctx.liveCwd).toEqual({ value: 'docs', source: 'confirmed' });
    expect(ctx.next.cwd).toBe('docs');
    expect(exp.__statusSlots[StatusSlot.Cwd]).toBe('docs');
    expect(patchSession).toHaveBeenCalled();
  });

  it('a successful meta_sandbox_switch applies the Redis-safe bind mid-turn', async () => {
    const { exp, bridge } = makeBridge();
    const patchSession = vi.fn();
    const ctx = makeCtx(createEmptySession(), { patchSession });
    const apply = createApplyTurnEvent(bridge, ctx);

    await apply({ type: 'tool_start', name: 'meta_sandbox_switch' });
    await apply({
      type: 'tool_result',
      name: 'meta_sandbox_switch',
      ok: true,
      summary: 'switched',
      activeSandboxId: 'sbx_abc123',
    });

    expect(ctx.next.activeSandboxId).toBe('sbx_abc123');
    expect(exp.__statusSlots[StatusSlot.Sandbox]).toContain('sbx_abc123');
    expect(patchSession).toHaveBeenCalled();
  });

  it('a non-Redis-safe switch id is ignored (fail-closed, no session mutation)', async () => {
    const { bridge } = makeBridge();
    const ctx = makeCtx(createEmptySession());
    const apply = createApplyTurnEvent(bridge, ctx);

    await apply({ type: 'tool_start', name: 'meta_sandbox_switch' });
    await apply({
      type: 'tool_result',
      name: 'meta_sandbox_switch',
      ok: true,
      summary: 'switched',
      activeSandboxId: 'bad id with spaces!',
    });

    expect(ctx.next.activeSandboxId).toBeUndefined();
  });
});

describe('applyTurnEvent — provider tool-call id + finishReason (upstream #881 re-thread)', () => {
  it('threads tool_start/tool_result ids into the kind-6 card as the 6th encode column', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx();
    const apply = createApplyTurnEvent(bridge, ctx);

    await apply({ type: 'tool_start', name: 'exec', id: 'call_1' });
    await apply({ type: 'tool_result', name: 'exec', ok: true, summary: 'ls', id: 'call_1' });

    const decoded = decodeToolRun(ring(exp)[0]!.text);
    expect(decoded?.items).toHaveLength(1);
    expect(decoded?.items[0]).toMatchObject({ name: 'exec', status: 'ok', callId: 'call_1' });
  });

  it('a completion-order result with an id and no running pair still lands as its own item', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx();
    const apply = createApplyTurnEvent(bridge, ctx);

    await apply({ type: 'tool_result', name: 'exec', ok: false, summary: 'boom', id: 'call_9' });

    const decoded = decodeToolRun(ring(exp)[0]!.text);
    expect(decoded?.items[0]).toMatchObject({ name: 'exec', status: 'fail', callId: 'call_9' });
  });

  it('cold-attach dedup prefers callId: a hydrated RUNNING call with the same id still grows on its result', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx(createEmptySession(), {
      dedup: true,
      hydratedTools: [{ name: 'exec', status: 'running', callId: 'call_7' }],
    });
    const apply = createApplyTurnEvent(bridge, ctx);

    await apply({ type: 'tool_start', name: 'exec', id: 'call_7' }); // skip by id
    await apply({
      type: 'tool_result',
      name: 'exec',
      ok: true,
      summary: 'done',
      id: 'call_7',
    }); // running → still grows

    expect(ring(exp)).toHaveLength(1);
    const decoded = decodeToolRun(ring(exp)[0]!.text);
    expect(decoded?.items[0]).toMatchObject({ status: 'ok', callId: 'call_7' });
  });

  it('cold-attach dedup: a hydrated TERMINAL call with the same id skips BOTH start and result', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx(createEmptySession(), {
      dedup: true,
      hydratedTools: [{ name: 'exec', status: 'ok', callId: 'call_7' }],
    });
    const apply = createApplyTurnEvent(bridge, ctx);

    await apply({ type: 'tool_start', name: 'exec', id: 'call_7' });
    await apply({ type: 'tool_result', name: 'exec', ok: true, summary: 'done', id: 'call_7' });

    expect(ring(exp)).toEqual([]);
  });

  it('done captures finishReason for the truncated-finish conversion; absent stays undefined', async () => {
    const { bridge } = makeBridge();

    const a = makeCtx();
    await createApplyTurnEvent(bridge, a)({ type: 'done', text: 'x', finishReason: 'length' });
    expect(a.doneFinishReason).toBe('length');

    const b = makeCtx();
    await createApplyTurnEvent(bridge, b)({ type: 'done', text: 'x' });
    expect(b.doneFinishReason).toBeUndefined();
  });
});

describe('turn-end helpers (safety-net parity)', () => {
  it('closeThinkingSegment keeps the full monologue and clears the open flag; no-op when closed', async () => {
    const { exp, bridge } = makeBridge();
    const ctx = makeCtx();
    const apply = createApplyTurnEvent(bridge, ctx);
    await apply({ type: 'reasoning_delta', text: 'deep thought' });

    closeThinkingSegment(bridge, ctx);
    expect(ctx.thinkingSegmentOpen).toBe(false);
    expect(ctx.thinkingSegment).toBe('');
    // Kept verbatim (soft-trim is identity under MAX_MSG_LEN).
    expect(ring(exp)).toEqual([{ kind: MessageKind.Thinking, text: 'deep thought' }]);

    // Second call is a no-op.
    closeThinkingSegment(bridge, ctx);
    expect(ring(exp)).toEqual([{ kind: MessageKind.Thinking, text: 'deep thought' }]);
  });

  it('resetLiveToolStreak clears the open card state so the next tool opens fresh', async () => {
    const { bridge } = makeBridge();
    const ctx = makeCtx();
    await createApplyTurnEvent(bridge, ctx)({ type: 'tool_start', name: 'exec' });
    expect(ctx.lastRingRowIsToolRun).toBe(true);

    resetLiveToolStreak(ctx);

    expect(ctx.lastRingRowIsToolRun).toBe(false);
    expect(ctx.openToolRunId).toBeNull();
    expect(ctx.toolRunGroup.items).toHaveLength(0);
  });
});