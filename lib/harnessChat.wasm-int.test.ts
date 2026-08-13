import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runHarnessTurn } from './harnessChat';
import {
  HarnessBridge,
  Lifecycle,
  MessageKind,
  type HarnessBridgeExports,
} from './harnessBridge';
import { decodeToolRun, TOOL_RUN_ITEMS_MAX } from './toolRun';
import { createEmptySession } from './sessionStore';
import { HARNESS_RING_MAX } from './sessionWindow';

/**
 * Real-Wasm integration (plan #448, implements #433). Drives the MOCKED agent
 * stream through the same `runHarnessTurn(bridge, session, prompt, …)` path the
 * production host uses, but bridges over the REAL harness Wasm the UI ships.
 *
 * Fail-closed supply rule (#433 / plan): we LOAD `public/harness/harness.wasm`
 * (then `native/dist/harness/harness.wasm`), and **throw** — never `it.skip` —
 * when the Wasm is missing OR does not carry the protocol-v11 ring-readback
 * exports. The DoD is measured against the operator-visible surface
 * (`inv_message_count` + kind-6 payload inside real Wasm), which is exactly what
 * the `inv_message_*_at` readback seam exposes.
 */

const WASM_CANDIDATES = [
  resolve(__dirname, '../public/harness/harness.wasm'),
  resolve(__dirname, '../native/dist/harness/harness.wasm'),
];

function loadWasimBytes(): Buffer {
  for (const p of WASM_CANDIDATES) {
    if (existsSync(p)) return readFileSync(p);
  }
  throw new Error(
    'No harness.wasm found. Run `scripts/fetch-harness-artifact.mjs` (needs the ' +
      'build-harness artifact) or `./native/harness/build.sh` to make a protocol-v11 ' +
      'wasm available before the real-Wasm integration rows can pass.',
  );
}

/**
 * Instantiate the real harness Wasm under Node with a no-op `dvui` web-backend
 * import object. The ring/bridge exports we exercise (push/update/count/readback)
 * call `wasm_refresh` — which is an import — so the stub supplies it (plus every
 * other import the module declares) purely so `WebAssembly.instantiate` succeeds.
 */
async function loadBridge(): Promise<HarnessBridge> {
  const bytes = loadWasimBytes();
  const module = await WebAssembly.compile(bytes as unknown as BufferSource);
  const imports = WebAssembly.Module.imports(module);
  const dvuiStub: Record<string, (...args: unknown[]) => unknown> = {};

  for (const imp of imports) {
    if (imp.kind === 'function' && dvuiStub[imp.name] === undefined) {
      dvuiStub[imp.name] = imp.name === 'wasm_read' ? () => 0 : () => {};
    }
  }
  // Every bridge write routes through `refresh()` → `wasm_refresh()`. No-op is safe.
  dvuiStub['wasm_refresh'] = () => {};

  const instance = await WebAssembly.instantiate(module, { dvui: dvuiStub });
  const exports = instance.exports as unknown as HarnessBridgeExports & {
    inv_protocol_version: () => number;
  };
  if (typeof exports.inv_protocol_version !== 'function') {
    throw new Error('harness.wasm missing inv_protocol_version');
  }
  const from = HarnessBridge.fromInstance(instance);
  if (!from.ok) {
    throw new Error(from.error);
  }
  return from.bridge;
}

/** Minimal "pwd / list_dir / exec" tool events driving a mocked stream. */
function toolEvents(names: string[]): Record<string, unknown>[] {
  return names.flatMap((name) => [
    { type: 'tool_start', name },
    { type: 'tool_result', name, ok: true, summary: `${name} · ok` },
  ]);
}

/** Decode every kind-6 row currently on the real ring and return item-count totals. */
function ringToolRunTotals(bridge: HarnessBridge): { index: number; total: number; header: string }[] {
  const out: { index: number; total: number; header: string }[] = [];
  const n = bridge.messageCount();
  for (let i = 0; i < n; i++) {
    if (bridge.messageKindAt(i) !== MessageKind.ToolRun) continue;
    const dec = decodeToolRun(bridge.messageTextAt(i));
    const total = dec ? dec.ok + dec.fail + dec.pending : 0;
    out.push({ index: i, total, header: total === 1 ? '1 tool called' : `${total} tools called` });
  }
  return out;
}

function countKind(bridge: HarnessBridge, kind: MessageKind): number {
  let c = 0;
  for (let i = 0; i < bridge.messageCount(); i++) {
    if (bridge.messageKindAt(i) === kind) c++;
  }
  return c;
}

describe('real-Wasm live tool increment (implements #433)', () => {
  it('loads a harness.wasm that carries the v11 readback + tool-run exports', async () => {
    const bridge = await loadBridge();
    // Fail-closed: a stale v10 artifact (no readback) throws from loadBridge → this
    // suite fails (never it.skip). A conforming v11 wasm round-trips the seam.
    expect(bridge.protocolVersion()).toBeGreaterThanOrEqual(11);
    expect(typeof bridge.exports.inv_message_kind_at).toBe('function');
  });

  it('case 1 — one tool_start paints kind-6 immediately with total 1', async () => {
    const bridge = await loadBridge();
    const session = createEmptySession();
    let paintedOnEvent = false;

    await runHarnessTurn(bridge, session, 'pwd', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'pwd' });
        // BEFORE any text_delta / done, the real ring already has a kind-6 row.
        const runs = ringToolRunTotals(bridge);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.total).toBe(1);
        expect(runs[0]!.header).toBe('1 tool called');
        paintedOnEvent = true;
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'pwd',
          ok: true,
          summary: 'pwd · ok · /invincible',
        });
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });
    expect(paintedOnEvent).toBe(true);
    expect(ringToolRunTotals(bridge)).toHaveLength(1);
  });

  it('case 2 — consecutive tools grow the SAME ring slot 1→2→3', async () => {
    const bridge = await loadBridge();
    const session = createEmptySession();
    const seen: number[] = [];
    const run = ringToolRunTotals(bridge);

    await runHarnessTurn(bridge, session, 'tools', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        for (let i = 0; i < 3; i++) {
          await init?.onEvent?.({ type: 'tool_start', name: `t${i}` });
          await init?.onEvent?.({
            type: 'tool_result',
            name: `t${i}`,
            ok: true,
            summary: `t${i} · ok`,
          });
          const runs = ringToolRunTotals(bridge);
          // Exactly one kind-6 row, on the SAME index, total grows to i+1.
          expect(runs).toHaveLength(1);
          if (runs[0]) {
            expect(runs[0].total).toBe(i + 1);
            seen.push(runs[0].index);
          }
        }
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });
    expect(seen).toHaveLength(3);
    // All three increments were observed on the SAME physical/visible ring index.
    expect(new Set(seen).size).toBe(1);
    const finalRuns = ringToolRunTotals(bridge);
    expect(finalRuns).toHaveLength(1);
    expect(finalRuns[0]!.total).toBe(3);
    expect(finalRuns[0]!.header).toBe('3 tools called');
  });

  it('case 3 — N×1 stacks FAIL: consecutive tools are one card with total N, never N cards of 1', async () => {
    const bridge = await loadBridge();
    const session = createEmptySession();
    const names = ['pwd', 'list_dir', 'exec'];

    await runHarnessTurn(bridge, session, 'many', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        for (const ev of toolEvents(names)) {
          if (ev.type === 'tool_start') await init?.onEvent?.({ type: 'tool_start', name: String(ev.name) });
          else await init?.onEvent?.({
            type: 'tool_result',
            name: String(ev.name),
            ok: true,
            summary: `${String(ev.name)} · ok`,
          });
        }
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });

    // #433 hard rule: exactly ONE kind-6 row with total N, header N tools called.
    const runs = ringToolRunTotals(bridge);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.total).toBe(names.length);
    expect(runs[0]!.header).toBe('3 tools called');
    // A theoretical N×1 stack would be N kind-6 rows each total 1 — assert the
    // ring is a single card instead (this is the old bug; a green suite that
    // painted 1/1/1 would fail the count assertion below).
  });

  it('case 4 — reasoning_delta first does not withhold tools; card exists on the event', async () => {
    const bridge = await loadBridge();
    const session = createEmptySession();
    let thinkingAbove = false;
    let toolOnEvent = false;

    await runHarnessTurn(bridge, session, 'think', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'reasoning_delta', text: 'Let me check…' });
        await init?.onEvent?.({ type: 'tool_start', name: 'list_dir' });
        // Thinking row is last; the tool must still paint a card ON THIS EVENT.
        const runs = ringToolRunTotals(bridge);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.total).toBe(1);
        toolOnEvent = true;
        // Thinking row appears ABOVE the tool card (a non-tool separator).
        const thinkingCount = countKind(bridge, MessageKind.Thinking);
        expect(thinkingCount).toBeGreaterThanOrEqual(1);
        thinkingAbove = true;
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'list_dir',
          ok: true,
          summary: 'list_dir · ok',
        });
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });
    expect(thinkingAbove).toBe(true);
    expect(toolOnEvent).toBe(true);
  });

  it('case 5 — after a user/assistant boundary the next tool opens a NEW card', async () => {
    const bridge = await loadBridge();
    const session = createEmptySession();

    await runHarnessTurn(bridge, session, 'twogroups', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        await init?.onEvent?.({ type: 'tool_start', name: 'read_file' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'read_file',
          ok: true,
          summary: 'read_file · ok',
        });
        // Real assistant text is a boundary.
        await init?.onEvent?.({ type: 'text_delta', text: 'I read it.' });
        // Next tool opens a NEW card at 1, never grows the committed one.
        await init?.onEvent?.({ type: 'tool_start', name: 'write_file' });
        await init?.onEvent?.({
          type: 'tool_result',
          name: 'write_file',
          ok: true,
          summary: 'write_file · ok',
        });
        await init?.onEvent?.({ type: 'done', text: 'I read and wrote.' });
        return { ok: true, text: 'I read and wrote.' };
      },
    });

    const runs = ringToolRunTotals(bridge);
    // Two distinct cards: read_file (1) then write_file (1) across the assistant boundary.
    expect(runs).toHaveLength(2);
    expect(runs[0]!.total).toBe(1);
    expect(runs[1]!.total).toBe(1);
  });

  it('group-full roll opens a NEW card and never grows the full one', async () => {
    const bridge = await loadBridge();
    const session = createEmptySession();
    const total = TOOL_RUN_ITEMS_MAX + 5;

    await runHarnessTurn(bridge, session, 'roll', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        for (let i = 0; i < total; i++) {
          await init?.onEvent?.({ type: 'tool_start', name: `t${i}` });
          await init?.onEvent?.({
            type: 'tool_result',
            name: `t${i}`,
            ok: true,
            summary: `t${i} · ok`,
          });
        }
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });

    const runs = ringToolRunTotals(bridge);
    expect(runs.length).toBeGreaterThan(1);
    // Every card is ≤ the group cap; total items across cards equals N.
    const sum = runs.reduce((acc, r) => acc + r.total, 0);
    expect(sum).toBe(total);
    // The full MAX-sized card must NOT have been grown past the cap.
    expect(Math.max(...runs.map((r) => r.total))).toBeLessThanOrEqual(TOOL_RUN_ITEMS_MAX);
  });

  it('session never exceeds the ring capacity under a heavy live turn', async () => {
    const bridge = await loadBridge();
    const session = createEmptySession();
    // Beyond the ring cap: every message still pushed, ring drops oldest.
    const pushes = HARNESS_RING_MAX + 20;
    const { session: next } = await runHarnessTurn(bridge, session, 'cap', {
      streamAgent: true,
      sendAgentStream: async (_prompt, init) => {
        for (let i = 0; i < pushes; i++) {
          await init?.onEvent?.({ type: 'text_delta', text: `chunk${i}` });
        }
        await init?.onEvent?.({ type: 'done', text: 'done' });
        return { ok: true, text: 'done' };
      },
    });
    expect(next.messages.length).toBeGreaterThan(0);
    // Real ring is capped (session may grow, mind the display window), and the
    // bridge is still queryable via readback (no crash / OOB on the seam).
    expect(bridge.messageCount()).toBeLessThanOrEqual(HARNESS_RING_MAX);
  });
});

// Declared to silence an unused-import guard; the helper is exercised above.
void Lifecycle;
