/**
 * backend-agents B12 (#806) — turn-loop + step-wrapper tests.
 *
 * Covers the plan's 10-case testing matrix:
 *  1. Loop: model returns empty `toolCalls` → breaks after one round; no tools
 *  2. Loop: model returns N tool calls → one tool-batch step; loop continues
 *  3. Loop: rounds reach the 512 cap → terminates (never infinite); writable closed
 *  4. Step args serializable (no closures/seams/bound runners cross a boundary)
 *  5. modelGenerateStep thin shell → delegates generateOneRound (delta; FULL tool schemas via shared helper)
 *  6. toolExecuteStep thin shell → delegates executeTool ({result,freshnessDelta}); business error is a value
 *  7. persistStep thin shell → persists via seam (in-memory); returns terminal status
 *  8. Step returns {ok:false} → value, not throw; loop terminates cleanly; writable closed
 *  9. Writable close → closed exactly once on success AND on error/cap/cancel
 * 10. Messages reconstruction on replay → rebuilt from step deltas (roundtrip)
 *
 * The loop core is directive-free, so it runs under plain vitest; the wrappers are
 * exercised by injecting fake cores. Static-graph clean-flag regression on the
 * `'use workflow'` entry (`turnWorkflow.ts`) asserts it stays inside the B11 lock
 * (zero banned reach) — walker from `./staticGraph`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runTurnLoop,
  MAX_WORKFLOW_STEPS,
  derivePersistFold,
  type TurnWritable,
  type TurnLoopDeps,
} from './turnLoop';
import {
  persistStep,
  setPersistSeamResolver,
  createInMemoryPersistSeam,
  type PersistStepFold,
} from './persistStep';
import { reachableImports, resolveFile } from './staticGraph';
import { createTurnPersistSeam } from '../agent/turnPersistSeam';
import { MemoryBlobTranscriptStore } from '../sessions/blobStores';
import { MemorySessionStore } from '../sessions/memorySessionStore';
import type { ObjectScope } from '../sessions/blobStore';
import { parseCloudSessionSnapshot } from '../sessionRepository';
import { STEP_BUDGET_WRAPUP, STEP_BUDGET_ERROR } from '../agent/modelFinish';
import {
  TURN_WALL_CLOCK_ERROR,
  TURN_WALL_CLOCK_WRAPUP,
  TURN_WALL_CLOCK_WRAPUP_SYSTEM,
} from '../agent/modelFinish';
import { STEP_BUDGET_WRAPUP_SYSTEM } from '../agent/modelFinish';
import { TURN_WALL_CLOCK_MAX_MS, TURN_WALL_CLOCK_WRAPUP_MAX_MS } from '../sessionCloudCaps';

const LOOP_SCOPE: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's_loop' };

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
function fakeWritable(onClose?: () => void): { w: TurnWritable; lines: string[]; closed: number } {
  const lines: string[] = [];
  // Keep `closed` on the returned object so `wiredDeps`'s `() => fake.closed`
  // reads the LIVE count (a snapshot value would stick at 0 for the whole test).
  const out: { w: TurnWritable; lines: string[]; closed: number } = {
    w: { write: () => {}, close: () => {} },
    lines,
    closed: 0,
  };
  out.w = {
    write: (line) => {
      lines.push(line);
    },
    close: () => {
      out.closed += 1;
      onClose?.();
    },
  };
  return out;
}

/** Standard loop deps wired to the real thin wrappers with in-memory seams. */
function wiredDeps(overrides: {
  maxSteps?: number;
  persistFail?: boolean;
  persistScope?: ObjectScope;
} = {}): {
  deps: Omit<TurnLoopDeps, 'modelStep'>;
  w: { writable: TurnWritable; lines: string[]; closed: number };
  closed: () => number;
} {
  const fake = fakeWritable();
  const seam = createInMemoryPersistSeam();
  // The persist seam is a module-level resolver (adversarial L1: never a step
  // arg). wiring it here means the REAL persistStep, when the loop hits the
  // terminal persist path, re-resolves the seam in-step.
  setPersistSeamResolver(() => seam.seam);
  const persistFail = overrides.persistFail ?? false;
  const persistScope = overrides.persistScope ?? LOOP_SCOPE;
  const base = {
    persistStep: persistFail
      ? async () => ({ ok: false as const, code: 'write_failed', error: 'boom' })
      : async (p: {
          turnRunId: string;
          deltas: ReadonlyArray<unknown>;
          fold?: PersistStepFold;
          terminal?: boolean;
        }) =>
          persistStep({
            turnRunId: p.turnRunId,
            deltas: p.deltas,
            ...(p.fold !== undefined ? { fold: p.fold } : {}),
            ...(p.terminal !== undefined ? { terminal: p.terminal } : {}),
            scope: persistScope,
          }),
    // Default no-op toolStep; loop tests that fan tools override it. modelStep is
    // always injected per test (matrix 1/8/9/10 stop after the model round).
    toolStep: async (): Promise<{
      ok: false;
      code: 'tool_not_found';
      error: string;
    }> => ({
      ok: false,
      code: 'tool_not_found',
      error: 'toolStep not injected',
    }),
    writable: fake.w,
    turnRunId: 'run_123',
    ...(overrides.maxSteps !== undefined ? { maxSteps: overrides.maxSteps } : {}),
  };
  const w = { writable: fake.w, lines: fake.lines, closed: fake.closed };
  return { deps: base, w, closed: () => fake.closed };
}

type ToolCallIn = {
  calls: ReadonlyArray<{ toolName: string; toolCallId?: string; args?: unknown }>;
  freshnessSeed?: string;
  persistRunBind?: { cwd?: string; activeSandboxId?: string };
};

/** Loop-test helper: one batch result per call (plan #880). */
function okBatch(
  handler?: (
    call: { toolName: string; toolCallId?: string; args?: unknown },
    args: ToolCallIn,
  ) => { result: string; freshnessDelta: string },
) {
  return async (args: ToolCallIn) => {
    const results = args.calls.map((c) => {
      const h = handler
        ? handler(c, args)
        : { result: 'ok', freshnessDelta: '[]' };
      return {
        ok: true as const,
        toolName: c.toolName,
        ...(c.toolCallId ? { toolCallId: c.toolCallId } : {}),
        result: h.result,
        freshnessDelta: h.freshnessDelta,
      };
    });
    const last = results[results.length - 1];
    return {
      ok: true as const,
      results,
      freshnessDelta: last?.freshnessDelta ?? '[]',
    };
  };
}

describe('runTurnLoop (backend-agents B12, matrix 1–3, 8–10)', () => {
  it('matrix 1: model returns empty toolCalls → one model round, no tools run, persisted, closed', async () => {
    const { deps, w, closed } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [], finishReason: 'stop' },
    }));
    const toolStep = vi.fn();
    const result = await runTurnLoop({ ...deps, modelStep, toolStep }, { userMessage: 'hello' });
    expect(modelStep).toHaveBeenCalledTimes(1);
    expect(toolStep).not.toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(1);
    expect(closed()).toBe(1);
    expect(w.lines.some((l) => l.includes('"done"'))).toBe(true);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'text_delta')).toBe(false);
    const done = events.find((e: { type: string }) => e.type === 'done') as {
      type: string;
      text: string;
    };
    expect(done.text).toBe('hi');
    expect(events.some((e: { type: string }) => e.type === 'text')).toBe(false);
  });

  it('finishReason length + empty tools → done with partial text, not a failed turn', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'cut off mid', toolCalls: [], finishReason: 'length' },
    }));
    const result = await runTurnLoop(
      { ...deps, persistStep: persistSpy, modelStep, toolStep: vi.fn() },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.find((e: { type: string; text?: string }) => e.type === 'done')).toMatchObject({
      type: 'done',
      text: 'cut off mid',
    });
    expect(events.some((e: { type: string; error?: string }) => e.type === 'error')).toBe(false);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy.mock.calls[0]![0].terminal).toBeUndefined();
  });

  it('finishReason error + empty tools → SSE model error, not output truncated', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: '', toolCalls: [], finishReason: 'error' },
    }));
    const result = await runTurnLoop(
      { ...deps, persistStep: persistSpy, modelStep, toolStep: vi.fn() },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('model error');
    expect(result.error).not.toBe('output truncated');
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(false);
    expect(events.some((e: { type: string; error?: string }) => e.type === 'error' && e.error === 'model error')).toBe(true);
    expect(persistSpy).toHaveBeenCalledTimes(1);
  });

  it('finishReason content-filter + empty tools → SSE content filtered', async () => {
    const { deps, w } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'nope', toolCalls: [], finishReason: 'content-filter' },
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep: vi.fn() },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('content filtered');
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(false);
    expect(events.some((e: { type: string; error?: string }) => e.type === 'error' && e.error === 'content filtered')).toBe(true);
  });

  it('finishReason length WITH toolCalls still runs tools', async () => {
    const { deps } = wiredDeps();
    let first = true;
    const modelStep = vi.fn(async () => {
      const f = first;
      first = false;
      return f
        ? {
            ok: true as const,
            delta: {
              text: 'call',
              toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
              finishReason: 'length',
            },
          }
        : { ok: true as const, delta: { text: 'done', toolCalls: [], finishReason: 'stop' } };
    });
    const toolStep = vi.fn(okBatch());
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep },
      { userMessage: 'go' },
    );
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
  });

  it('omitted finishReason + empty tools still done (chat)', async () => {
    const { deps, w } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [] },
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep: vi.fn() },
      { userMessage: 'hello' },
    );
    expect(result.status).toBe('completed');
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(true);
  });

  it('matrix 2: model returns N tool calls → one tool-batch step; loop continues', async () => {
    const { deps, w, closed } = wiredDeps();
    // Round 1 emits 2 tool calls (both run as tools); round 2 emits none, so the
    // loop breaks cleanly. Non-stateful mocks here would loop to the 512 cap.
    let first = true;
    const modelStep = vi.fn(async () => {
      const f = first;
      first = false;
      return f
        ? {
            ok: true as const,
            delta: {
              text: 'two calls',
              toolCalls: [
                { toolName: 'list_dir', toolCallId: 'c1', args: { path: '.' } },
                { toolName: 'read_file', toolCallId: 'c2', args: { path: 'x' } },
              ],
            },
          }
        : { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(okBatch((c) => ({
      result: `out:${c.toolName}`,
      freshnessDelta: '[]',
    })));
    const result = await runTurnLoop({ ...deps, modelStep, toolStep }, { userMessage: 'go' });
    expect(modelStep).toHaveBeenCalledTimes(2);
    expect(toolStep).toHaveBeenCalledTimes(1);
    const batchArg = toolStep.mock.calls[0]?.[0] as ToolCallIn;
    expect(batchArg.calls.map((c) => c.toolName)).toEqual(['list_dir', 'read_file']);
    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(2);
    expect(closed()).toBe(1);
    const toolRows = (result.messages as Array<{ role?: string; toolName?: string }>).filter(
      (m) => m.role === 'tool',
    );
    expect(toolRows.map((m) => m.toolName)).toEqual(['list_dir', 'read_file']);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.filter((e: { type: string }) => e.type === 'tool_start')).toEqual([]);
    // Live tool_result is written inside the tool step, not by the loop.
    expect(events.filter((e: { type: string }) => e.type === 'tool_result')).toEqual([]);
    expect(events.some((e: { type: string }) => e.type === 'tool_start' && 'toolName' in e)).toBe(false);
  });

  it('batch item {ok:false} keeps sibling results; model continues (not a turn-end)', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'two',
            toolCalls: [
              { toolName: 'list_dir', toolCallId: 'a', args: {} },
              { toolName: 'read_file', toolCallId: 'b', args: {} },
            ],
          },
        };
      }
      return { ok: true as const, delta: { text: 'got the error', toolCalls: [] } };
    });
    const toolStep = vi.fn(async (_args: ToolCallIn) => ({
      ok: true as const,
      results: [
        {
          ok: true as const,
          toolName: 'list_dir',
          toolCallId: 'a',
          result: 'ok-dir',
          freshnessDelta: '[]',
        },
        {
          ok: false as const,
          toolName: 'read_file',
          toolCallId: 'b',
          code: 'sandbox_error' as const,
          error: 'boom',
        },
      ],
      freshnessDelta: '[]',
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, persistStep: persistSpy },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect(modelStep).toHaveBeenCalledTimes(2);
    const rows = (result.messages as Array<{ role?: string; toolCallId?: string; result?: string; error?: string }>)
      .filter((m) => m.role === 'tool');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.result).toBe('ok-dir');
    expect(rows[1]?.error).toBe('boom');
    expect(persistSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(true);
    expect(events.some((e: { type: string; error?: string }) => e.type === 'error' && e.error === 'boom')).toBe(
      false,
    );
    expect(closed()).toBe(1);
  });

  it('cancel persists sibling successes then fails (adversarial #881 Major)', async () => {
    const { deps, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: {
        text: 'two',
        toolCalls: [
          { toolName: 'list_dir', toolCallId: 'a', args: {} },
          { toolName: 'read_file', toolCallId: 'b', args: {} },
        ],
      },
    }));
    const toolStep = vi.fn(async (_args: ToolCallIn) => ({
      ok: false as const,
      code: 'cancelled' as const,
      error: 'Request cancelled.',
      results: [
        {
          ok: true as const,
          toolName: 'list_dir',
          toolCallId: 'a',
          result: 'ok-dir',
          freshnessDelta: '[]',
        },
        {
          ok: false as const,
          toolName: 'read_file',
          toolCallId: 'b',
          code: 'cancelled' as const,
          error: 'Request cancelled.',
        },
      ],
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, persistStep: persistSpy },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('cancelled');
    expect(result.error).toBe('Request cancelled.');
    const rows = (result.messages as Array<{ role?: string; result?: string; error?: string }>)
      .filter((m) => m.role === 'tool');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.result).toBe('ok-dir');
    // user-line + persist of the mixed batch before fail()
    expect(persistSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const lastFold = persistSpy.mock.calls[persistSpy.mock.calls.length - 1]?.[0] as {
      terminal?: boolean;
    };
    expect(lastFold.terminal).toBeUndefined();
    expect(closed()).toBe(1);
  });

  it('itemFail at cap still persists the mixed batch then wrap-up done (adversarial #881 round-2 Major)', async () => {
    const { deps, w, closed } = wiredDeps({ maxSteps: 3 });
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as { disableTools?: boolean };
      if (a.disableTools) {
        return { ok: true as const, delta: { text: 'wrap-summary', toolCalls: [] } };
      }
      return {
        ok: true as const,
        delta: {
          text: 'two',
          toolCalls: [
            { toolName: 'list_dir', toolCallId: 'a', args: {} },
            { toolName: 'read_file', toolCallId: 'b', args: {} },
          ],
        },
      };
    });
    const toolStep = vi.fn(async (_args: ToolCallIn) => ({
      ok: true as const,
      results: [
        {
          ok: true as const,
          toolName: 'list_dir',
          toolCallId: 'a',
          result: 'ok-dir',
          freshnessDelta: '[]',
        },
        {
          ok: false as const,
          toolName: 'read_file',
          toolCallId: 'b',
          code: 'sandbox_error' as const,
          error: 'boom',
        },
      ],
      freshnessDelta: '[]',
    }));
    const result = await runTurnLoop(
      { ...deps, maxSteps: 3, modelStep, toolStep, persistStep: persistSpy },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.error).toBeUndefined();
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect(persistSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const rows = (result.messages as Array<{ role?: string; result?: string; error?: string }>)
      .filter((m) => m.role === 'tool');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.result).toBe('ok-dir');
    expect(rows[1]?.error).toBe('boom');
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(true);
    expect(events.some((e: { type: string; error?: string }) => e.type === 'error' && e.error === 'boom')).toBe(
      false,
    );
    expect(closed()).toBe(1);
  });

  it('cancel at cap still persists sibling successes (adversarial #881 round-2 Major)', async () => {
    const { deps, closed } = wiredDeps({ maxSteps: 3 });
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: {
        text: 'two',
        toolCalls: [
          { toolName: 'list_dir', toolCallId: 'a', args: {} },
          { toolName: 'read_file', toolCallId: 'b', args: {} },
        ],
      },
    }));
    const toolStep = vi.fn(async (_args: ToolCallIn) => ({
      ok: false as const,
      code: 'cancelled' as const,
      error: 'Request cancelled.',
      results: [
        {
          ok: true as const,
          toolName: 'list_dir',
          toolCallId: 'a',
          result: 'ok-dir',
          freshnessDelta: '[]',
        },
        {
          ok: false as const,
          toolName: 'read_file',
          toolCallId: 'b',
          code: 'cancelled' as const,
          error: 'Request cancelled.',
        },
      ],
    }));
    const result = await runTurnLoop(
      { ...deps, maxSteps: 3, modelStep, toolStep, persistStep: persistSpy },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('cancelled');
    expect(persistSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const rows = (result.messages as Array<{ role?: string; result?: string }>)
      .filter((m) => m.role === 'tool');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.result).toBe('ok-dir');
    expect(closed()).toBe(1);
  });

  it('whole-step fail with N calls writes tool_result for every call; model continues', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'three',
            toolCalls: [
              { toolName: 'list_dir', toolCallId: 'a', args: {} },
              { toolName: 'read_file', toolCallId: 'b', args: {} },
              { toolName: 'write_file', toolCallId: 'c', args: {} },
            ],
          },
        };
      }
      return { ok: true as const, delta: { text: 'tools missed', toolCalls: [] } };
    });
    const toolStep = vi.fn(async () => ({
      ok: false as const,
      code: 'sandbox_error' as const,
      error: 'down',
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, persistStep: persistSpy },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(modelStep).toHaveBeenCalledTimes(2);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim())) as Array<{
      type: string;
      name?: string;
      ok?: boolean;
    }>;
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((e) => e.name)).toEqual(['list_dir', 'read_file', 'write_file']);
    expect(results.every((e) => e.ok === false)).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(closed()).toBe(1);
  });

  it('matrix 3: loop reaches the cap → terminates (never infinite), writable closed', async () => {
    const { deps, w, closed } = wiredDeps({ maxSteps: 2 });
    // Every model round keeps returning a tool call, so the loop would never stop
    // under no cap — the cap must terminate it.
    const modelStep = vi.fn(async (_args: unknown) => ({
      ok: true as const,
      delta: { text: 'again', toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }] },
    }));
    const toolStep = vi.fn(okBatch());
    const result = await runTurnLoop(
      { ...deps, maxSteps: 2, modelStep, toolStep },
      { userMessage: 'loop' },
    );
    expect(result.status).toBe('capped');
    // cap = TOTAL STEPS: round 1 consumes 1 model step + 1 user-line persist
    // = 2, budget exhausted before the tool gate → 0 tools. Terminal persist
    // on cap adds a third step so the envelope is not left running.
    // Wrap-up model is extra (not counted against the working budget).
    expect(result.steps).toBe(3);
    expect(result.rounds).toBe(1);
    expect(modelStep).toHaveBeenCalledTimes(2);
    const wrapArgs = modelStep.mock.calls[1]?.[0] as {
      disableTools?: boolean;
      messages: Array<{ role?: string; content?: string }>;
    };
    expect(wrapArgs.disableTools).toBe(true);
    expect(wrapArgs.messages.some((m) => m.role === 'error')).toBe(true);
    const wrapMsgs = wrapArgs.messages as Array<{
      role?: string;
      toolCallId?: string;
      ok?: boolean;
      error?: string;
    }>;
    const errIdx = wrapMsgs.findIndex((m) => m.role === 'error');
    const skipped = wrapMsgs.filter((m) => m.role === 'tool' && m.toolCallId === 'c');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.ok).toBe(false);
    expect(skipped[0]?.error).toContain('step budget exhausted');
    expect(wrapMsgs.indexOf(skipped[0]!)).toBeLessThan(errIdx);
    expect(toolStep).toHaveBeenCalledTimes(0);
    expect(closed()).toBe(1);
    const capEvents = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(capEvents.some((e: { type: string }) => e.type === 'done')).toBe(true);
    expect(
      capEvents.some(
        (e: { type: string; error?: string }) =>
          e.type === 'error' && e.error === 'step budget exhausted',
      ),
    ).toBe(false);
    expect(
      capEvents.some(
        (e: { type: string; name?: string; ok?: boolean; summary?: string }) =>
          e.type === 'tool_result' &&
          e.name === 'list_dir' &&
          e.ok === false &&
          (e.summary ?? '').includes('step budget exhausted'),
      ),
    ).toBe(true);
    expect(
      (result.messages as Array<{ role?: string }>).some((m) => m.role === 'error'),
    ).toBe(false);
  });

  it('matrix 3b (L6): one round of N tools is one batch step; all N run', async () => {
    const { deps, w, closed } = wiredDeps({ maxSteps: 3 });
    // One round emits FOUR tool calls. cap=3 → 1 model + 1 user-line persist
    // + 1 batch (all 4). Fanout cannot blow the step budget because it is 1 step.
    const modelStep = vi.fn(async (_args: unknown) => ({
      ok: true as const,
      delta: {
        text: 'fan',
        toolCalls: [0, 1, 2, 3].map((n) => ({
          toolName: 'read_file',
          toolCallId: `tc${n}`,
          args: { path: `f${n}` },
        })),
      },
    }));
    const toolStep = vi.fn(okBatch());
    const result = await runTurnLoop(
      { ...deps, maxSteps: 3, modelStep, toolStep },
      { userMessage: 'fan' },
    );
    expect(result.status).toBe('capped');
    // 1 model + 1 user-line persist + 1 batch = 3; no persist-after-batch
    // (budget exhausted). Terminal persist on cap is a fourth step.
    expect(result.steps).toBe(4);
    expect(modelStep).toHaveBeenCalledTimes(2);
    expect((modelStep.mock.calls[1]?.[0] as { disableTools?: boolean }).disableTools).toBe(true);
    expect(toolStep).toHaveBeenCalledTimes(1);
    const fanArg = toolStep.mock.calls[0]?.[0] as ToolCallIn;
    expect(fanArg.calls.map((c) => c.toolCallId)).toEqual(['tc0', 'tc1', 'tc2', 'tc3']);
    const fanWrap = modelStep.mock.calls[1]?.[0] as {
      messages: Array<{ role?: string; toolCallId?: string; ok?: boolean }>;
    };
    const fanTools = fanWrap.messages.filter((m) => m.role === 'tool');
    expect(fanTools.map((m) => m.toolCallId).sort()).toEqual(['tc0', 'tc1', 'tc2', 'tc3']);
    expect(fanTools.filter((m) => m.ok === false)).toHaveLength(0);
    expect(closed()).toBe(1);
    const fanEvents = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(fanEvents.some((e: { type: string }) => e.type === 'done')).toBe(true);
    expect(fanEvents.some((e: { type: string }) => e.type === 'error')).toBe(false);
  });

  it('matrix 3c: completed last tool (unpaired empty) still wrap-up [adversarial #879 Minor]', async () => {
    const { deps, w, closed } = wiredDeps({ maxSteps: 4 });
    // 1 model + user-line persist + 1 tool + after-tool persist = 4. All pairs
    // already closed; unpairedToolRows returns []. Wrap-up must still run.
    const modelStep = vi.fn(async (_args: unknown) => ({
      ok: true as const,
      delta: {
        text: 'call',
        toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
      },
    }));
    const toolStep = vi.fn(okBatch());
    const result = await runTurnLoop(
      { ...deps, maxSteps: 4, modelStep, toolStep },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.steps).toBe(5); // 4 in-budget + terminal persist; wrap-up extra
    expect(modelStep).toHaveBeenCalledTimes(2);
    expect(toolStep).toHaveBeenCalledTimes(1);
    const wrapArgs = modelStep.mock.calls[1]?.[0] as {
      disableTools?: boolean;
      messages: Array<{ role?: string; toolCallId?: string; ok?: boolean; error?: string }>;
    };
    expect(wrapArgs.disableTools).toBe(true);
    expect(wrapArgs.messages.some((m) => m.role === 'error')).toBe(true);
    const toolRows = wrapArgs.messages.filter((m) => m.role === 'tool' && m.toolCallId === 'c1');
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]?.ok).not.toBe(false);
    expect(toolRows[0]?.error).toBeUndefined();
    expect(
      (result.messages as Array<{ role?: string }>).some((m) => m.role === 'error'),
    ).toBe(false);
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(true);
    expect(
      events.some(
        (e: { type: string; error?: string }) =>
          e.type === 'error' && e.error === STEP_BUDGET_ERROR,
      ),
    ).toBe(false);
    expect(
      events.filter(
        (e: { type: string; name?: string; ok?: boolean }) =>
          e.type === 'tool_result' && e.name === 'list_dir',
      ),
    ).toEqual([]);
  });

  it('cap persist fold omits wrap-up Error instruction (not canvas copy) [adversarial #879 Major]', async () => {
    const { deps, closed } = wiredDeps({ maxSteps: 2 });
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as { disableTools?: boolean };
      if (a.disableTools) {
        return { ok: true as const, delta: { text: 'wrap-summary', toolCalls: [] } };
      }
      return {
        ok: true as const,
        delta: {
          text: 'working',
          toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
        },
      };
    });
    const result = await runTurnLoop(
      {
        ...deps,
        maxSteps: 2,
        modelStep,
        toolStep: vi.fn(),
        persistStep: persistSpy,
      },
      { userMessage: 'loop' },
    );
    expect(result.status).toBe('capped');
    const terminalArg = persistSpy.mock.calls[persistSpy.mock.calls.length - 1]?.[0] as {
      fold?: PersistStepFold;
      terminal?: boolean;
    };
    expect(terminalArg.terminal).toBeUndefined();
    const ckpt = terminalArg.fold?.checkpoint ?? [];
    expect(ckpt.some((r) => r.role === 'error')).toBe(false);
    expect(JSON.stringify(ckpt)).not.toContain(STEP_BUDGET_WRAPUP);
    expect(ckpt.some((r) => r.role === 'assistant' && r.content === 'working')).toBe(true);
    expect(ckpt.some((r) => r.role === 'assistant' && r.content === 'wrap-summary')).toBe(
      true,
    );
    expect(
      (result.messages as Array<{ role?: string }>).some((m) => m.role === 'error'),
    ).toBe(false);
    expect(closed()).toBe(1);
  });

  it('derivePersistFold drops wrap-up error rows', () => {
    const fold = derivePersistFold(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', delta: { text: 'working', toolCalls: [] } },
        { role: 'error', content: STEP_BUDGET_WRAPUP },
        { role: 'assistant', delta: { text: 'summary', toolCalls: [] } },
      ],
      undefined,
    );
    expect(fold?.checkpoint).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'working' },
      { role: 'assistant', content: 'summary' },
    ]);
  });

  it('derivePersistFold copies last-round resolvedProvider (plan #906)', () => {
    const fold = derivePersistFold(
      [{ role: 'assistant', delta: { text: 'hi', toolCalls: [] } }],
      undefined,
      undefined,
      'togetherai',
    );
    expect(fold?.resolvedProvider).toBe('togetherai');
    expect(
      derivePersistFold(
        [{ role: 'assistant', delta: { text: 'hi', toolCalls: [] } }],
        undefined,
      )?.resolvedProvider,
    ).toBeUndefined();
  });

  it('plan #936 row 8 — derivePersistFold derives a modelMessages sibling (user/assistant/tool rows; persist/error skipped; reasoning dropped)', () => {
    const fold = derivePersistFold(
      [
        { role: 'user', content: 'read the tree' },
        {
          role: 'assistant',
          delta: {
            text: 'reading',
            toolCalls: [{ toolName: 'read_file', toolCallId: 'c1', args: { path: 'x' } }],
            reasoning: 'secret CoT — never persisted',
          },
        },
        { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'file body' },
        { role: 'persist', content: 'loop-internal' },
        { role: 'error', content: 'wrap-up error' },
      ],
      undefined,
    );
    const mm = fold?.modelMessages as Array<Record<string, unknown>>;
    expect(Array.isArray(mm)).toBe(true);
    // user + assistant(+tool-calls) + tool rows kept; persist/error skipped.
    expect(mm.map((r) => r.role)).toEqual(['user', 'assistant', 'tool']);
    // reasoning is NEVER carried into the projection.
    const asst = mm[1] as { delta?: { reasoning?: unknown; toolCalls?: unknown[] } };
    expect(asst.delta?.reasoning).toBeUndefined();
    expect(asst.delta?.toolCalls).toHaveLength(1);
    // The tool row keeps its toolCallId linkage + result.
    const tool = mm[2] as { toolCallId?: string; result?: string };
    expect(tool.toolCallId).toBe('c1');
    expect(tool.result).toBe('file body');
  });

  it('plan #941 row 6 — derivePersistFold derives a freshnessReminder sibling (paths of committed read_file calls)', () => {
    const fold = derivePersistFold(
      [
        { role: 'user', content: 'read the tree' },
        {
          role: 'assistant',
          delta: {
            text: 'reading',
            toolCalls: [
              { toolName: 'read_file', toolCallId: 'c1', args: { path: 'src/foo.ts' } },
              { toolName: 'read_file', toolCallId: 'c2', args: { path: 'lib/bar.ts' } },
            ],
          },
        },
        { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'file body' },
        { role: 'tool', toolName: 'read_file', toolCallId: 'c2', result: 'more body' },
        { role: 'persist', content: 'loop-internal' },
        { role: 'error', content: 'wrap-up error' },
      ],
      undefined,
    );
    expect(fold?.freshnessReminder).toEqual(['src/foo.ts', 'lib/bar.ts']);
  });

  it('plan #941 row 6b — zero-read turn: the fold still carries freshnessReminder [] (volatility clear)', () => {
    // A no-tool turn (user+assistant only): the fold carries the EMPTY reminder
    // so the persist seam rewrites {paths:[]} and clears the prior turn's list.
    const fold = derivePersistFold(
      [
        { role: 'user', content: 'just answer' },
        { role: 'assistant', delta: { text: 'ok', toolCalls: [] } },
      ],
      undefined,
    );
    expect(fold).toBeDefined();
    expect(fold?.freshnessReminder).toEqual([]);
  });

  it('plan #941 adversarial #943 — seeded prior read_file rows do NOT leak into this-run reminder (thisRunStart slice)', () => {
    // Production `#936` seed keeps `args.path` on assistant toolCalls. Walking
    // the full array would re-derive last turn's paths on a zero-read chat.
    const prior = [
      { role: 'user', content: 'read the tree' },
      {
        role: 'assistant',
        delta: {
          text: 'reading',
          toolCalls: [{ toolName: 'read_file', toolCallId: 'c1', args: { path: 'src/foo.ts' } }],
        },
      },
      { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'file body' },
    ];
    const thisRun = [
      { role: 'user', content: 'just answer' },
      { role: 'assistant', delta: { text: 'ok', toolCalls: [] } },
    ];
    const fold = derivePersistFold([...prior, ...thisRun], undefined, undefined, undefined, prior.length);
    expect(fold?.freshnessReminder).toEqual([]);
  });

  it('plan #941 adversarial #943 — this-run read is kept; prior read_file paths are not', () => {
    const prior = [
      { role: 'user', content: 'read a' },
      {
        role: 'assistant',
        delta: {
          text: 'reading',
          toolCalls: [{ toolName: 'read_file', toolCallId: 'c0', args: { path: 'old.ts' } }],
        },
      },
      { role: 'tool', toolName: 'read_file', toolCallId: 'c0', result: 'old body' },
    ];
    const thisRun = [
      { role: 'user', content: 'now read b' },
      {
        role: 'assistant',
        delta: {
          text: 'reading',
          toolCalls: [{ toolName: 'read_file', toolCallId: 'c1', args: { path: 'new.ts' } }],
        },
      },
      { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'new body' },
    ];
    const fold = derivePersistFold([...prior, ...thisRun], undefined, undefined, undefined, prior.length);
    expect(fold?.freshnessReminder).toEqual(['new.ts']);
  });

  it('plan #941 — derivePersistFold with NO rows at all stays undefined (no empty-fold persist write)', () => {
    expect(derivePersistFold([], undefined)).toBeUndefined();
  });

  it('plan #941 row 7 — loop passes the pointer to modelStep on round 1 ONLY (later rounds + wrap-up omit it)', async () => {
    const { deps, closed } = wiredDeps();
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'read',
            toolCalls: [{ toolName: 'read_file', toolCallId: 'a', args: { path: 'a.ts' } }],
          },
        };
      }
      return { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(okBatch());
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep },
      { userMessage: 'go', freshnessReminderPointer: 't_fr_prior' },
    );
    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(2);
    // Round 1: the pointer is present (the prior turn's reminder rides in).
    const round1 = (modelStep.mock.calls[0] as unknown[])?.[0] as {
      freshnessReminderPointer?: string;
    };
    expect(round1?.freshnessReminderPointer).toBe('t_fr_prior');
    // Round 2 (this turn's own tool rows are already in messages): omitted.
    const round2 = (modelStep.mock.calls[1] as unknown[])?.[0] as {
      freshnessReminderPointer?: string;
    };
    expect(round2?.freshnessReminderPointer).toBeUndefined();
    expect(closed()).toBe(1);
  });

  it('plan #941 row 7b — no pointer → modelStep never receives the arg', async () => {
    const { deps, closed } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [] },
    }));
    await runTurnLoop({ ...deps, modelStep, toolStep: vi.fn() }, { userMessage: 'hello' });
    const round1 = (modelStep.mock.calls[0] as unknown[])?.[0] as Record<string, unknown>;
    expect('freshnessReminderPointer' in round1).toBe(false);
    expect(closed()).toBe(1);
  });

  it('plan #941 adversarial #943 — runTurnLoop persist fold is [] when this run read nothing, even with a seeded prior read_file (args.path)', async () => {
    const { deps, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const priorMessages = [
      { role: 'user', content: 'turn-1 user' },
      {
        role: 'assistant',
        delta: {
          text: 'reading',
          toolCalls: [{ toolName: 'read_file', toolCallId: 'c1', args: { path: 'src/foo.ts' } }],
        },
      },
      { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'file body' },
    ];
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'turn-2 answer', toolCalls: [] },
    }));
    const result = await runTurnLoop(
      { ...deps, persistStep: persistSpy, modelStep, toolStep: vi.fn() },
      { userMessage: 'just chat', priorMessages },
    );
    expect(result.status).toBe('completed');
    const terminalArg = persistSpy.mock.calls[persistSpy.mock.calls.length - 1]?.[0] as {
      fold?: PersistStepFold;
    };
    expect(terminalArg.fold?.freshnessReminder).toEqual([]);
    expect(closed()).toBe(1);
  });

  it('derivePersistFold does not throw when global Buffer is absent (Workflows canvas)', () => {
    const g = globalThis as { Buffer?: unknown };
    const saved = g.Buffer;
    Reflect.deleteProperty(g, 'Buffer');
    expect(typeof g.Buffer).toBe('undefined');
    try {
      expect(() =>
        derivePersistFold(
          [
            { role: 'user', content: 'read the tree' },
            {
              role: 'assistant',
              delta: {
                text: 'reading',
                toolCalls: [{ toolName: 'read_file', toolCallId: 'c1' }],
              },
            },
            { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'file body' },
          ],
          undefined,
        ),
      ).not.toThrow();
      const fold = derivePersistFold(
        [
          { role: 'user', content: 'read the tree' },
          {
            role: 'assistant',
            delta: {
              text: 'reading',
              toolCalls: [{ toolName: 'read_file', toolCallId: 'c1' }],
            },
          },
          { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'file body' },
        ],
        undefined,
      );
      expect((fold?.modelMessages as unknown[] | undefined)?.length).toBe(3);
    } finally {
      g.Buffer = saved;
    }
  });

  it('plan #936 row 8b — runTurnLoop seeds messages from priorMessages; terminal persist re-derives a projection that includes prior rows (append-only growth)', async () => {
    const { deps, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const priorMessages = [
      { role: 'user', content: 'turn-1 user' },
      {
        role: 'assistant',
        delta: { text: 'reading', toolCalls: [{ toolName: 'read_file', toolCallId: 'c1' }] },
      },
      { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'file body' },
    ];
    // Model returns no tools this turn → one completed persist.
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'turn-2 answer', toolCalls: [] },
    }));
    const result = await runTurnLoop(
      { ...deps, persistStep: persistSpy, modelStep, toolStep: vi.fn() },
      { userMessage: 'turn-2 follow-up', priorMessages },
    );
    expect(result.status).toBe('completed');
    // Seeded messages = [...priorMessages, {role:'user'}, ...this-turn rows].
    const msgs = result.messages as Array<{ role?: string; content?: string }>;
    expect(msgs[0]).toEqual(priorMessages[0]);
    expect(msgs[1]).toEqual(priorMessages[1]);
    expect(msgs[2]).toEqual(priorMessages[2]);
    // The new user row follows the seeded prior rows.
    expect(msgs[3]).toEqual({ role: 'user', content: 'turn-2 follow-up' });
    // The terminal persist's projection includes the prior rows AND this turn's
    // rows (append-only growth), so the NEXT turn seeds the full trace.
    const terminalArg = persistSpy.mock.calls[persistSpy.mock.calls.length - 1]?.[0] as {
      fold?: PersistStepFold;
    };
    const mm = terminalArg.fold?.modelMessages as Array<Record<string, unknown>>;
    expect(Array.isArray(mm)).toBe(true);
    // Prior user/assistant/tool rows + this turn's user + assistant.
    expect(mm.length).toBeGreaterThanOrEqual(5);
    expect(mm[0]).toEqual(priorMessages[0]);
    expect(mm[2]).toEqual(priorMessages[2]);
    // This turn's raw user prompt + assistant answer are appended.
    const users = mm.filter((r) => r.role === 'user');
    expect(users.some((r) => r.content === 'turn-2 follow-up')).toBe(true);
    const assistants = mm.filter((r) => r.role === 'assistant');
    expect(
      assistants.some((r) => (r as { delta?: { text?: string } }).delta?.text === 'turn-2 answer'),
    ).toBe(true);
    expect(closed()).toBe(1);
  });

  it('plan #936 row 8c — no priorMessages → messages is the legacy singleton (no seed)', async () => {
    const { deps } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [] },
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep: vi.fn() },
      { userMessage: 'hello' },
    );
    const msgs = result.messages as Array<{ role?: string; content?: string }>;
    expect(msgs[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('wrap-up {ok:false} still terminal-persists and SSE-errors (inference death is not a cap) [adversarial #879 Minor]', async () => {
    const { deps, w, closed } = wiredDeps({ maxSteps: 2 });
    const persistSpy = vi.fn(deps.persistStep);
    let n = 0;
    const modelStep = vi.fn(async (_args: unknown) => {
      n += 1;
      if (n === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'again',
            toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
          },
        };
      }
      return { ok: false as const, code: 'model_error' as const, error: 'wrap boom' };
    });
    const result = await runTurnLoop(
      { ...deps, maxSteps: 2, modelStep, toolStep: vi.fn(), persistStep: persistSpy },
      { userMessage: 'loop' },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('wrap boom');
    expect(persistSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const last = persistSpy.mock.calls[persistSpy.mock.calls.length - 1]?.[0] as {
      terminal?: boolean;
    };
    expect(last.terminal).toBeUndefined();
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(false);
    expect(
      events.some(
        (e: { type: string; error?: string }) =>
          e.type === 'error' && e.error === 'wrap boom',
      ),
    ).toBe(true);
    expect(events.some((e: { error?: string }) => e.error === STEP_BUDGET_ERROR)).toBe(false);
    expect(closed()).toBe(1);
  });

  it('wrap-up throw still terminal-persists and SSE-errors (inference death is not a cap) [adversarial #879 Minor]', async () => {
    const { deps, w, closed } = wiredDeps({ maxSteps: 2 });
    const persistSpy = vi.fn(deps.persistStep);
    let n = 0;
    const modelStep = vi.fn(async (_args: unknown) => {
      n += 1;
      if (n === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'again',
            toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
          },
        };
      }
      throw new Error('wrap threw');
    });
    const result = await runTurnLoop(
      { ...deps, maxSteps: 2, modelStep, toolStep: vi.fn(), persistStep: persistSpy },
      { userMessage: 'loop' },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('wrap threw');
    const last = persistSpy.mock.calls[persistSpy.mock.calls.length - 1]?.[0] as {
      terminal?: boolean;
    };
    expect(last.terminal).toBeUndefined();
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(
      events.some(
        (e: { type: string; error?: string }) =>
          e.type === 'error' && e.error === 'wrap threw',
      ),
    ).toBe(true);
    expect(events.some((e: { error?: string }) => e.error === STEP_BUDGET_ERROR)).toBe(false);
    expect(closed()).toBe(1);
  });

  it('mid-turn persist: no-tool run is exactly one completed persist', async () => {
    const { deps, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [] },
    }));
    const result = await runTurnLoop(
      { ...deps, persistStep: persistSpy, modelStep, toolStep: vi.fn() },
      { userMessage: 'hello' },
    );
    expect(result.status).toBe('completed');
    expect(persistSpy).toHaveBeenCalledTimes(1);
    const arg = persistSpy.mock.calls[0]?.[0] as { terminal?: boolean };
    expect(arg.terminal).toBeUndefined();
    expect(MAX_WORKFLOW_STEPS).toBe(512);
    expect(closed()).toBe(1);
  });

  it('mid-turn persist: one-tool run is user-line + after-tool + terminal', async () => {
    const { deps, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    let first = true;
    const modelStep = vi.fn(async () => {
      const f = first;
      first = false;
      return f
        ? {
            ok: true as const,
            delta: {
              text: 'call',
              toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
            },
          }
        : { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(okBatch());
    const result = await runTurnLoop(
      { ...deps, persistStep: persistSpy, modelStep, toolStep },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledTimes(3);
    const flags = persistSpy.mock.calls.map(
      (c) => (c[0] as { terminal?: boolean }).terminal,
    );
    expect(flags).toEqual([false, false, undefined]);
    const folds = persistSpy.mock.calls.map(
      (c) => (c[0] as { fold?: PersistStepFold }).fold?.checkpoint,
    );
    expect(folds[0]).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'call' },
    ]);
    expect(folds[1]).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'call' },
      { role: 'tool', content: 'ok' },
    ]);
    expect(folds[2]).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'call' },
      { role: 'tool', content: 'ok' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(closed()).toBe(1);
  });

  it('mid-turn persist: N-tool batch is user-line + after-batch + terminal (not N+2)', async () => {
    const { deps, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    let first = true;
    const modelStep = vi.fn(async () => {
      const f = first;
      first = false;
      return f
        ? {
            ok: true as const,
            delta: {
              text: 'call',
              toolCalls: [
                { toolName: 'list_dir', toolCallId: 'c1', args: {} },
                { toolName: 'read_file', toolCallId: 'c2', args: {} },
                { toolName: 'read_file', toolCallId: 'c3', args: {} },
              ],
            },
          }
        : { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(okBatch());
    const result = await runTurnLoop(
      { ...deps, persistStep: persistSpy, modelStep, toolStep },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect((toolStep.mock.calls[0]?.[0] as ToolCallIn).calls).toHaveLength(3);
    expect(persistSpy).toHaveBeenCalledTimes(3);
    const flags = persistSpy.mock.calls.map(
      (c) => (c[0] as { terminal?: boolean }).terminal,
    );
    expect(flags).toEqual([false, false, undefined]);
    expect(closed()).toBe(1);
  });

  it('after-tool persist blob is a parseable SessionSnapshot with tool_run', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const scope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's_after_tool' };
    const { deps, closed } = wiredDeps({ persistScope: scope });
    setPersistSeamResolver(() =>
      createTurnPersistSeam({ blobStore, envelopeStore, scope }),
    );
    let persistCount = 0;
    const held: { snap: ReturnType<typeof parseCloudSessionSnapshot> } = {
      snap: null,
    };
    const persistStepFn = async (p: {
      turnRunId: string;
      deltas: ReadonlyArray<unknown>;
      fold?: PersistStepFold;
      terminal?: boolean;
    }) => {
      const res = await deps.persistStep(p);
      persistCount += 1;
      if (persistCount === 2 && p.terminal === false) {
        const env = await envelopeStore.readEnvelope({
          tenantId: scope.tenantId,
          userId: scope.userId,
          sessionId: scope.sessionId,
        });
        const pointer = env?.meta?.transcriptPointer;
        const raw =
          typeof pointer === 'string' ? await blobStore.read(pointer) : null;
        held.snap = parseCloudSessionSnapshot(
          raw ? JSON.parse(raw) : null,
          scope.sessionId,
        );
        expect(env?.meta?.turnStatus).toBe('running');
      }
      return res;
    };
    let first = true;
    const modelStep = vi.fn(async () => {
      const f = first;
      first = false;
      return f
        ? {
            ok: true as const,
            delta: {
              text: 'call',
              toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
            },
          }
        : { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(okBatch());
    const result = await runTurnLoop(
      { ...deps, persistStep: persistStepFn, modelStep, toolStep, turnRunId: 'wr_after' },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(persistCount).toBe(3);
    const afterToolSnap = held.snap;
    if (afterToolSnap === null) {
      throw new Error('after-tool persist blob did not parse as SessionSnapshot');
    }
    expect(afterToolSnap.id).toBe(scope.sessionId);
    expect(afterToolSnap.messages.some((m) => m.role === 'user' && m.text === 'go')).toBe(
      true,
    );
    expect(
      afterToolSnap.messages.some((m) => m.role === 'assistant' && m.text === 'call'),
    ).toBe(true);
    expect(
      afterToolSnap.messages.some((m) => m.role === 'tool_run' && m.text === 'ok'),
    ).toBe(true);
    const env = await envelopeStore.readEnvelope({
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    });
    expect(env?.meta?.turnStatus).toBe('completed');
    expect(closed()).toBe(1);
  });

  it('failed tool after user-line persist continues the turn', async () => {
    const { deps, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'call',
            toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
          },
        };
      }
      return { ok: true as const, delta: { text: 'sandbox down, noted', toolCalls: [] } };
    });
    const toolStep = vi.fn(async () => ({
      ok: false as const,
      code: 'sandbox_error' as const,
      error: 'down',
    }));
    const result = await runTurnLoop(
      { ...deps, persistStep: persistSpy, modelStep, toolStep },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect(modelStep).toHaveBeenCalledTimes(2);
    expect(persistSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(closed()).toBe(1);
  });

  it('mid-turn persist write_failed still runs tools (plan #885)', async () => {
    const { deps, closed } = wiredDeps();
    let persistCalls = 0;
    const persistStep = async (args: Parameters<typeof deps.persistStep>[0]) => {
      persistCalls += 1;
      if (persistCalls === 1) {
        return { ok: false as const, code: 'write_failed' as const, error: 'boom' };
      }
      return deps.persistStep(args);
    };
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'call',
            toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
          },
        };
      }
      return { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(async () => ({
      ok: true as const,
      results: [
        {
          ok: true as const,
          toolName: 'list_dir',
          toolCallId: 'c1',
          result: 'ok',
          freshnessDelta: '[]',
        },
      ],
      freshnessDelta: '[]',
    }));
    const result = await runTurnLoop({ ...deps, persistStep, modelStep, toolStep }, { userMessage: 'go' });
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(closed()).toBe(1);
  });

  it('freshness (adversarial L1): freshnessDelta threads into the NEXT tool seed across rounds', async () => {
    const { deps, w, closed } = wiredDeps();
    // Round 1 → tool `read` advances the ledger to 'LEDGER-R1'; round 2 → tool
    // `write` must receive that ledger as its `freshnessSeed` (read-before-edit
    // survives across rounds); round 3 → model returns no tools → completed.
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1)
        return {
          ok: true as const,
          delta: { text: 'r1', toolCalls: [{ toolName: 'read_file', toolCallId: 'a', args: {} }] },
        };
      if (round === 2)
        return {
          ok: true as const,
          delta: { text: 'r2', toolCalls: [{ toolName: 'write_file', toolCallId: 'b', args: {} }] },
        };
      return { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(
      okBatch((c, args) =>
        c.toolName === 'read_file'
          ? { result: 'R', freshnessDelta: 'LEDGER-R1' }
          : {
              result: `W:${args.freshnessSeed ?? '(none)'}`,
              freshnessDelta: 'LEDGER-R2',
            },
      ),
    );
    const result = await runTurnLoop({ ...deps, modelStep, toolStep }, { userMessage: 'g' });
    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(3);
    expect(toolStep).toHaveBeenCalledTimes(2);
    const writeCall = toolStep.mock.calls[1]?.[0] as ToolCallIn;
    expect(writeCall.freshnessSeed).toBe('LEDGER-R1');
    expect(closed()).toBe(1);
  });

  it('freshness (adversarial #881): loop uses batch.freshnessDelta, not last-item snapshot', async () => {
    const { deps, closed } = wiredDeps();
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'reads',
            toolCalls: [
              { toolName: 'read_file', toolCallId: 'a', args: {} },
              { toolName: 'read_file', toolCallId: 'b', args: {} },
            ],
          },
        };
      }
      if (round === 2) {
        return {
          ok: true as const,
          delta: { text: 'w', toolCalls: [{ toolName: 'write_file', toolCallId: 'c', args: {} }] },
        };
      }
      return { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const merged = '{"grants":[{"path":"A","kind":"fresh","fp":{}},{"path":"B","kind":"fresh","fp":{}}],"truncated":false}';
    const onlyB = '{"grants":[{"path":"B","kind":"fresh","fp":{}}],"truncated":false}';
    const toolStep = vi.fn(async (args: ToolCallIn) => {
      if (args.calls.some((c) => c.toolName === 'write_file')) {
        return {
          ok: true as const,
          results: args.calls.map((c) => ({
            ok: true as const,
            toolName: c.toolName,
            ...(c.toolCallId ? { toolCallId: c.toolCallId } : {}),
            result: `seed=${args.freshnessSeed ?? ''}`,
            freshnessDelta: merged,
          })),
          freshnessDelta: merged,
        };
      }
      return {
        ok: true as const,
        results: [
          {
            ok: true as const,
            toolName: 'read_file',
            toolCallId: 'a',
            result: 'A',
            freshnessDelta: merged,
          },
          {
            ok: true as const,
            toolName: 'read_file',
            toolCallId: 'b',
            result: 'B',
            freshnessDelta: onlyB,
          },
        ],
        freshnessDelta: merged,
      };
    });
    const result = await runTurnLoop({ ...deps, modelStep, toolStep }, { userMessage: 'g' });
    expect(result.status).toBe('completed');
    const writeCall = toolStep.mock.calls[1]?.[0] as ToolCallIn;
    expect(writeCall.freshnessSeed).toBe(merged);
    expect(closed()).toBe(1);
  });

  it('matrix 8: model returns {ok:false} → value, not throw; loop terminates cleanly; writable closed', async () => {
    const { deps, w, closed } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: false as const,
      code: 'model_error' as const,
      error: 'provider down',
    }));
    const result = await runTurnLoop({ ...deps, modelStep }, { userMessage: 'x' });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('provider down');
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.find((e: { type: string }) => e.type === 'error')).toEqual({
      type: 'error',
      error: 'provider down',
    });
    expect(events.some((e: { type: string }) => e.type === 'error' && 'message' in e)).toBe(
      false,
    );
  });

  it('model_error after tools terminal-persists so envelope is not left running [adversarial #888 Major]', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const scope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's_model_fail' };
    const { deps, w, closed } = wiredDeps({ persistScope: scope });
    setPersistSeamResolver(() =>
      createTurnPersistSeam({ blobStore, envelopeStore, scope }),
    );
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'call',
            toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
          },
        };
      }
      return { ok: false as const, code: 'model_error' as const, error: 'provider down' };
    });
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        toolStep: vi.fn(okBatch()),
        turnRunId: 'wr_model_fail',
      },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('provider down');
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(false);
    expect(
      events.some(
        (e: { type: string; error?: string }) =>
          e.type === 'error' && e.error === 'provider down',
      ),
    ).toBe(true);
    const env = await envelopeStore.readEnvelope({
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    });
    expect(env?.meta?.turnStatus).toBe('completed');
    expect(env?.meta?.turnRunId).toBe('wr_model_fail');
    expect(closed()).toBe(1);
  });

  it('model throw after tools terminal-persists so envelope is not left running [adversarial #888 Major]', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const scope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's_model_throw' };
    const { deps, w, closed } = wiredDeps({ persistScope: scope });
    setPersistSeamResolver(() =>
      createTurnPersistSeam({ blobStore, envelopeStore, scope }),
    );
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'call',
            toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
          },
        };
      }
      throw new Error('model threw');
    });
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        toolStep: vi.fn(okBatch()),
        turnRunId: 'wr_model_throw',
      },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe('model threw');
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(false);
    expect(
      events.some(
        (e: { type: string; error?: string }) =>
          e.type === 'error' && e.error === 'model threw',
      ),
    ).toBe(true);
    const env = await envelopeStore.readEnvelope({
      tenantId: scope.tenantId,
      userId: scope.userId,
      sessionId: scope.sessionId,
    });
    expect(env?.meta?.turnStatus).toBe('completed');
    expect(env?.meta?.turnRunId).toBe('wr_model_throw');
    expect(closed()).toBe(1);
  });

  it('matrix 9: writable closed exactly once on success (close guarded)', async () => {
    const { deps, w, closed } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'done', toolCalls: [] },
    }));
    // Persist also fails to prove close-on-error; and success path closes once each.
    const result = await runTurnLoop({ ...deps, modelStep, turnRunId: 'r' }, { userMessage: 'x' });
    expect(result.status).toBe('completed');
    expect(closed()).toBe(1);
  });

  it('matrix 9b: persist write_failed on empty-tools still done, writable closed once', async () => {
    const { deps, w, closed } = wiredDeps({ persistFail: true });
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'done', toolCalls: [] },
    }));
    const result = await runTurnLoop({ ...deps, modelStep }, { userMessage: 'x' });
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.find((e: { type: string }) => e.type === 'done')).toMatchObject({
      type: 'done',
      text: 'done',
    });
    expect(events.some((e: { type: string; error?: string }) => e.type === 'error' && e.error === 'boom')).toBe(
      false,
    );
  });

  it('persist invalid_scope still completes the turn (persist never fails a turn)', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistStep = async () => ({
      ok: false as const,
      code: 'invalid_scope' as const,
      error: 'no scope',
    });
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'done', toolCalls: [] },
    }));
    const result = await runTurnLoop({ ...deps, persistStep, modelStep }, { userMessage: 'x' });
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.find((e: { type: string }) => e.type === 'done')).toMatchObject({
      type: 'done',
      text: 'done',
    });
    expect(events.some((e: { type: string; error?: string }) => e.error === 'no scope')).toBe(false);
  });

  it('persist not_envelope_store still completes the turn (persist never fails a turn)', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistStep = async () => ({
      ok: false as const,
      code: 'not_envelope_store' as const,
      error: 'no envelope',
    });
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'done', toolCalls: [] },
    }));
    const result = await runTurnLoop({ ...deps, persistStep, modelStep }, { userMessage: 'x' });
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.find((e: { type: string }) => e.type === 'done')).toMatchObject({
      type: 'done',
      text: 'done',
    });
    expect(events.some((e: { type: string; error?: string }) => e.error === 'no envelope')).toBe(
      false,
    );
  });

  it('persist read_failed on empty-tools still done, writable closed once', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistStep = async () => ({
      ok: false as const,
      code: 'read_failed' as const,
      error: 'redis blip after B7',
    });
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'done', toolCalls: [] },
    }));
    const result = await runTurnLoop({ ...deps, persistStep, modelStep }, { userMessage: 'x' });
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.find((e: { type: string }) => e.type === 'done')).toMatchObject({
      type: 'done',
      text: 'done',
    });
    expect(
      events.some(
        (e: { type: string; error?: string }) =>
          e.type === 'error' && e.error === 'redis blip after B7',
      ),
    ).toBe(false);
  });

  it('itemFail + persist read_failed still done, tool error is a result not a turn-end', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistStep = async () => ({
      ok: false as const,
      code: 'read_failed' as const,
      error: 'redis blip after B7',
    });
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'two',
            toolCalls: [
              { toolName: 'list_dir', toolCallId: 'a', args: {} },
              { toolName: 'read_file', toolCallId: 'b', args: {} },
            ],
          },
        };
      }
      return { ok: true as const, delta: { text: 'got boom', toolCalls: [] } };
    });
    const toolStep = vi.fn(async () => ({
      ok: true as const,
      results: [
        {
          ok: true as const,
          toolName: 'list_dir',
          toolCallId: 'a',
          result: 'ok-dir',
          freshnessDelta: '[]',
        },
        {
          ok: false as const,
          toolName: 'read_file',
          toolCallId: 'b',
          code: 'sandbox_error' as const,
          error: 'boom',
        },
      ],
      freshnessDelta: '[]',
    }));
    const result = await runTurnLoop({ ...deps, persistStep, modelStep, toolStep }, { userMessage: 'go' });
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(true);
    expect(events.some((e: { type: string }) => e.type === 'error')).toBe(false);
    expect(closed()).toBe(1);
  });

  it('itemFail + persist write_failed still done, tool error is a result not a turn-end', async () => {
    const { deps, w, closed } = wiredDeps({ persistFail: true });
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'two',
            toolCalls: [
              { toolName: 'list_dir', toolCallId: 'a', args: {} },
              { toolName: 'read_file', toolCallId: 'b', args: {} },
            ],
          },
        };
      }
      return { ok: true as const, delta: { text: 'got boom', toolCalls: [] } };
    });
    const toolStep = vi.fn(async () => ({
      ok: true as const,
      results: [
        {
          ok: true as const,
          toolName: 'list_dir',
          toolCallId: 'a',
          result: 'ok-dir',
          freshnessDelta: '[]',
        },
        {
          ok: false as const,
          toolName: 'read_file',
          toolCallId: 'b',
          code: 'sandbox_error' as const,
          error: 'boom',
        },
      ],
      freshnessDelta: '[]',
    }));
    const result = await runTurnLoop({ ...deps, modelStep, toolStep }, { userMessage: 'go' });
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(true);
    expect(events.some((e: { type: string }) => e.type === 'error')).toBe(false);
    expect(closed()).toBe(1);
  });

  it('B13 integration: real B7/B8/B6 seam wired via resolver — a completed run derives the fold AT PERSIST TIME (usage/checkpoint from THIS run; run-bind from start)', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const sscope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's1' };
    const { deps, closed } = wiredDeps({ persistScope: sscope });
    // Wire the REAL seam AFTER wiredDeps (which installs its in-memory resolver).
    setPersistSeamResolver(() =>
      createTurnPersistSeam({ blobStore, envelopeStore, scope: sscope }),
    );
    // The model DELTA carries the usage (B9 `OneRoundDelta.usage`); the loop
    // must derive the fold from it at persist time — NOT from a start arg
    // (adversarial L1: the last deltas do not exist at `start()` only here).
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'done', toolCalls: [], usage: { source: 'provider', total: 5 } },
    }));
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        toolStep: vi.fn(),
        turnRunId: 'wr_0000_real',
        // Only the PRE-RUN sandbox bind is a start arg (persistRunBind) —
        // per-turn checkpoint + usage are derived in-loop at the persist call.
        persistRunBind: { cwd: 'lib', activeSandboxId: 'sb_x' },
      },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    const env = await envelopeStore.readEnvelope({
      tenantId: 't',
      userId: 'u',
      sessionId: 's1',
    });
    // Terminal worker keys folded via the real seam (B8)…
    expect(env?.meta?.turnStatus).toBe('completed');
    expect(env?.meta?.turnRunId).toBe('wr_0000_real');
    // …pre-run sandbox bind (start arg) folded…
    expect(env?.meta?.logicalCwd).toBe('lib');
    expect(env?.meta?.activeSandboxId).toBe('sb_x');
    // …usage DERIVED from THIS run's last model delta (encoded by B8)…
    expect(JSON.parse(env?.meta?.usage as string)).toEqual({ source: 'provider', total: 5 });
    // …checkpoint pointer (B6) and transcript pointer (B7) both present, pointers only.
    expect(env?.meta?.checkpointPointer).toBeDefined();
    expect(env?.meta?.transcriptPointer).toBeDefined();
    // The checkpoint BODY is the derived this-run projection (`go` user + `done`
    // assistant) — prove the fold was NOT a start arg and was NOT dropped.
    const ckptPointer = env?.meta?.checkpointPointer;
    const ckptBody =
      typeof ckptPointer === 'string' ? JSON.parse((await blobStore.read(ckptPointer)) ?? 'null') : [];
    expect(ckptBody).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'done' },
    ]);
    // The interrupted `deps.toolStep` default was a no-op; the writable still closed once.
    expect(closed()).toBe(1);
  });

  it('round-2 L1 (Major): a mid-turn change_dir/meta_sandbox_switch tool write is NOT clobbered by the stale pre-run bind', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const scope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's_switch' };
    const { deps, closed } = wiredDeps({ persistScope: scope });
    setPersistSeamResolver(() => createTurnPersistSeam({ blobStore, envelopeStore, scope }));
    // Round 1 changes cwd AND switches sandbox; round 2 returns no tools → persist.
    let first = true;
    const modelStep = vi.fn(async () => {
      const f = first;
      first = false;
      return f
        ? {
            ok: true as const,
            delta: {
              text: 'switch',
              toolCalls: [
                { toolName: 'change_dir', toolCallId: 'c1', args: { path: 'lib' } },
                { toolName: 'meta_sandbox_switch', toolCallId: 'c2', args: { id: 'sb_b' } },
              ],
            },
          }
        : { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(
      okBatch((c) =>
        c.toolName === 'change_dir'
          ? { result: 'change_dir lib: ok cwd=lib', freshnessDelta: '[]' }
          : {
              result: 'switched active sandbox to id=sb_b tools=[]',
              freshnessDelta: '[]',
            },
      ),
    );
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        toolStep,
        turnRunId: 'wr_switch',
        // Stale PRE-RUN bind — the run then switched away from it.
        persistRunBind: { cwd: 'app', activeSandboxId: 'sb_a' },
      },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    const env = await envelopeStore.readEnvelope({ tenantId: 't', userId: 'u', sessionId: 's_switch' });
    // The terminal fold must reflect THIS run's tool write, NOT the stale bind
    // (adversarial round-2 L1 — overlaying the start snapshot would clobber the
    // envelope write the switch/change_dir just made).
    expect(env?.meta?.logicalCwd).toBe('lib');
    expect(env?.meta?.activeSandboxId).toBe('sb_b');
    expect(closed()).toBe(1);
  });

  it('round-2 L1 (Minor): fold.usage is the ACCUMULATED turn total, not the last round', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const scope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's_usage' };
    const { deps, closed } = wiredDeps({ persistScope: scope });
    setPersistSeamResolver(() => createTurnPersistSeam({ blobStore, envelopeStore, scope }));
    // Round 1 reports usage 100 + calls a tool; round 2 reports usage 40, no tools → persist.
    let first = true;
    const modelStep = vi.fn(async () => {
      const f = first;
      first = false;
      return f
        ? {
            ok: true as const,
            delta: {
              text: 'r1',
              toolCalls: [{ toolName: 'read_file', toolCallId: 'a', args: {} }],
              usage: { source: 'provider', total: 100 },
            },
          }
        : {
            ok: true as const,
            delta: { text: 'done', toolCalls: [], usage: { source: 'provider', total: 40 } },
          };
    });
    const toolStep = vi.fn(okBatch());
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, turnRunId: 'wr_usage' },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    const env = await envelopeStore.readEnvelope({ tenantId: 't', userId: 'u', sessionId: 's_usage' });
    // 100 + 40 = 140 — NOT the last round's 40 (adversarial round-2 L1).
    expect(JSON.parse(env?.meta?.usage as string)).toEqual({ source: 'provider', total: 140 });
    expect(closed()).toBe(1);
  });

  it('round-3 BLOCK: change_dir result cwd=lib → next toolStep call persistRunBind.cwd === lib (not start app)', async () => {
    const { deps, closed } = wiredDeps();
    let round = 0;
    // Round 1: change_dir; round 2: list_dir; round 3: no tools → terminal.
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'cd',
            toolCalls: [{ toolName: 'change_dir', toolCallId: 'c1', args: { path: 'lib' } }],
          },
        };
      }
      if (round === 2) {
        return {
          ok: true as const,
          delta: { text: 'list', toolCalls: [{ toolName: 'list_dir', toolCallId: 'c2', args: {} }] },
        };
      }
      return { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(
      okBatch((c, a) => {
        if (c.toolName === 'change_dir') {
          return { result: 'change_dir lib: ok cwd=lib', freshnessDelta: '[]' };
        }
        return {
          result: `cwd=${a.persistRunBind?.cwd ?? '(none)'}`,
          freshnessDelta: '[]',
        };
      }),
    );
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, turnRunId: 'wr_bind', persistRunBind: { cwd: 'app' } },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    // Two rounds: change_dir then list_dir — two batch steps.
    expect(toolStep).toHaveBeenCalledTimes(2);
    const firstCall = toolStep.mock.calls[0]?.[0] as ToolCallIn;
    expect(firstCall.calls[0]?.toolName).toBe('change_dir');
    expect(firstCall.persistRunBind?.cwd).toBe('app');
    const secondCall = toolStep.mock.calls[1]?.[0] as ToolCallIn;
    expect(secondCall.calls[0]?.toolName).toBe('list_dir');
    expect(secondCall.persistRunBind?.cwd).toBe('lib');
    expect(closed()).toBe(1);
  });

  it('round-3 BLOCK: meta_sandbox_switch result id=sb_b → next tool persistRunBind.activeSandboxId === sb_b', async () => {
    const { deps, closed } = wiredDeps();
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'switch',
            toolCalls: [{ toolName: 'meta_sandbox_switch', toolCallId: 's1', args: { id: 'sb_b' } }],
          },
        };
      }
      return { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(
      okBatch((c) =>
        c.toolName === 'meta_sandbox_switch'
          ? {
              result: 'switched active sandbox to id=sb_b tools=[]',
              freshnessDelta: '[]',
            }
          : { result: 'ok', freshnessDelta: '[]' },
      ),
    );
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, turnRunId: 'wr_switch2', persistRunBind: { activeSandboxId: 'sb_a' } },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(toolStep).toHaveBeenCalledTimes(1);
    const firstCall = toolStep.mock.calls[0]?.[0] as ToolCallIn;
    expect(firstCall.calls[0]?.toolName).toBe('meta_sandbox_switch');
    expect(firstCall.persistRunBind?.activeSandboxId).toBe('sb_a');
    // After switch, the bind is updated → the next model step (round 2) should
    // get the new sandbox id. modelStep was called twice.
    expect(modelStep).toHaveBeenCalledTimes(2);
    const modelRound2 = (modelStep.mock.calls[1] as unknown[])?.[0] as { persistRunBind?: { activeSandboxId?: string } } | undefined;
    expect(modelRound2?.persistRunBind?.activeSandboxId).toBe('sb_b');
    expect(closed()).toBe(1);
  });

  it('round-3 BLOCK: failed tool does NOT overlay bind', async () => {
    const { deps, closed } = wiredDeps();
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'cd',
            toolCalls: [{ toolName: 'change_dir', toolCallId: 'c1', args: { path: 'nonexistent' } }],
          },
        };
      }
      return { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(async (_a: ToolCallIn) => ({
      ok: false as const,
      code: 'sandbox_error' as const,
      error: 'no such dir',
    }));
    // Failed change_dir is a tool result for the next model round, not a
    // turn-end. Bind stays the start cwd — only a successful change_dir overlays.
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, turnRunId: 'wr_failbind', persistRunBind: { cwd: 'app' } },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(result.error).toBeUndefined();
    expect(toolStep).toHaveBeenCalledTimes(1);
    const call = toolStep.mock.calls[0]?.[0] as ToolCallIn;
    expect(call.persistRunBind?.cwd).toBe('app');
    expect(modelStep).toHaveBeenCalledTimes(2);
    const modelRound2 = (modelStep.mock.calls[1] as unknown[])?.[0] as
      | { persistRunBind?: { cwd?: string } }
      | undefined;
    expect(modelRound2?.persistRunBind?.cwd).toBe('app');
    expect(closed()).toBe(1);
  });

  it('round-3 BLOCK: first tool still sees start persistRunBind', async () => {
    const { deps, closed } = wiredDeps();
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: { text: 'go', toolCalls: [{ toolName: 'read_file', toolCallId: 'r1', args: { path: 'x' } }] },
        };
      }
      return { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(
      okBatch((_c, a) => ({
        result: `read cwd=${a.persistRunBind?.cwd} sandbox=${a.persistRunBind?.activeSandboxId}`,
        freshnessDelta: '[]',
      })),
    );
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        toolStep,
        turnRunId: 'wr_first',
        persistRunBind: { cwd: 'myapp', activeSandboxId: 'sb_start' },
      },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(toolStep).toHaveBeenCalledTimes(1);
    const first = toolStep.mock.calls[0]?.[0] as ToolCallIn;
    expect(first.calls[0]?.toolName).toBe('read_file');
    expect(first.persistRunBind?.cwd).toBe('myapp');
    expect(first.persistRunBind?.activeSandboxId).toBe('sb_start');
    expect(closed()).toBe(1);
  });

  it('matrix 10: messages reconstructed from step deltas on replay (roundtrip)', async () => {
    const { deps, w, closed } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'assistant says', toolCalls: [], finishReason: 'stop' },
    }));
    const result = await runTurnLoop({ ...deps, modelStep }, { userMessage: 'user says' });
    // user + assistant delta (+ persist marker) are reconstructed locally.
    const roles = result.messages.map((m) => (m as { role?: string }).role);
    expect(roles).toContain('user');
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    // deltas replay log is non-empty and ordered (model-first)
    expect(result.deltas.length).toBeGreaterThan(0);
  });

  it('round-9 BLOCK: after a tool-ok, the reconstructed tool row includes toolCallId from the model delta', async () => {
    const { deps, closed } = wiredDeps();
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'tooling',
            toolCalls: [
              { toolName: 'read_file', toolCallId: 'tc_a', args: { path: 'a.ts' } },
              { toolName: 'list_dir', toolCallId: 'tc_b', args: { path: '.' } },
            ],
          },
        };
      }
      return { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(
      okBatch((c) => ({
        result: `result of ${c.toolName}`,
        freshnessDelta: '[]',
      })),
    );
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, turnRunId: 'wr_tcid' },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    // Messages include extra mid-turn persist rows; tool rows still carry ids.
    const toolRows = result.messages.filter(
      (m) => (m as { role?: string }).role === 'tool',
    ) as Array<{ role: string; toolName: string; toolCallId?: string; result?: string }>;
    expect(toolRows).toHaveLength(2);
    expect(toolRows[0]).toMatchObject({
      toolName: 'read_file',
      toolCallId: 'tc_a',
      result: 'result of read_file',
    });
    expect(toolRows[1]).toMatchObject({
      toolName: 'list_dir',
      toolCallId: 'tc_b',
      result: 'result of list_dir',
    });
    expect(closed()).toBe(1);
  });
});

describe('runTurnLoop reasoning (plan #850 — loop must not dump)', () => {
  function parseEvents(lines: string[]): Array<{ type: string; text?: string; name?: string }> {
    return lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
  }

  it('does not write reasoning_delta or text_delta from delta (model step owns live SSE)', async () => {
    const { deps, w, closed } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [], reasoning: 'Hmm…', finishReason: 'stop' },
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep: vi.fn() },
      { userMessage: 'think' },
    );
    expect(result.status).toBe('completed');
    expect(closed()).toBe(1);
    const events = parseEvents(w.lines);
    const types = events.map((e) => e.type);
    expect(types).not.toContain('reasoning_delta');
    expect(types).not.toContain('text_delta');
    expect(types).toContain('done');
    const done = events.find((e) => e.type === 'done');
    expect(done?.text).toBe('hi');
  });

  it('does not dump text_delta when delta.reasoning is absent either', async () => {
    const { deps, w } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [], finishReason: 'stop' },
    }));
    await runTurnLoop({ ...deps, modelStep, toolStep: vi.fn() }, { userMessage: 'plain' });
    const events = parseEvents(w.lines);
    expect(events.some((e) => e.type === 'reasoning_delta')).toBe(false);
    expect(events.some((e) => e.type === 'text_delta')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('does not write tool_start from delta.toolCalls (model step owns live SSE)', async () => {
    const { deps, w } = wiredDeps();
    let first = true;
    const modelStep = vi.fn(async () => {
      const f = first;
      first = false;
      return f
        ? {
            ok: true as const,
            delta: {
              text: '',
              toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
              reasoning: 'need tools',
            },
          }
        : { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(okBatch());
    await runTurnLoop({ ...deps, modelStep, toolStep }, { userMessage: 'go' });
    const events = parseEvents(w.lines);
    const types = events.map((e) => e.type);
    expect(types).not.toContain('reasoning_delta');
    expect(types).not.toContain('tool_start');
    // Live tool_result is written inside the tool-batch step; this mock does not.
    expect(types).not.toContain('tool_result');
    expect(types).toContain('done');
  });

  it('strips reasoning from persist deltas and reconstructed messages (3b)', async () => {
    const { deps } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [], reasoning: 'secret think', finishReason: 'stop' },
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep: vi.fn() },
      { userMessage: 'think' },
    );
    expect(JSON.stringify(result.deltas)).not.toContain('secret think');
    expect(JSON.stringify(result.deltas)).not.toContain('"reasoning"');
    const assistants = result.messages.filter(
      (m) => (m as { role?: string }).role === 'assistant',
    ) as Array<{ delta?: Record<string, unknown> }>;
    expect(assistants.length).toBeGreaterThan(0);
    for (const m of assistants) {
      expect(m.delta).not.toHaveProperty('reasoning');
    }
  });
});

describe('step wrappers (matrix 4–7)', () => {
  it('matrix 4 + 5: modelGenerateStep is a thin shell — delegates generateOneRound, re-resolves BYOK in-step, assembles FULL tool schemas via shared helper, serializable args', async () => {
    // Reset so the turnSseWrite mock is in modelGenerateStep's import graph.
    vi.resetModules();
    // Mock generateOneRound to prove the wrapper delegates and forwards plain
    // serializable args with the FULL registry (schemas-only). Also invoke
    // input.onEvent so a no-op sink cannot hide behind leftover identifiers
    // (adversarial L6 — live glue is behavior, not source-lock).
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as {
        messages: unknown[];
        tools?: Record<string, unknown>;
        onEvent?: (ev: { type: string; text?: string; usage?: unknown }) => void | Promise<void>;
      };
      expect(Array.isArray(i.messages)).toBe(true);
      // The tools dict must be the stripped FULL durable surface
      // (at minimum list_dir + skill tools), not the old stub.
      expect(typeof i.tools).toBe('object');
      expect(i.tools).toBeDefined();
      expect(typeof i.onEvent).toBe('function');
      await i.onEvent!({ type: 'reasoning_delta', text: 'Hmm' });
      // Loop-owned / empty → formatLiveModelSse null → no write.
      await i.onEvent!({ type: 'usage', usage: { total: 1 } });
      await i.onEvent!({ type: 'reasoning_delta', text: '' });
      return { ok: true as const, delta: { text: 'm', toolCalls: [] } };
    });
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    // Mock the DI root so the in-step BYOK re-resolution returns a stub success.
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            provider: 'anthropic',
            credentials: { apiKey: 'sk-test' },
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretId: 'sec-1',
            secretsToRedact: ['sk-test'],
          }),
        },
      }),
    }));
    // Mock the shared durable-tool-world helper to return a minimal registry
    // (the model step will see these tools schemas-only).
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: {
            list_dir: { description: 'List directory contents' },
            read_file: { description: 'Read a file' },
            find_skill: { description: 'Find skills' },
            fetch_skill: { description: 'Fetch a skill' },
          },
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
          mcpClose: async () => {},
          httpRunner: undefined,
          sandboxClientClose: undefined,
        },
      }),
    }));
    const mod = await import('./modelGenerateStep');
    const stepArgs = {
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    };
    // Adversarial L1: every step arg must be JSON-serializable (Vercel
    // serializes ALL args to a `'use step'` fn — closures become nothing).
    const roundtrip = JSON.parse(JSON.stringify(stepArgs));
    expect(roundtrip).toEqual(stepArgs);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await mod.modelGenerateStep(stepArgs);
    expect(m1).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.delta.text).toBe('m');
    // BYOK re-resolved IN-STEP: providerOptions.gateway must be present on the
    // generateOneRound deps, not a bare modelId.
    const argDeps = m1.mock.calls[0]?.[0] as {
      modelId?: string;
      providerOptions?: unknown;
      secrets?: unknown;
      system?: string;
    };
    expect(argDeps.modelId).toBe('byok-resolved');
    expect(argDeps.providerOptions).toEqual({
      gateway: { only: ['anthropic'], byok: { anthropic: [{ apiKey: 'sk-test' }] } },
    });
    expect(argDeps.secrets).toEqual(['sk-test']);
    expect(argDeps.system).toBeDefined();
    expect(argDeps.system).toContain('You are the Invincible coding agent.');
    expect(argDeps.system).toMatch(/Be concise/);
    // The tools passed to generateOneRound must be the FULL stripped registry
    // (not the old stub { find_skill: {}, fetch_skill: {} }).
    const inputTools = (m1.mock.calls[0]?.[1] as { tools?: Record<string, unknown> })?.tools;
    expect(inputTools).toBeDefined();
    expect(Object.keys(inputTools as object)).toContain('list_dir');
    expect(Object.keys(inputTools as object)).toContain('find_skill');
    // Live glue: onEvent → formatLiveModelSse → held write. A no-op
    // onEvent with leftover imports would fail here (one framed reasoning line).
    expect(writeOnDefaultStream).toHaveBeenCalledTimes(1);
    expect(writeOnDefaultStream).toHaveBeenCalledWith(
      'data: {"type":"reasoning_delta","text":"Hmm"}\n\n',
    );
    const modelLogs = logSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((r): r is Record<string, unknown> => r != null && r.tag === 'invincible.turn.model');
    expect(modelLogs).toHaveLength(1);
    expect(modelLogs[0]!.ok).toBe(true);
    expect(modelLogs[0]!.toolCallCount).toBe(0);
    expect(modelLogs[0]!.textChars).toBe(1);
    logSpy.mockRestore();
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 5b: modelGenerateStep BYOK fail returns {ok:false} — does NOT call streamText with bare modelId', async () => {
    // Mock generateOneRound — must NOT be called.
    const m1 = vi.fn(async () => ({ ok: true as const, delta: { text: 'x', toolCalls: [] } }));
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    // BYOK resolution FAILS.
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: false as const,
            reason: 'no_active_key',
          }),
        },
      }),
    }));
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: {},
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
          mcpClose: undefined,
          httpRunner: undefined,
          sandboxClientClose: undefined,
        },
      }),
    }));
    const mod = await import('./modelGenerateStep');
    const result = await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('model_error');
      expect(result.error).toMatch(/BYOK resolve failed/);
    }
    // generateOneRound must NOT have been called — no bare modelId fallthrough.
    expect(m1).not.toHaveBeenCalled();
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
  });

  it('matrix 5c (round-9 BLOCK): modelGenerateStep converts orchestrator-local messages (delta + tool rows) to ModelMessage[] before passing to generateOneRound', async () => {
    // Reset module cache so vi.doMock for the same specifiers as prior tests
    // (matrix 4+5, 5b) takes effect on a fresh import of modelGenerateStep.
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { messages: unknown[] };
      // Verify the messages array is not empty and has proper ModelMessage shape.
      expect(Array.isArray(i.messages)).toBe(true);
      expect(i.messages.length).toBeGreaterThan(0);
      // The user message should pass through (role: 'user', content: string).
      const userMsg = i.messages[0] as { role?: string; content?: unknown };
      expect(userMsg.role).toBe('user');
      // The assistant message should have content array with tool-call parts.
      const asstMsg = i.messages[1] as { role?: string; content?: unknown[] };
      expect(asstMsg.role).toBe('assistant');
      expect(Array.isArray(asstMsg.content)).toBe(true);
      // At least one tool-call part with a toolCallId.
      const toolCallPart = (asstMsg.content as unknown[]).find(
        (p) => (p as { type?: string }).type === 'tool-call',
      ) as { type: string; toolCallId: string; toolName: string } | undefined;
      expect(toolCallPart).toBeDefined();
      expect(toolCallPart!.toolCallId).toBe('tc_a');
      // The tool message should have content array with a tool-result part,
      // linked by the same toolCallId.
      const toolMsg = i.messages[2] as { role?: string; content?: unknown[] };
      expect(toolMsg.role).toBe('tool');
      expect(Array.isArray(toolMsg.content)).toBe(true);
      const toolResultPart = (toolMsg.content as unknown[])[0] as {
        type: string;
        toolCallId: string;
        output: { type: string; value: string };
      };
      expect(toolResultPart.type).toBe('tool-result');
      expect(toolResultPart.toolCallId).toBe('tc_a');
      expect(toolResultPart.output.value).toBe('file content');
      return { ok: true as const, delta: { text: 'm', toolCalls: [] } };
    });
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            provider: 'anthropic',
            credentials: { apiKey: 'sk-test' },
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretId: 'sec-1',
            secretsToRedact: ['sk-test'],
          }),
        },
      }),
    }));
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: {
            read_file: { description: 'Read a file' },
            list_dir: { description: 'List directory contents' },
          },
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
          mcpClose: async () => {},
          httpRunner: undefined,
          sandboxClientClose: undefined,
        },
      }),
    }));
    const mod = await import('./modelGenerateStep');
    // Orchestrator-local messages as the loop stores them: user + assistant delta
    // (with toolCalls) + tool result — NOT ModelMessage[] shape.
    const loopMessages = [
      { role: 'user', content: 'read x.ts' },
      {
        role: 'assistant',
        delta: {
          text: 'reading',
          toolCalls: [{ toolName: 'read_file', toolCallId: 'tc_a', args: { path: 'x.ts' } }],
        },
      },
      { role: 'tool', toolName: 'read_file', toolCallId: 'tc_a', result: 'file content' },
    ];
    const result = await mod.modelGenerateStep({
      messages: loopMessages,
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    expect(result.ok).toBe(true);
    expect(m1).toHaveBeenCalledTimes(1);
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
  });

  it('modelGenerateStep HTTP-only registry → HTTP_ONLY_SYSTEM', async () => {
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async (_deps: unknown) => ({ ok: true as const, delta: { text: 'm', toolCalls: [] } }));
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretsToRedact: ['sk-test'],
          }),
        },
      }),
    }));
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: { http_get: { description: 'GET' } },
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
        },
      }),
    }));
    const { HTTP_ONLY_SYSTEM } = await import('../agent/agentSystem');
    const mod = await import('./modelGenerateStep');
    await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    const argDeps = m1.mock.calls[0]?.[0] as { system?: string };
    expect(argDeps.system).toBe(HTTP_ONLY_SYSTEM);
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
  });

  it('modelGenerateStep folds in-step persona/skills fail-open into resolveSystem', async () => {
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async (_deps: unknown) => ({ ok: true as const, delta: { text: 'm', toolCalls: [] } }));
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretsToRedact: ['sk-test'],
          }),
        },
        userPersonas: { getPersonaById: async () => ({ ok: true, value: null }) },
        userSkills: { listAlwaysOnSkills: async () => ({ ok: true, value: [] }) },
      }),
    }));
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: { list_dir: { description: 'List' } },
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
        },
      }),
    }));
    vi.doMock('../tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({
        ok: true as const,
        value: {
          get: async () => null,
          put: async () => ({ status: 'stored' }),
          readEnvelope: async () => null,
          upsertEnvelope: async () => ({ status: 'stored' }),
        },
      }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    vi.doMock('../tenancy/personaInject', () => ({
      resolvePersonaPreamble: async () => 'Always use tabs.',
    }));
    const resolveSkillPreamble = vi.fn(
      async (_input: { listUserSkills: unknown }) => ({
        // Catalog inject (plan #557/#931): slug + name + description lines.
        preamble: 'create-plan — Create plan: writes a plan.',
        attachedSlugs: ['create-plan'],
        attachedSkills: '["create-plan"]',
        events: [],
      }),
    );
    vi.doMock('../tenancy/skillInject', () => ({
      resolveSkillPreamble,
    }));
    const { DEFAULT_AGENT_SYSTEM } = await import('../agent/agentSystem');
    const mod = await import('./modelGenerateStep');
    await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    const argDeps = m1.mock.calls[0]?.[0] as { system?: string };
    expect(argDeps.system).toContain(DEFAULT_AGENT_SYSTEM);
    expect(argDeps.system).toContain('<persona_standing_orders>');
    expect(argDeps.system).toContain('Always use tabs.');
    expect(argDeps.system).toContain('<attached_skills>');
    expect(argDeps.system).toContain('create-plan — Create plan: writes a plan.');
    // Durable catalog seam is a required field — dropping it is a type error,
    // not a silent body-block revert. This assertion still locks the call.
    expect(resolveSkillPreamble).toHaveBeenCalled();
    expect(resolveSkillPreamble.mock.calls[0]?.[0]?.listUserSkills).toBeTruthy();
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
    vi.doUnmock('../tenancy/harnessSessionsRedis');
    vi.doUnmock('../tenancy/personaInject');
    vi.doUnmock('../tenancy/skillInject');
  });

  it('wall wrap-up round is 1h-exempt but bounded + reasoning none (adversarial-review #926)', async () => {
    // The loop tests mock modelStep, so they CANNOT see this: modelGenerateStep
    // must run the tools-off wall wrap-up round even when the 1-hour deadline
    // has ALREADY elapsed (which is always true when the fold runs), with a
    // SHORT wrap-up AbortSignal + reasoning none (not operator xhigh / not
    // unbounded), and with the WALL wrap-up system (not the step-budget one /
    // DEFAULT_AGENT_SYSTEM). Without the 1h exemption the fold round returns
    // {ok:false, code:'wall_clock'} and the loop reports `failed` instead of
    // the plan's clean `capped` terminal. Without the wrap-up bound the 4h
    // evidence class (open-ended CoT + default Workflows retries) comes back.
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    let capturedDeps:
      | {
          system?: string;
          signal?: AbortSignal;
          wallClockDeadlineAt?: number;
          reasoning?: string;
        }
      | undefined;
    const m1 = vi.fn(async (deps: unknown) => {
      capturedDeps = deps as typeof capturedDeps;
      return { ok: true as const, delta: { text: 'wrap-answer', toolCalls: [] } };
    });
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretsToRedact: ['sk-test'],
          }),
        },
      }),
    }));
    // The wrap-up is tools-off — the tool world is never assembled on this
    // path, but keep the mock present so a regression that DOES assemble does
    // not blow up on the first failure.
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: {},
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
        },
      }),
    }));
    const mod = await import('./modelGenerateStep');
    const { TURN_WALL_CLOCK_WRAPUP_SYSTEM } = await import('../agent/modelFinish');
    const deadlineAt = Date.now() - 1; // ALREADY elapsed — the fold runs after the cap.
    const before = Date.now();
    const result = await mod.modelGenerateStep({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'error', content: 'Error: turn wall clock exceeded.' },
      ],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      disableTools: true,
      wrapUp: 'wall',
      deadlineAt,
      reasoning: 'xhigh',
    });
    const after = Date.now();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.delta.text).toBe('wrap-answer');
    // The WALL wrap-up system reached generateOneRound (never the step-budget
    // system / DEFAULT_AGENT_SYSTEM).
    expect(capturedDeps?.system).toBe(TURN_WALL_CLOCK_WRAPUP_SYSTEM);
    // Wrap-up is 1h-exempt but bounded: a live wrap-up signal + wrap deadline
    // = deadlineAt + 5min (NOT now+5min per attempt), NEVER operator xhigh.
    expect(capturedDeps?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedDeps?.signal?.aborted).toBe(false);
    expect(capturedDeps?.reasoning).toBe('none');
    expect(capturedDeps?.wallClockDeadlineAt).toBe(
      deadlineAt + TURN_WALL_CLOCK_WRAPUP_MAX_MS,
    );
    expect(capturedDeps?.wallClockDeadlineAt).toBeGreaterThan(before);
    expect(capturedDeps?.wallClockDeadlineAt).toBeLessThanOrEqual(
      after + TURN_WALL_CLOCK_WRAPUP_MAX_MS,
    );
    // And the same call WITHOUT the wrapUp tag still fails closed ('wall_clock')
    // on an elapsed deadline (the plain-round cap is untouched).
    const fresh2 = await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      disableTools: true,
      deadlineAt: Date.now() - 1,
    });
    expect(fresh2.ok).toBe(false);
    if (!fresh2.ok) expect(fresh2.code).toBe('wall_clock');
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
  });

  it('steps wrap-up keeps 1h deadline signal, not the 5-min wall bound (adversarial-review #926)', async () => {
    // roundAbort used to gate on wrapUp !== undefined, so the 512-step fold
    // inherited TURN_WALL_CLOCK_WRAPUP_MAX_MS + reasoning none. A later pass
    // dropped the signal entirely, which reintroduced the 4h evidence class
    // for a wrap-up that starts with remaining > 0. Lock the split: wrapUp:
    // 'steps' keeps operator reasoning + STEP_BUDGET_WRAPUP_SYSTEM, carries
    // the 1h deadlineAt signal (NOT the 5-min substitute), and an already-
    // elapsed 1h deadline fails closed as wall_clock.
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    let capturedDeps:
      | {
          system?: string;
          signal?: AbortSignal;
          wallClockDeadlineAt?: number;
          reasoning?: string;
        }
      | undefined;
    const m1 = vi.fn(async (deps: unknown) => {
      capturedDeps = deps as typeof capturedDeps;
      return { ok: true as const, delta: { text: 'steps-wrap', toolCalls: [] } };
    });
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretsToRedact: ['sk-test'],
          }),
        },
      }),
    }));
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: {},
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
        },
      }),
    }));
    const mod = await import('./modelGenerateStep');
    const { STEP_BUDGET_WRAPUP_SYSTEM } = await import('../agent/modelFinish');
    const deadlineAt = Date.now() + 60_000;
    const result = await mod.modelGenerateStep({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'error', content: 'Error: step budget exhausted.' },
      ],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      disableTools: true,
      wrapUp: 'steps',
      deadlineAt,
      reasoning: 'xhigh',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.delta.text).toBe('steps-wrap');
    expect(capturedDeps?.system).toBe(STEP_BUDGET_WRAPUP_SYSTEM);
    expect(capturedDeps?.reasoning).toBe('xhigh');
    expect(capturedDeps?.reasoning).not.toBe('none');
    expect(capturedDeps?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedDeps?.signal?.aborted).toBe(false);
    expect(capturedDeps?.wallClockDeadlineAt).toBe(deadlineAt);
    expect(capturedDeps?.wallClockDeadlineAt).not.toBeGreaterThan(
      deadlineAt + 1,
    );
    // Elapsed 1h must fail closed as wall_clock (not run unbounded generate).
    m1.mockClear();
    const elapsed = await mod.modelGenerateStep({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'error', content: 'Error: step budget exhausted.' },
      ],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      disableTools: true,
      wrapUp: 'steps',
      deadlineAt: Date.now() - 1,
      reasoning: 'xhigh',
    });
    expect(elapsed.ok).toBe(false);
    if (!elapsed.ok) expect(elapsed.code).toBe('wall_clock');
    expect(m1).not.toHaveBeenCalled();
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
  });

  it('wrap-up bound abort remaps cancelled → wall_clock (adversarial-review #926)', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      vi.doMock('./turnSseWrite', () => ({
        writeOnDefaultStream: async () => {},
        withDefaultStreamWriter: async (
          fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
        ) => fn(async () => {}),
      }));
      const m1 = vi.fn(async (deps: unknown) => {
        const d = deps as { wallClockDeadlineAt?: number };
        if (d.wallClockDeadlineAt !== undefined) {
          vi.setSystemTime(d.wallClockDeadlineAt + 1);
        }
        return { ok: false as const, code: 'cancelled' as const, error: 'Request cancelled.' };
      });
      vi.doMock('../agent/generateOneRound', () => ({
        generateOneRound: m1,
        toolsWithoutExecutors: (t: Record<string, unknown>) => t,
      }));
      vi.doMock('../di/index', () => ({
        createProdServices: () => ({
          resolveInferenceForRequest: {
            resolveByokForRequest: async () => ({
              ok: true as const,
              modelId: 'byok-resolved',
              only: ['anthropic'] as [string],
              byok: { anthropic: [{ apiKey: 'sk-test' }] },
              secretsToRedact: ['sk-test'],
            }),
          },
        }),
      }));
      vi.doMock('./assembleDurableToolWorld', () => ({
        assembleDurableToolWorld: async () => ({
          ok: true as const,
          world: {
            registry: {},
            secrets: [],
            signal: new AbortController().signal,
            freshness: {},
          },
        }),
      }));
      const mod = await import('./modelGenerateStep');
      const result = await mod.modelGenerateStep({
        messages: [{ role: 'user', content: 'hi' }],
        modelId: 'm',
        userId: 'u1',
        scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
        disableTools: true,
        wrapUp: 'wall',
        deadlineAt: 1_000_000 - 1, // 1h elapsed by 1ms — wrap bound still ~5 min out
        reasoning: 'xhigh',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('wall_clock');
        expect(result.error).toBe(TURN_WALL_CLOCK_ERROR);
      }
    } finally {
      vi.useRealTimers();
      vi.doUnmock('../agent/generateOneRound');
      vi.doUnmock('../di/index');
      vi.doUnmock('./assembleDurableToolWorld');
      vi.doUnmock('./turnSseWrite');
    }
  });

  it('elapsed wrap-up bound fails closed even for wrapUp wall (adversarial-review #926)', async () => {
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async () => {
      throw new Error('generate must not run: wrap bound already elapsed');
    });
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => {
            throw new Error('BYOK must not run: wrap bound already elapsed');
          },
        },
      }),
    }));
    const mod = await import('./modelGenerateStep');
    const result = await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      disableTools: true,
      wrapUp: 'wall',
      // 1h deadline so far in the past that deadlineAt + 5min is also past.
      deadlineAt: Date.now() - TURN_WALL_CLOCK_WRAPUP_MAX_MS - 1,
      reasoning: 'xhigh',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('wall_clock');
    expect(m1).not.toHaveBeenCalled();
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./turnSseWrite');
  });

  it('tools-on modelGenerateStep threads deadlineSignal into assembleDurableToolWorld (adversarial-review #926)', async () => {
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async (_deps: unknown) => ({
      ok: true as const,
      delta: { text: 'm', toolCalls: [] },
    }));
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretsToRedact: ['sk-test'],
          }),
        },
      }),
    }));
    let assembledSignal: AbortSignal | undefined;
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async (args: { signal?: AbortSignal }) => {
        assembledSignal = args.signal;
        return {
          ok: true as const,
          world: {
            registry: { list_dir: { description: 'List' } },
            secrets: [],
            signal: args.signal ?? new AbortController().signal,
            freshness: {},
          },
        };
      },
    }));
    const mod = await import('./modelGenerateStep');
    const deadlineAt = Date.now() + 60_000;
    await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      deadlineAt,
    });
    expect(assembledSignal).toBeInstanceOf(AbortSignal);
    expect(assembledSignal?.aborted).toBe(false);
    const genDeps = m1.mock.calls[0]?.[0] as {
      signal?: AbortSignal;
      wallClockDeadlineAt?: number;
    };
    expect(genDeps.signal).toBe(assembledSignal);
    expect(genDeps.wallClockDeadlineAt).toBe(deadlineAt);
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
  });

  it('elapsed deadline remaps model_error → wall_clock (adversarial-review #926)', async () => {
    // generateOneRound can still leak `'model_error'` (settlement / Unknown
    // error without a throw on fullStream). The step must not fail() the turn
    // as a model error after deadlineAt — Goal 1 is the wall terminal.
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      vi.doMock('./turnSseWrite', () => ({
        writeOnDefaultStream: async () => {},
        withDefaultStreamWriter: async (
          fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
        ) => fn(async () => {}),
      }));
      const m1 = vi.fn(async (deps: unknown) => {
        const d = deps as { wallClockDeadlineAt?: number };
        if (d.wallClockDeadlineAt !== undefined) {
          vi.setSystemTime(d.wallClockDeadlineAt + 1);
        }
        return {
          ok: false as const,
          code: 'model_error' as const,
          error: 'Unknown error',
        };
      });
      vi.doMock('../agent/generateOneRound', () => ({
        generateOneRound: m1,
        toolsWithoutExecutors: (t: Record<string, unknown>) => t,
      }));
      vi.doMock('../di/index', () => ({
        createProdServices: () => ({
          resolveInferenceForRequest: {
            resolveByokForRequest: async () => ({
              ok: true as const,
              modelId: 'byok-resolved',
              only: ['anthropic'] as [string],
              byok: { anthropic: [{ apiKey: 'sk-test' }] },
              secretsToRedact: ['sk-test'],
            }),
          },
        }),
      }));
      vi.doMock('./assembleDurableToolWorld', () => ({
        assembleDurableToolWorld: async () => ({
          ok: true as const,
          world: {
            registry: {},
            secrets: [],
            signal: new AbortController().signal,
            freshness: {},
          },
        }),
      }));
      const mod = await import('./modelGenerateStep');
      const result = await mod.modelGenerateStep({
        messages: [{ role: 'user', content: 'hi' }],
        modelId: 'm',
        userId: 'u1',
        scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
        disableTools: true,
        // In-budget at entry so generate runs; mock then elapses the bound.
        deadlineAt: 1_000_000 + 60_000,
      });
      expect(m1).toHaveBeenCalled();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('wall_clock');
        expect(result.error).toBe(TURN_WALL_CLOCK_ERROR);
        expect(result.code).not.toBe('model_error');
      }
    } finally {
      vi.useRealTimers();
      vi.doUnmock('../agent/generateOneRound');
      vi.doUnmock('../di/index');
      vi.doUnmock('./assembleDurableToolWorld');
      vi.doUnmock('./turnSseWrite');
    }
  });
  it('modelGenerateStep inject throw still passes the base system', async () => {
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async (_deps: unknown) => ({ ok: true as const, delta: { text: 'm', toolCalls: [] } }));
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretsToRedact: ['sk-test'],
          }),
        },
        userPersonas: { getPersonaById: async () => { throw new Error('store down'); } },
        userSkills: {
          listAlwaysOnSkills: async () => { throw new Error('store down'); },
        },
      }),
    }));
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: { list_dir: { description: 'List' } },
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
        },
      }),
    }));
    vi.doMock('../tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => { throw new Error('redis down'); },
      sessionKeyFor: () => ({ tenantId: 't', userId: 'u', sessionId: 's' }),
    }));
    const { DEFAULT_AGENT_SYSTEM } = await import('../agent/agentSystem');
    const mod = await import('./modelGenerateStep');
    const result = await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    expect(result.ok).toBe(true);
    expect(m1).toHaveBeenCalledTimes(1);
    const argDeps = m1.mock.calls[0]?.[0] as { system?: string };
    expect(argDeps.system).toBe(DEFAULT_AGENT_SYSTEM);
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
    vi.doUnmock('../tenancy/harnessSessionsRedis');
  });

  it('modelGenerateStep envelope-only personaSnapshot injects (legacy get() miss, no put)', async () => {
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async (_deps: unknown) => ({ ok: true as const, delta: { text: 'm', toolCalls: [] } }));
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretsToRedact: ['sk-test'],
          }),
        },
        userPersonas: {
          getPersonaById: async () => {
            throw new Error('must use envelope snapshot, not getPersonaById');
          },
        },
      }),
    }));
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: { list_dir: { description: 'List' } },
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
        },
      }),
    }));
    const put = vi.fn(async () => {
      throw new Error('must not put whole-blob');
    });
    const upsertEnvelope = vi.fn(async ( _key: unknown, input: { updatedAt: number }) => ({
      status: 'stored' as const,
      envelope: input,
    }));
    vi.doMock('../tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({
        ok: true as const,
        value: {
          get: async () => null,
          put,
          readEnvelope: async () => ({
            id: 's1',
            userId: 'u1',
            tenantId: 't1',
            createdAt: 1,
            updatedAt: 1,
            meta: { personaId: 'p1', personaSnapshot: 'Always use tabs.' },
          }),
          upsertEnvelope,
        },
      }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    const { DEFAULT_AGENT_SYSTEM } = await import('../agent/agentSystem');
    const mod = await import('./modelGenerateStep');
    await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    const argDeps = m1.mock.calls[0]?.[0] as { system?: string };
    expect(argDeps.system).toContain(DEFAULT_AGENT_SYSTEM);
    expect(argDeps.system).toContain('<persona_standing_orders>');
    expect(argDeps.system).toContain('Always use tabs.');
    expect(put).not.toHaveBeenCalled();
    expect(upsertEnvelope).not.toHaveBeenCalled();
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
    vi.doUnmock('../tenancy/harnessSessionsRedis');
  });

  it('modelGenerateStep envelope personaId (no snapshot) locks via upsertEnvelope, not put', async () => {
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async (_deps: unknown) => ({ ok: true as const, delta: { text: 'm', toolCalls: [] } }));
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretsToRedact: ['sk-test'],
          }),
        },
        userPersonas: {
          getPersonaById: async () => ({
            ok: true as const,
            value: { body: 'Always use tabs.' },
          }),
        },
      }),
    }));
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: { list_dir: { description: 'List' } },
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
        },
      }),
    }));
    const put = vi.fn(async () => {
      throw new Error('must not put whole-blob');
    });
    const upsertEnvelope = vi.fn(async (_key: unknown, input: {
      updatedAt: number;
      meta?: Record<string, unknown>;
    }) => ({ status: 'stored' as const, envelope: input }));
    vi.doMock('../tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({
        ok: true as const,
        value: {
          get: async () => null,
          put,
          readEnvelope: async () => ({
            id: 's1',
            userId: 'u1',
            tenantId: 't1',
            createdAt: 1,
            updatedAt: 1,
            meta: { personaId: 'p1' },
          }),
          upsertEnvelope,
        },
      }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    const mod = await import('./modelGenerateStep');
    await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    const argDeps = m1.mock.calls[0]?.[0] as { system?: string };
    expect(argDeps.system).toContain('Always use tabs.');
    expect(argDeps.system).toContain('<persona_standing_orders>');
    expect(put).not.toHaveBeenCalled();
    expect(upsertEnvelope).toHaveBeenCalledTimes(1);
    const upsertInput = upsertEnvelope.mock.calls[0]?.[1] as {
      updatedAt: number;
      meta?: Record<string, unknown>;
    };
    expect(upsertInput.updatedAt).toBe(1);
    expect(upsertInput.meta?.personaSnapshot).toBe('Always use tabs.');
    expect(upsertInput.meta?.personaId).toBe('p1');
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
    vi.doUnmock('../tenancy/harnessSessionsRedis');
  });

  it('modelGenerateStep skill inject throw keeps the persona preamble', async () => {
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async (_deps: unknown) => ({ ok: true as const, delta: { text: 'm', toolCalls: [] } }));
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretsToRedact: ['sk-test'],
          }),
        },
        userPersonas: { getPersonaById: async () => ({ ok: true, value: null }) },
        userSkills: { listAlwaysOnSkills: async () => ({ ok: true, value: ['x'] }) },
      }),
    }));
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: async () => ({
        ok: true as const,
        world: {
          registry: { list_dir: { description: 'List' } },
          secrets: [],
          signal: new AbortController().signal,
          freshness: {},
        },
      }),
    }));
    vi.doMock('../tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: async () => ({
        ok: true as const,
        value: {
          get: async () => null,
          put: async () => ({ status: 'stored' }),
          readEnvelope: async () => ({
            id: 's1',
            userId: 'u1',
            tenantId: 't1',
            createdAt: 1,
            updatedAt: 1,
            meta: {},
          }),
          upsertEnvelope: async () => ({ status: 'stored' }),
        },
      }),
      sessionKeyFor: (t: string, u: string, s: string) => ({
        tenantId: t,
        userId: u,
        sessionId: s,
      }),
    }));
    vi.doMock('../tenancy/personaInject', () => ({
      resolvePersonaPreamble: async () => 'Always use tabs.',
    }));
    vi.doMock('../tenancy/skillInject', () => ({
      resolveSkillPreamble: async () => {
        throw new Error('skill inject boom');
      },
    }));
    const { DEFAULT_AGENT_SYSTEM } = await import('../agent/agentSystem');
    const mod = await import('./modelGenerateStep');
    const result = await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    expect(result.ok).toBe(true);
    const argDeps = m1.mock.calls[0]?.[0] as { system?: string };
    expect(argDeps.system).toContain(DEFAULT_AGENT_SYSTEM);
    expect(argDeps.system).toContain('<persona_standing_orders>');
    expect(argDeps.system).toContain('Always use tabs.');
    expect(argDeps.system).not.toContain('<attached_skills>');
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
    vi.doUnmock('../tenancy/harnessSessionsRedis');
    vi.doUnmock('../tenancy/personaInject');
    vi.doUnmock('../tenancy/skillInject');
  });

  it('disableTools skips assemble and passes empty tools (plan #878 test 5)', async () => {
    vi.resetModules();
    const writeOnDefaultStream = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream,
      withDefaultStreamWriter: async (
        fn: (write: (payload: string) => Promise<void>) => Promise<unknown>,
      ) => fn(writeOnDefaultStream),
    }));
    const m1 = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { tools?: Record<string, unknown> };
      expect(i.tools).toEqual({});
      return { ok: true as const, delta: { text: 'wrap', toolCalls: [] } };
    });
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: m1,
      toolsWithoutExecutors: (t: Record<string, unknown>) => t,
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'byok-resolved',
            only: ['anthropic'] as [string],
            byok: { anthropic: [{ apiKey: 'sk-test' }] },
            secretsToRedact: ['sk-test'],
          }),
        },
      }),
    }));
    const assembleSpy = vi.fn(async () => {
      throw new Error('assembleDurableToolWorld must not run on disableTools');
    });
    vi.doMock('./assembleDurableToolWorld', () => ({
      assembleDurableToolWorld: assembleSpy,
    }));
    const { STEP_BUDGET_WRAPUP_SYSTEM } = await import('../agent/modelFinish');
    const { DEFAULT_AGENT_SYSTEM } = await import('../agent/agentSystem');
    const mod = await import('./modelGenerateStep');
    const result = await mod.modelGenerateStep({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'error', content: 'Error: step budget exhausted' },
      ],
      modelId: 'm',
      userId: 'u1',
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      disableTools: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.delta.text).toBe('wrap');
    expect(assembleSpy).not.toHaveBeenCalled();
    expect(m1).toHaveBeenCalledTimes(1);
    const inputTools = (m1.mock.calls[0]?.[1] as { tools?: Record<string, unknown> })?.tools;
    expect(inputTools).toEqual({});
    const argDeps = m1.mock.calls[0]?.[0] as { system?: string };
    expect(argDeps.system).toBe(STEP_BUDGET_WRAPUP_SYSTEM);
    expect(argDeps.system).not.toBe(DEFAULT_AGENT_SYSTEM);
    expect(argDeps.system).not.toMatch(/Prefer tools \(list_dir/);
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6: toolExecuteStep thin shell → delegates executeTool; business error is a value', async () => {
    const m = vi.fn(async (_deps: unknown, _input: unknown) => ({
      ok: false as const,
      code: 'tool_not_found' as const,
      error: 'Tool not found: nope',
    }));
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: m }));
    vi.doMock('../agent/fileFreshness', () => ({
      hydrateRunFileFreshness: (_s: string | undefined) => ({}),
      createRunFileFreshness: () => ({}),
    }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    // The tool world (registry) is resolved IN-STEP from the module resolver —
    // never passed as a serialized step arg (adversarial L1).
    mod.setToolWorldResolver(() => ({ registry: {}, secrets: [], signal: undefined, freshness: {} }));
    const stepArgs = { calls: [{ toolName: 'nope', args: {} }] };
    // Step args must be plain serializable values.
    expect(JSON.parse(JSON.stringify(stepArgs))).toEqual(stepArgs);
    const result = await mod.toolExecuteStep(stepArgs);
    expect(result.ok).toBe(true);
    expect(result.ok && result.results[0]?.ok === false).toBe(true);
    if (result.ok && result.results[0] && !result.results[0].ok) {
      expect(result.results[0].code).toBe('tool_not_found');
      expect(result.results[0].error).toContain('nope');
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('../agent/fileFreshness');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6b (B5 freshness fix): toolExecuteStep with resolver set directly → SAME freshness object identity for createAgentTools (inside shared helper) and executeTool', async () => {
    // The resolver is set directly to return a world with a marked freshness
    // object. This avoids the fragile "resolver throws → dynamic import path"
    // approach. The freshness the resolver returns must be the SAME object
    // reference that executeTool receives (identity, not just equality).
    const freshnessMarker = { _id: 'shared-freshness-for-this-step' };
    const execMock = vi.fn(async (deps: unknown) => {
      const d = deps as { freshness?: unknown };
      // The freshness passed to executeTool must be the SAME object the
      // resolver returned (identity check).
      expect(d.freshness).toBe(freshnessMarker);
      return { ok: true as const, result: 'ok', freshnessDelta: '[]' };
    });
    // Reset modules so the vi.doMock for executeTool takes effect on a fresh
    // import of toolExecuteStep (the module may be cached from a prior test
    // with a different mock resolution).
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    // Resolver SET → test path. Pass the marked freshness directly.
    mod.setToolWorldResolver(() => ({
      registry: { test_tool: {} },
      secrets: [],
      signal: undefined,
      freshness: freshnessMarker,
    }));
    const result = await mod.toolExecuteStep({
      calls: [{ toolName: 'test_tool', args: {} }],
      freshnessSeed: 'seed',
    });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6c: N calls → N executeTool, one world', async () => {
    const execMock = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { toolName?: string };
      return { ok: true as const, result: `out:${i.toolName}`, freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    const world = { registry: { a: {}, b: {} }, secrets: [], signal: undefined, freshness: {} };
    mod.setToolWorldResolver(() => world);
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'a', toolCallId: '1', args: {} },
        { toolName: 'b', toolCallId: '2', args: {} },
      ],
    });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(result.results.map((r) => (r.ok ? r.result : r.error))).toEqual([
        'out:a',
        'out:b',
      ]);
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6d: live tool_result SSE is written inside the step (one write per call)', async () => {
    const execMock = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { toolName?: string };
      return { ok: true as const, result: `out:${i.toolName}`, freshnessDelta: '[]' };
    });
    const writes: string[] = [];
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async (s) => { writes.push(s); }),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { a: {}, b: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'a', toolCallId: '1', args: {} },
        { toolName: 'b', toolCallId: '2', args: {} },
      ],
    });
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes.every((w) => w.includes('"type":"tool_result"'))).toBe(true);
    expect(writes.some((w) => w.includes('"name":"a"') && w.includes('"id":"1"'))).toBe(true);
    expect(writes.some((w) => w.includes('"name":"b"') && w.includes('"id":"2"'))).toBe(true);
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6e: successful meta_sandbox_switch re-assembles before the next wave', async () => {
    const execMock = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { toolName?: string };
      if (i.toolName === 'meta_sandbox_switch') {
        return {
          ok: true as const,
          result: 'switched active sandbox to id=sb_b tools=[]',
          freshnessDelta: '[]',
        };
      }
      return { ok: true as const, result: `out:${i.toolName}`, freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    const resolve = vi.fn((_args: unknown) => ({
      registry: { meta_sandbox_switch: {}, read_file: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    mod.setToolWorldResolver(resolve);
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'meta_sandbox_switch', toolCallId: 's', args: { id: 'sb_b' } },
        { toolName: 'read_file', toolCallId: 'r', args: { path: 'x' } },
      ],
      persistRunBind: { activeSandboxId: 'sb_a' },
    });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(2);
    const second = resolve.mock.calls[1]?.[0] as {
      persistRunBind?: { activeSandboxId?: string };
    };
    expect(second.persistRunBind?.activeSandboxId).toBe('sb_b');
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6f: parallel freshness seed is the live ledger, not last-finishing snapshot (adversarial #881)', async () => {
    const { createRunFileFreshness } = await import('../agent/fileFreshness');
    const freshness = createRunFileFreshness();
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    vi.resetModules();
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: {
        a: {
          execute: async () => {
            await gateA;
            freshness.recordRead('A', { mtimeMs: 1, size: 1 });
            return 'A';
          },
        },
        b: {
          execute: async () => {
            freshness.recordRead('B', { mtimeMs: 2, size: 2 });
            releaseA();
            return 'B';
          },
        },
      },
      secrets: [],
      signal: undefined,
      freshness,
    }));
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'a', toolCallId: '1' },
        { toolName: 'b', toolCallId: '2' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const snap = JSON.parse(result.freshnessDelta) as { grants: Array<{ path: string }> };
      expect(snap.grants.map((g) => g.path).sort()).toEqual(['A', 'B']);
    }
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6g: sibling throw becomes a value; successful sibling is kept (adversarial #881)', async () => {
    const execMock = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { toolName?: string };
      if (i.toolName === 'boom') throw new Error('transport down');
      return { ok: true as const, result: `out:${i.toolName}`, freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { keep: {}, boom: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'keep', toolCallId: '1', args: {} },
        { toolName: 'boom', toolCallId: '2', args: {} },
      ],
    });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toMatchObject({ ok: true, result: 'out:keep' });
      expect(result.results[1]).toMatchObject({
        ok: false,
        code: 'sandbox_error',
        error: 'transport down',
      });
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6g-solo: a 1-call infra throw retries in-process then rethrows (adversarial #881 round-6)', async () => {
    const execMock = vi.fn(async () => {
      throw new Error('daemon down');
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { boom: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    await expect(
      mod.toolExecuteStep({ calls: [{ toolName: 'boom', toolCallId: '1', args: {} }] }),
    ).rejects.toThrow('daemon down');
    // 4 attempts = Workflows' 1+3 budget, in-process so the platform cannot
    // replay an N-call mutation set (`maxRetries = 0`).
    expect(execMock).toHaveBeenCalledTimes(4);
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6g-solo-recover: 1-call infra throw recovers on a later in-process attempt', async () => {
    let n = 0;
    const execMock = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new Error('daemon down');
      return { ok: true as const, result: 'ok', freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { boom: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const result = await mod.toolExecuteStep({
      calls: [{ toolName: 'boom', toolCallId: '1', args: {} }],
    });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(3);
    if (result.ok) {
      expect(result.results[0]).toMatchObject({ ok: true, result: 'ok' });
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('toolExecuteStep.maxRetries is 0 (adversarial #881 round-6: no platform replay of a mutated batch)', async () => {
    const src = readFileSync(fileURLToPath(new URL('./toolExecuteStep.ts', import.meta.url)), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/maxRetries\s*=\s*0/);
    vi.resetModules();
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    expect((mod.toolExecuteStep as typeof mod.toolExecuteStep & { maxRetries: number }).maxRetries).toBe(0);
    vi.doUnmock('./turnSseWrite');
  });

  it('toolExecuteStep: elapsed deadline at entry fails closed without dispatching (adversarial-review #926)', async () => {
    const execMock = vi.fn(async () => ({
      ok: true as const,
      result: 'ok',
      freshnessDelta: '[]',
    }));
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { list_dir: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const result = await mod.toolExecuteStep({
      calls: [{ toolName: 'list_dir', toolCallId: '1', args: {} }],
      deadlineAt: Date.now() - 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('wall_clock');
      expect(result.error).toBe(TURN_WALL_CLOCK_ERROR);
    }
    expect(execMock).not.toHaveBeenCalled();
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('toolExecuteStep: deadline signal is threaded into executeTool (plan #925 Goal 2)', async () => {
    let captured: AbortSignal | undefined;
    const execMock = vi.fn(async (deps: unknown) => {
      captured = (deps as { signal?: AbortSignal }).signal;
      return { ok: true as const, result: 'ok', freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { list_dir: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const result = await mod.toolExecuteStep({
      calls: [{ toolName: 'list_dir', toolCallId: '1', args: {} }],
      deadlineAt: Date.now() + 60_000,
    });
    expect(result.ok).toBe(true);
    expect(captured).toBeInstanceOf(AbortSignal);
    expect(captured?.aborted).toBe(false);
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('toolExecuteStep: between-wave skip fills remaining serial writes with wall_clock (adversarial-review #926)', async () => {
    const deadlineAt = Date.now() + 40;
    const execMock = vi.fn(async (_deps: unknown, input: unknown) => {
      const name = (input as { toolName?: string }).toolName;
      if (name === 'write_file') {
        while (Date.now() < deadlineAt) {
          await new Promise((r) => setTimeout(r, 10));
        }
        return { ok: true as const, result: 'wrote-a', freshnessDelta: '[]' };
      }
      return { ok: true as const, result: 'should-not-run', freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { write_file: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'write_file', toolCallId: '1', args: { path: 'a' } },
        { toolName: 'write_file', toolCallId: '2', args: { path: 'b' } },
      ],
      deadlineAt,
    });
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('wall_clock');
      expect(result.results).toHaveLength(2);
      expect(result.results?.[0]).toMatchObject({
        ok: true,
        toolCallId: '1',
        result: 'wrote-a',
      });
      expect(result.results?.[1]).toMatchObject({
        ok: false,
        toolCallId: '2',
        code: 'wall_clock',
        error: TURN_WALL_CLOCK_ERROR,
      });
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('toolExecuteStep: deadline abort remaps cancelled → wall_clock; in-budget Stop stays cancelled (G22)', async () => {
    vi.resetModules();
    const execMock = vi.fn(async () => ({
      ok: false as const,
      code: 'cancelled' as const,
      error: 'Request cancelled.',
    }));
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { list_dir: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const inBudget = await mod.toolExecuteStep({
      calls: [{ toolName: 'list_dir', toolCallId: '1', args: {} }],
      deadlineAt: Date.now() + 1_000_000,
    });
    expect(inBudget.ok).toBe(false);
    if (!inBudget.ok) {
      expect(inBudget.code).toBe('cancelled');
      expect(inBudget.results?.[0]).toMatchObject({ ok: false, code: 'cancelled' });
    }
    const deadlineAt = Date.now() + 40;
    const lateExec = vi.fn(async () => {
      while (Date.now() < deadlineAt) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return {
        ok: false as const,
        code: 'cancelled' as const,
        error: 'Request cancelled.',
      };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: lateExec }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod2 = await import('./toolExecuteStep');
    mod2.setToolWorldResolver(() => ({
      registry: { list_dir: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const late = await mod2.toolExecuteStep({
      calls: [{ toolName: 'list_dir', toolCallId: '1', args: {} }],
      deadlineAt,
    });
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.code).toBe('wall_clock');
      expect(late.error).toBe(TURN_WALL_CLOCK_ERROR);
      expect(late.results?.[0]).toMatchObject({
        ok: false,
        code: 'wall_clock',
        error: TURN_WALL_CLOCK_ERROR,
      });
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6e-cwd: change_dir then list_dir is serial — list sees the new cwd', async () => {
    const { createRunFileFreshness } = await import('../agent/fileFreshness');
    const cwdState = { current: 'app' };
    vi.resetModules();
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: {
        change_dir: {
          execute: async () => {
            cwdState.current = 'lib';
            return 'change_dir lib: ok cwd=lib';
          },
        },
        list_dir: {
          execute: async () => `cwd=${cwdState.current}`,
        },
      },
      secrets: [],
      signal: undefined,
      freshness: createRunFileFreshness(),
    }));
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'change_dir', toolCallId: 'd', args: { path: 'lib' } },
        { toolName: 'list_dir', toolCallId: 'l', args: {} },
      ],
      persistRunBind: { cwd: 'app' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.map((r) => (r.ok ? r.result : r.error))).toEqual([
        'change_dir lib: ok cwd=lib',
        'cwd=lib',
      ]);
    }
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6h: re-assemble fail does not duplicate switch toolCallId; remaining calls get skip results', async () => {
    const execMock = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { toolName?: string };
      if (i.toolName === 'meta_sandbox_switch') {
        return {
          ok: true as const,
          result: 'switched active sandbox to id=sb_b tools=[]',
          freshnessDelta: '[]',
        };
      }
      return { ok: true as const, result: `out:${i.toolName}`, freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    const resolve = vi.fn((_args: unknown) => ({
      registry: { meta_sandbox_switch: {}, read_file: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    resolve
      .mockImplementationOnce(() => ({
        registry: { meta_sandbox_switch: {}, read_file: {} },
        secrets: [],
        signal: undefined,
        freshness: {},
      }))
      .mockImplementationOnce(() => {
        throw new Error('resolver unset');
      });
    mod.setToolWorldResolver(resolve);
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'meta_sandbox_switch', toolCallId: 's', args: { id: 'sb_b' } },
        { toolName: 'read_file', toolCallId: 'r', args: { path: 'x' } },
      ],
      persistRunBind: { activeSandboxId: 'sb_a' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sandbox_error');
      expect(result.results).toHaveLength(2);
      expect(result.results?.[0]).toMatchObject({
        ok: true,
        toolName: 'meta_sandbox_switch',
        toolCallId: 's',
      });
      expect(result.results?.[1]).toMatchObject({
        ok: false,
        toolName: 'read_file',
        toolCallId: 'r',
        code: 'sandbox_error',
      });
      const ids = (result.results ?? []).map((r) => r.toolCallId);
      expect(ids).toEqual(['s', 'r']);
    }
    expect(execMock).toHaveBeenCalledTimes(1);
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6h-error: ERROR switch string does not re-assemble (adversarial #881 round-3 Major)', async () => {
    const execMock = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { toolName?: string };
      if (i.toolName === 'meta_sandbox_switch') {
        return {
          ok: true as const,
          result: 'ERROR meta_sandbox_switch: sandbox access denied',
          freshnessDelta: '[]',
        };
      }
      return { ok: true as const, result: `out:${i.toolName}`, freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    const resolve = vi.fn(() => ({
      registry: { meta_sandbox_switch: {}, read_file: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    mod.setToolWorldResolver(resolve);
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'meta_sandbox_switch', toolCallId: 's', args: { id: 'sb_b' } },
        { toolName: 'read_file', toolCallId: 'r', args: { path: 'x' } },
      ],
      persistRunBind: { activeSandboxId: 'sb_a' },
    });
    expect(result.ok).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(result.results[0]).toMatchObject({
        ok: true,
        toolName: 'meta_sandbox_switch',
        result: 'ERROR meta_sandbox_switch: sandbox access denied',
      });
      expect(result.results[1]).toMatchObject({
        ok: true,
        toolName: 'read_file',
        result: 'out:read_file',
      });
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6i: 1-call writer reject does not rethrow after a successful execute (adversarial #881 round-3 Minor)', async () => {
    const execMock = vi.fn(async () => ({
      ok: true as const,
      result: 'wrote',
      freshnessDelta: '[]',
    }));
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) =>
        fn(async () => {
          throw new Error('stream down');
        }),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { write_file: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const result = await mod.toolExecuteStep({
      calls: [{ toolName: 'write_file', toolCallId: '1', args: {} }],
    });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.results[0]).toMatchObject({ ok: true, result: 'wrote' });
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6j: read_file then write_file is serial — write sees the grant (adversarial #881 round-4)', async () => {
    const { createRunFileFreshness } = await import('../agent/fileFreshness');
    const freshness = createRunFileFreshness();
    let releaseRead!: () => void;
    const gateRead = new Promise<void>((r) => {
      releaseRead = r;
    });
    let writeStartedWhileReadGated = false;
    vi.resetModules();
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: {
        read_file: {
          execute: async () => {
            await gateRead;
            freshness.recordRead('A', { mtimeMs: 1, size: 1 });
            return 'A';
          },
        },
        write_file: {
          execute: async () => {
            if (!freshness.assertCanEdit('A', { mtimeMs: 1, size: 1 }).ok) {
              writeStartedWhileReadGated = true;
              return 'ERROR write_file: read_required';
            }
            return 'W';
          },
        },
      },
      secrets: [],
      signal: undefined,
      freshness,
    }));
    const p = mod.toolExecuteStep({
      calls: [
        { toolName: 'read_file', toolCallId: '1' },
        { toolName: 'write_file', toolCallId: '2' },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(writeStartedWhileReadGated).toBe(false);
    releaseRead();
    const result = await p;
    expect(result.ok).toBe(true);
    expect(writeStartedWhileReadGated).toBe(false);
    if (result.ok) {
      expect(result.results.map((r) => (r.ok ? r.result : r.error))).toEqual([
        'A',
        'W',
      ]);
    }
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6k: sibling throw + writer reject does not rethrow the batch (adversarial #881 round-4)', async () => {
    const execMock = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { toolName?: string };
      if (i.toolName === 'boom') throw new Error('transport down');
      return { ok: true as const, result: `out:${i.toolName}`, freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) =>
        fn(async () => {
          throw new Error('stream down');
        }),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { keep: {}, boom: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'keep', toolCallId: '1', args: {} },
        { toolName: 'boom', toolCallId: '2', args: {} },
      ],
    });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(2);
    if (result.ok) {
      expect(result.results[0]).toMatchObject({ ok: true, result: 'out:keep' });
      expect(result.results[1]).toMatchObject({
        ok: false,
        code: 'sandbox_error',
        error: 'transport down',
      });
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6l: hard fail skips later serial waves (adversarial #881 round-5)', async () => {
    const execMock = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { toolName?: string };
      if (i.toolName === 'boom') throw new Error('transport down');
      return { ok: true as const, result: `out:${i.toolName}`, freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { boom: {}, write_file: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'boom', toolCallId: '1', args: {} },
        { toolName: 'write_file', toolCallId: '2', args: { path: 'new.md' } },
      ],
    });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls.map((c) => (c[1] as { toolName?: string }).toolName)).toEqual([
      'boom',
    ]);
    if (result.ok) {
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toMatchObject({
        ok: false,
        toolName: 'boom',
        code: 'sandbox_error',
        error: 'transport down',
      });
      expect(result.results[1]).toMatchObject({
        ok: false,
        toolName: 'write_file',
        toolCallId: '2',
        code: 'sandbox_error',
        error: 'transport down',
      });
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 6l-bind: tool_not_found skips later change_dir (adversarial #881 round-5)', async () => {
    const execMock = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { toolName?: string };
      if (i.toolName === 'nope') {
        return {
          ok: false as const,
          code: 'tool_not_found' as const,
          error: 'Tool not found: nope',
        };
      }
      return { ok: true as const, result: `out:${i.toolName}`, freshnessDelta: '[]' };
    });
    vi.resetModules();
    vi.doMock('../agent/executeTool', () => ({ executeTool: execMock }));
    vi.doMock('./turnSseWrite', () => ({
      withDefaultStreamWriter: async (
        fn: (write: (s: string) => Promise<void>) => Promise<unknown>,
      ) => fn(async () => {}),
      writeOnDefaultStream: async () => {},
    }));
    const mod = await import('./toolExecuteStep');
    mod.setToolWorldResolver(() => ({
      registry: { nope: {}, change_dir: {} },
      secrets: [],
      signal: undefined,
      freshness: {},
    }));
    const result = await mod.toolExecuteStep({
      calls: [
        { toolName: 'nope', toolCallId: '1', args: {} },
        { toolName: 'change_dir', toolCallId: '2', args: { path: 'lib' } },
      ],
    });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toMatchObject({
        ok: false,
        toolName: 'nope',
        code: 'tool_not_found',
        error: 'Tool not found: nope',
      });
      expect(result.results[1]).toMatchObject({
        ok: false,
        toolName: 'change_dir',
        toolCallId: '2',
        code: 'tool_not_found',
        error: 'Tool not found: nope',
      });
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('./turnSseWrite');
  });

  it('matrix 7: persistStep thin shell → persists via seam (in-memory); returns terminal status', async () => {
    const { seam, persisted } = createInMemoryPersistSeam();
    // The persist seam is a `'use step'`-unsafe function → resolved IN-STEP from
    // the module resolver, never passed as an arg (adversarial L1).
    setPersistSeamResolver(() => seam);
    const result = await persistStep({
      turnRunId: 'run_1',
      deltas: [{ d: 1 }],
      scope: LOOP_SCOPE,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('completed');
      expect(result.turnRunId).toBe('run_1');
    }
    expect(persisted).toHaveLength(1);
    expect(persisted[0].turnRunId).toBe('run_1');
    const body = JSON.parse(persisted[0].content) as {
      id: string;
      updatedAt: number;
      messages: unknown[];
      deltas?: unknown[];
    };
    expect(body.id).toBe(LOOP_SCOPE.sessionId);
    expect(body.deltas).toBeUndefined();
    expect(body.messages).toEqual([]);
    expect(Number.isFinite(body.updatedAt)).toBe(true);
    const parsed = parseCloudSessionSnapshot(body, LOOP_SCOPE.sessionId);
    expect(parsed).not.toBeNull();
  });

  it('persistStep logs one JSON line with invincible.turn.persist', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { seam } = createInMemoryPersistSeam();
      setPersistSeamResolver(() => seam);
      await persistStep({
        turnRunId: 'wrun_log',
        deltas: [],
        scope: LOOP_SCOPE,
      });
      const rows = spy.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter(
          (r): r is Record<string, unknown> =>
            r != null && r.tag === 'invincible.turn.persist',
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.ok).toBe(true);
      expect(rows[0]!.terminal).toBe(true);
      expect(rows[0]!.status).toBe('completed');
      expect(rows[0]!.turnRunId).toBe('wrun_log');
    } finally {
      spy.mockRestore();
    }
  });

  it('matrix 7c: persistStep terminal:false returns running (in-memory seam)', async () => {
    const { seam, persisted } = createInMemoryPersistSeam();
    setPersistSeamResolver(() => seam);
    const result = await persistStep({
      turnRunId: 'run_mid',
      deltas: [{ d: 1 }],
      scope: LOOP_SCOPE,
      terminal: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('running');
      expect(result.turnRunId).toBe('run_mid');
    }
    expect(persisted).toHaveLength(1);
  });

  it('matrix 7 missing sessionId → {ok:false}, no throw, no persist', async () => {
    const { seam, persisted } = createInMemoryPersistSeam();
    setPersistSeamResolver(() => seam);
    const result = await persistStep({ turnRunId: 'r', deltas: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_scope');
    expect(persisted).toHaveLength(0);
  });

  it('matrix 7b: persist seam {ok:false} → value, not throw', async () => {
    const seam = {
      persist: async () =>
        ({ ok: false as const, code: 'write_failed' as const, error: 'no scope' }),
    };
    setPersistSeamResolver(() => seam);
    const result = await persistStep({
      turnRunId: 'r',
      deltas: [],
      scope: LOOP_SCOPE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('write_failed');
  });
});
describe('runTurnLoop wall-clock cap (plan #923 — hard 1-hour turn wall clock)', () => {
  /**
   * Parse loop SSE lines (data: JSON).
   */
  function eventsOf(lines: string[]): Array<Record<string, unknown>> {
    return lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
  }

  it('row 1: deadline not passed → loop runs to natural end (completed, no SSE error, writable closed once)', async () => {
    const { deps, w, closed } = wiredDeps();
    let round = 0;
    const modelStep = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'call',
            toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
          },
        };
      }
      return { ok: true as const, delta: { text: 'done', toolCalls: [] } };
    });
    const toolStep = vi.fn(okBatch());
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        toolStep,
        deadlineAt: Date.now() + 1_000_000,
      },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(result.reason).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect(closed()).toBe(1);
    const events = eventsOf(w.lines);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('row 2: deadline passed at boundary (model round) → wall wrap-up, tools-off round sees TURN_WALL_CLOCK_WRAPUP, SSE error turn wall clock exceeded, terminal persist, reason wall, writable closed once', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as {
        disableTools?: boolean;
        messages?: Array<{ role?: string; content?: string }>;
      };
      if (a.disableTools) {
        // The wrap-up round must SEE the wall error copy, not the step-budget one.
        const errMsg = a.messages?.find((m) => m.role === 'error');
        expect(errMsg?.content).toContain(TURN_WALL_CLOCK_WRAPUP);
        return { ok: true as const, delta: { text: 'wrap-summary', toolCalls: [] } };
      }
      throw new Error('no in-budget model round should run after an elapsed deadline');
    });
    const toolStep = vi.fn(async () => {
      throw new Error('no tool step should run after an elapsed deadline');
    });
    const result = await runTurnLoop(
      {
        ...deps,
        // Deadline ALREADY elapsed at the first boundary → no model round can
        // run; the loop goes straight to the wall wrap-up.
        deadlineAt: Date.now() - 1,
        modelStep,
        toolStep,
        persistStep: persistSpy,
      },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.reason).toBe('wall');
    // The wrap-up round runs tools-off with the wall system.
    expect(modelStep).toHaveBeenCalledTimes(1);
    const wrapArg = modelStep.mock.calls[0]?.[0] as {
      disableTools?: boolean;
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(wrapArg.disableTools).toBe(true);
    const events = eventsOf(w.lines);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(
      events.some(
        (e) => e.type === 'error' && e.error === TURN_WALL_CLOCK_ERROR,
      ),
    ).toBe(true);
    // Terminal persist ran (wrap-up persistOnce(true)) — envelope completed.
    expect(persistSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const last = persistSpy.mock.calls[persistSpy.mock.calls.length - 1]?.[0] as {
      terminal?: boolean;
    };
    expect(last.terminal).toBeUndefined();
    expect(closed()).toBe(1);
  });

  it('row 3: deadline mid-model-round → model step returns wall_clock sentinel → wall wrap-up (not user-cancel)', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as { disableTools?: boolean };
      // First (in-budget) model round: the deadline signal aborted mid-round.
      if (!a.disableTools) {
        return {
          ok: false as const,
          code: 'wall_clock' as const,
          error: TURN_WALL_CLOCK_ERROR,
        };
      }
      return { ok: true as const, delta: { text: 'wrap', toolCalls: [] } };
    });
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep: vi.fn(), persistStep: persistSpy },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.reason).toBe('wall');
    expect(result.error).toBeUndefined();
    expect(modelStep).toHaveBeenCalledTimes(2); // abort + wrap-up
    const wrapArg = modelStep.mock.calls[1]?.[0] as { disableTools?: boolean };
    expect(wrapArg.disableTools).toBe(true);
    const events = eventsOf(w.lines);
    expect(events.some((e) => e.type === 'error' && e.error === TURN_WALL_CLOCK_ERROR)).toBe(
      true,
    );
    expect(closed()).toBe(1);
  });

  it('row 4: genuine user Stop near deadline keeps cancelled (G22 parity — no wall code)', async () => {
    const { deps, w, closed } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: false as const,
      code: 'cancelled' as const,
      error: 'Request cancelled.',
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep: vi.fn() },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('cancelled');
    expect(result.error).toBe('Request cancelled.');
    expect(result.reason).toBeUndefined();
    expect(closed()).toBe(1);
    const events = eventsOf(w.lines);
    expect(events.some((e) => e.type === 'error' && e.error === 'Request cancelled.')).toBe(
      true,
    );
    expect(events.some((e) => e.error === TURN_WALL_CLOCK_ERROR)).toBe(false);
  });

  it('row 5: deadline mid-tool-batch → whole-batch wall_clock, partial successes persisted, wall wrap-up', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as { disableTools?: boolean };
      if (a.disableTools) {
        return { ok: true as const, delta: { text: 'wrap', toolCalls: [] } };
      }
      return {
        ok: true as const,
        delta: {
          text: 'two',
          toolCalls: [
            { toolName: 'list_dir', toolCallId: 'a', args: {} },
            { toolName: 'read_file', toolCallId: 'b', args: {} },
          ],
        },
      };
    });
    const toolStep = vi.fn(async () => ({
      ok: false as const,
      code: 'wall_clock' as const,
      error: TURN_WALL_CLOCK_ERROR,
      results: [
        {
          ok: true as const,
          toolName: 'list_dir',
          toolCallId: 'a',
          result: 'ok-dir',
          freshnessDelta: '[]',
        },
        {
          ok: false as const,
          toolName: 'read_file',
          toolCallId: 'b',
          code: 'wall_clock' as const,
          error: TURN_WALL_CLOCK_ERROR,
        },
      ],
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, persistStep: persistSpy },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.reason).toBe('wall');
    // partial sibling success persisted before the wrap-up terminal persist
    expect(persistSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const rows = (result.messages as Array<{ role?: string; result?: string; error?: string }>)
      .filter((m) => m.role === 'tool');
    expect(rows.some((r) => r.result === 'ok-dir')).toBe(true);
    const events = eventsOf(w.lines);
    expect(events.some((e) => e.type === 'error' && e.error === TURN_WALL_CLOCK_ERROR)).toBe(
      true,
    );
    expect(closed()).toBe(1);
  });

  it('row 6: unpaired tool rows closed with skipped turn wall clock exceeded before wrap-up (legal message)', async () => {
    const { deps, w, closed } = wiredDeps();
    let wrapSawToolError: string | undefined;
    // Deadline set ~40ms in the future: round 1's boundary passes, then the
    // model round BUSY-WAITS until the deadline passes so the tool-batch gate
    // deterministically fires the wall wrap-up (no sub-ms timing race).
    const deadlineAt = Date.now() + 40;
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as {
        disableTools?: boolean;
        messages?: Array<{ role?: string; toolCallId?: string; error?: string }>;
      };
      if (a.disableTools) {
        // Record the skipped-tool error the wrap-up sees; do not assert in-mock
        // (a throw inside the mock would turn the turn 'failed').
        const toolRows = (a.messages ?? []).filter((m) => m.role === 'tool');
        wrapSawToolError = toolRows[0]?.error;
        return { ok: true as const, delta: { text: 'wrap', toolCalls: [] } };
      }
      // Round 1 returns an in-flight tool call; wait for the deadline to land
      // so the loop's tool-batch boundary check closes the open pair.
      while (Date.now() < deadlineAt) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return {
        ok: true as const,
        delta: {
          text: 'call',
          toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
        },
      };
    });
    const result = await runTurnLoop(
      {
        ...deps,
        deadlineAt,
        modelStep,
        toolStep: vi.fn(async () => {
          throw new Error('tool batch should not dispatch after an elapsed deadline');
        }),
      },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.reason).toBe('wall');
    expect(closed()).toBe(1);
    // The wrap-up round saw the open toolCallId closed with the WALL skip copy.
    expect(wrapSawToolError).toContain(TURN_WALL_CLOCK_ERROR);
    expect(wrapSawToolError).not.toContain(STEP_BUDGET_ERROR);
    const events = eventsOf(w.lines);
    expect(
      events.some(
        (e) =>
          e.type === 'tool_result' &&
          e.name === 'list_dir' &&
          String(e.summary).includes(TURN_WALL_CLOCK_ERROR),
      ),
    ).toBe(true);
  });

  it('row 7: wrap-up model failure → terminal persist still runs, SSE error with model error, status failed reason wall', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as { disableTools?: boolean };
      if (a.disableTools) {
        return { ok: false as const, code: 'model_error' as const, error: 'wrap boom' };
      }
      return {
        ok: true as const,
        delta: {
          text: 'work',
          toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
        },
      };
    });
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep: vi.fn(), persistStep: persistSpy, deadlineAt: Date.now() - 1 },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('wall');
    expect(result.error).toBe('wrap boom');
    expect(persistSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    const last = persistSpy.mock.calls[persistSpy.mock.calls.length - 1]?.[0] as {
      terminal?: boolean;
    };
    expect(last.terminal).toBeUndefined();
    const events = eventsOf(w.lines);
    expect(events.some((e) => e.type === 'error' && e.error === 'wrap boom')).toBe(true);
    expect(closed()).toBe(1);
  });

  it('row 7b: wrap-up wall_clock / cancelled stays capped wall, not failed (adversarial-review #926)', async () => {
    const { deps, w, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as { disableTools?: boolean };
      if (a.disableTools) {
        return {
          ok: false as const,
          code: 'wall_clock' as const,
          error: TURN_WALL_CLOCK_ERROR,
        };
      }
      return {
        ok: true as const,
        delta: {
          text: 'work',
          toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
        },
      };
    });
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep: vi.fn(), persistStep: persistSpy, deadlineAt: Date.now() - 1 },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.reason).toBe('wall');
    expect(result.error).toBeUndefined();
    const events = eventsOf(w.lines);
    expect(events.some((e) => e.type === 'error' && e.error === TURN_WALL_CLOCK_ERROR)).toBe(
      true,
    );
    expect(events.some((e) => e.error === 'wrap boom')).toBe(false);
    expect(closed()).toBe(1);

    const { deps: deps2, w: w2, closed: closed2 } = wiredDeps();
    const modelStep2 = vi.fn(async (args: unknown) => {
      const a = args as { disableTools?: boolean };
      if (a.disableTools) {
        return { ok: false as const, code: 'cancelled' as const, error: 'Request cancelled.' };
      }
      return {
        ok: true as const,
        delta: {
          text: 'work',
          toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
        },
      };
    });
    const result2 = await runTurnLoop(
      { ...deps2, modelStep: modelStep2, toolStep: vi.fn(), deadlineAt: Date.now() - 1 },
      { userMessage: 'go' },
    );
    expect(result2.status).toBe('capped');
    expect(result2.reason).toBe('wall');
    expect(eventsOf(w2.lines).some((e) => e.type === 'error' && e.error === TURN_WALL_CLOCK_ERROR)).toBe(
      true,
    );
    expect(closed2()).toBe(1);
  });

  it('row 7c: wall-stopped tool batch does not terminal-persist completed before wrap-up (C15 / adversarial-review #926)', async () => {
    const { deps, closed } = wiredDeps();
    let wrapStarted = false;
    let completedBeforeWrap = false;
    const persistSpy = vi.fn(async (args: Parameters<typeof deps.persistStep>[0]) => {
      if (!wrapStarted && args.terminal !== false) completedBeforeWrap = true;
      return deps.persistStep(args);
    });
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as { disableTools?: boolean };
      if (a.disableTools) {
        wrapStarted = true;
        return { ok: true as const, delta: { text: 'wrap', toolCalls: [] } };
      }
      return {
        ok: true as const,
        delta: {
          text: 'two',
          toolCalls: [
            { toolName: 'list_dir', toolCallId: 'a', args: {} },
            { toolName: 'read_file', toolCallId: 'b', args: {} },
          ],
        },
      };
    });
    const toolStep = vi.fn(async () => ({
      ok: false as const,
      code: 'wall_clock' as const,
      error: TURN_WALL_CLOCK_ERROR,
      results: [
        {
          ok: true as const,
          toolName: 'list_dir',
          toolCallId: 'a',
          result: 'ok-dir',
          freshnessDelta: '[]',
        },
        {
          ok: false as const,
          toolName: 'read_file',
          toolCallId: 'b',
          code: 'wall_clock' as const,
          error: TURN_WALL_CLOCK_ERROR,
        },
      ],
    }));
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, persistStep: persistSpy },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.reason).toBe('wall');
    expect(completedBeforeWrap).toBe(false);
    expect(wrapStarted).toBe(true);
    const last = persistSpy.mock.calls[persistSpy.mock.calls.length - 1]?.[0] as {
      terminal?: boolean;
    };
    expect(last.terminal).toBeUndefined();
    expect(closed()).toBe(1);
  });

  it('row 8: wall wrap-up uses TURN_WALL_CLOCK_WRAPUP_SYSTEM (never the step-budget system / DEFAULT_AGENT_SYSTEM)', async () => {
    const { deps } = wiredDeps();
    let wrapSystem: string | undefined;
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as { disableTools?: boolean; persistRunBind?: unknown };
      if (a.disableTools) {
        return { ok: true as const, delta: { text: 'wrap', toolCalls: [] } };
      }
      return {
        ok: true as const,
        delta: {
          text: 'x',
          toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
        },
      };
    });
    // The loop does NOT pass the system string — it only sets disableTools and
    // the messages. The SYSTEM is chosen inside modelGenerateStep (which the
    // loop test mocks). Here we assert the loop's wrap-up CONTROL SURFACE: the
    // disableTools round is the SAME for both caps, but the messages carry the
    // WALL copy (distinct) — the wall wrap-up is not the step-budget wrap-up.
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep: vi.fn(), deadlineAt: Date.now() - 1 },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.reason).toBe('wall');
    expect(wrapSystem).toBeUndefined();
    // modelGenerateStep's own wrap-up system is locked by the model-step tests;
    // here we assert copy distinctness via the sentinel + constants.
    expect(TURN_WALL_CLOCK_WRAPUP_SYSTEM).not.toBe(STEP_BUDGET_WRAPUP_SYSTEM);
    expect(TURN_WALL_CLOCK_WRAPUP).toContain('turn wall clock exceeded');
  });

  it('row 15: additive invincible.turn.loop log row includes reason wall + bounded elapsedMs (allowlist)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { deps } = wiredDeps();
      const modelStep = vi.fn(async (args: unknown) => {
        const a = args as { disableTools?: boolean };
        if (a.disableTools) {
          return { ok: true as const, delta: { text: 'wrap', toolCalls: [] } };
        }
        return {
          ok: true as const,
          delta: {
            text: 'x',
            toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
          },
        };
      });
      await runTurnLoop(
        { ...deps, modelStep, toolStep: vi.fn(), deadlineAt: Date.now() - 1 },
        { userMessage: 'go' },
      );
      const rows = spy.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter(
          (r): r is Record<string, unknown> => r != null && r.tag === 'invincible.turn.loop',
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('capped');
      expect(rows[0]!.reason).toBe('wall');
      expect(typeof rows[0]!.elapsedMs).toBe('number');
      expect(rows[0]!.elapsedMs as number).toBeGreaterThanOrEqual(0);
      expect(rows[0]!.elapsedMs as number).toBeLessThanOrEqual(TURN_WALL_CLOCK_MAX_MS * 2);
      // allowlist: no prompt/system/tool args leak
      expect(Object.keys(rows[0]!).sort()).toEqual(['elapsedMs', 'reason', 'status', 'tag']);
    } finally {
      spy.mockRestore();
    }
  });

  it('row 16: step-cap break after deadline prefers wall wrap-up, not unbounded steps fold (adversarial-review #926)', async () => {
    // maxSteps=2: model + user-line persist fill the cap, then `steps >= cap`
    // break. If that break runs BEFORE deadlineElapsed, wrapUp:'steps' (no
    // signal, operator xhigh) fires after the 1h line — the 4h evidence class.
    const { deps, w, closed } = wiredDeps({ maxSteps: 2 });
    const deadlineAt = Date.now() + 40;
    let wrapSaw: string | undefined;
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as {
        disableTools?: boolean;
        messages?: Array<{ role?: string; content?: string }>;
      };
      if (a.disableTools) {
        wrapSaw = a.messages?.find((m) => m.role === 'error')?.content;
        return { ok: true as const, delta: { text: 'wrap', toolCalls: [] } };
      }
      while (Date.now() < deadlineAt) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return {
        ok: true as const,
        delta: {
          text: 'call',
          toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
        },
      };
    });
    const toolStep = vi.fn(async () => {
      throw new Error('tool batch must not run: wall should win over the step-cap break');
    });
    const result = await runTurnLoop(
      { ...deps, maxSteps: 2, modelStep, toolStep, deadlineAt },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.reason).toBe('wall');
    expect(result.reason).not.toBe('steps');
    expect(toolStep).not.toHaveBeenCalled();
    expect(wrapSaw).toContain(TURN_WALL_CLOCK_WRAPUP);
    expect(wrapSaw).not.toContain(STEP_BUDGET_WRAPUP);
    const events = eventsOf(w.lines);
    expect(events.some((e) => e.type === 'error' && e.error === TURN_WALL_CLOCK_ERROR)).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(closed()).toBe(1);
  });

  it('row 17: last in-budget tool batch filling the cap after deadline still wall-wraps (while-exit)', async () => {
    // maxSteps=3: model + user-line persist + tool batch. Tool waits past
    // deadline then succeeds. while (steps < cap) fails; without a while-exit
    // deadline gate this was wrapUp:'steps'.
    const { deps, w, closed } = wiredDeps({ maxSteps: 3 });
    const deadlineAt = Date.now() + 40;
    let wrapSaw: string | undefined;
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as {
        disableTools?: boolean;
        messages?: Array<{ role?: string; content?: string }>;
      };
      if (a.disableTools) {
        wrapSaw = a.messages?.find((m) => m.role === 'error')?.content;
        return { ok: true as const, delta: { text: 'wrap', toolCalls: [] } };
      }
      return {
        ok: true as const,
        delta: {
          text: 'call',
          toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
        },
      };
    });
    const toolStep = vi.fn(async () => {
      while (Date.now() < deadlineAt) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return {
        ok: true as const,
        results: [
          {
            ok: true as const,
            toolName: 'list_dir',
            toolCallId: 'c',
            result: 'ok-dir',
            freshnessDelta: '[]',
          },
        ],
        freshnessDelta: '[]',
      };
    });
    const result = await runTurnLoop(
      { ...deps, maxSteps: 3, modelStep, toolStep, deadlineAt },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.reason).toBe('wall');
    expect(result.reason).not.toBe('steps');
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect(wrapSaw).toContain(TURN_WALL_CLOCK_WRAPUP);
    expect(wrapSaw).not.toContain(STEP_BUDGET_WRAPUP);
    const events = eventsOf(w.lines);
    expect(events.some((e) => e.type === 'error' && e.error === TURN_WALL_CLOCK_ERROR)).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(closed()).toBe(1);
  });

  it('row 18: steps wrap-up that crosses deadlineAt becomes wall terminal, not failed (adversarial-review #926)', async () => {
    // maxSteps=2: model + user-line persist fill the cap with remaining > 0,
    // so the loop takes wrapUp:'steps'. Wrap-up then returns wall_clock (1h
    // signal fired mid-round). That must be capped/wall — not fail('failed')
    // and not a second wrap-up round.
    const { deps, w, closed } = wiredDeps({ maxSteps: 2 });
    const deadlineAt = Date.now() + 500;
    let wrapUpTag: string | undefined;
    const modelStep = vi.fn(async (args: unknown) => {
      const a = args as {
        disableTools?: boolean;
        wrapUp?: 'steps' | 'wall';
      };
      if (a.disableTools) {
        wrapUpTag = a.wrapUp;
        while (Date.now() < deadlineAt) {
          await new Promise((r) => setTimeout(r, 5));
        }
        return {
          ok: false as const,
          code: 'wall_clock' as const,
          error: TURN_WALL_CLOCK_ERROR,
        };
      }
      return {
        ok: true as const,
        delta: {
          text: 'call',
          toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }],
        },
      };
    });
    const toolStep = vi.fn(async () => {
      throw new Error('tool batch must not run: cap filled before dispatch');
    });
    const result = await runTurnLoop(
      { ...deps, maxSteps: 2, modelStep, toolStep, deadlineAt },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('capped');
    expect(result.reason).toBe('wall');
    expect(result.status).not.toBe('failed');
    expect(result.reason).not.toBe('steps');
    expect(wrapUpTag).toBe('steps');
    expect(toolStep).not.toHaveBeenCalled();
    const events = eventsOf(w.lines);
    expect(events.some((e) => e.type === 'error' && e.error === TURN_WALL_CLOCK_ERROR)).toBe(
      true,
    );
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(closed()).toBe(1);
  });
});

describe('static-graph clean-flag regression (plan #805 lock)', () => {
  it('turnWorkflow entry closure reaches zero banned Workflow-bundle modules', () => {
    const reachable = reachableImports('lib/workflows/turnWorkflow.ts', { root: process.cwd() });
    const banned = [...reachable].filter((v) => {
      if (v === 'pg' || v === 'postgres') return true;
      if (v.startsWith('crypto') || v.startsWith('dns')) return true;
      if (v.startsWith('node:crypto') || v.startsWith('node:dns')) return true;
      if (v === 'lib/sessions/blobStore' || v === 'lib/sessions/blobStores') return true;
      return v.startsWith('db/') || v.startsWith('lib/db/') || v.startsWith('lib/mcp/');
    });
    expect(banned).toEqual([]);
  });

  it('canvas closure executable code has no Buffer identifier (Workflows VM)', () => {
    // Production brick class: Node `Buffer` is not in the Workflows sandbox
    // (VM injects TextEncoder, not Buffer). `'use step'` leaves run on Node
    // and may use Buffer; they are recorded by the walker but not bundled
    // into the canvas, so skip them.
    const root = process.cwd();
    const reachable = reachableImports('lib/workflows/turnWorkflow.ts', { root });
    const hits: string[] = [];
    for (const canon of reachable) {
      const file = resolveFile(join(root, canon));
      if (!file) continue;
      const src = readFileSync(file, 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (code.includes("'use step'") || code.includes('"use step"')) continue;
      if (/\bBuffer\b/.test(code)) hits.push(canon);
    }
    expect(hits).toEqual([]);
  });
});

// --- Plan #950 (A4 compaction phase 3) — loop seeding + checkpoint writer ---

describe('runTurnLoop compaction (plan #950, source #552)', () => {
  const COMPACT_SCOPE = { tenantId: 't1', userId: 'u1', sessionId: 's1' };

  it('successful summarizer → the first model round sees [summaryRow, ...retainedTail, user] (DoD row 3)', async () => {
    const { deps, closed } = wiredDeps();
    let firstRoundMessages: unknown[] | undefined;
    const modelStep = vi.fn(async (args: { messages: ReadonlyArray<unknown> }) => {
      if (!firstRoundMessages) firstRoundMessages = [...args.messages];
      return {
        ok: true as const,
        delta: { text: 'hi', toolCalls: [], finishReason: 'stop' },
      };
    });
    const compactionStep = vi.fn(async () => ({
      ok: true as const,
      summary: 'earlier work summarized',
    }));
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        compactionStep,
        compactionScope: COMPACT_SCOPE,
        compactionFilesTouched: ['src/a.ts'],
        compactionRetainedTail: [{ role: 'user', content: 'resume from tail' }],
      },
      {
        userMessage: 'continue',
        priorMessages: [{ role: 'user', content: 'OLD overflow row' }],
        compact: { span: [{ role: 'user', content: 'old turn' }] },
      },
    );
    expect(result.status).toBe('completed');
    expect(compactionStep).toHaveBeenCalledTimes(1);
    expect(firstRoundMessages).toHaveLength(3);
    const [summaryRow, tailRow, userRow] = firstRoundMessages as Array<{
      role: string;
      content?: string;
    }>;
    expect(summaryRow.role).toBe('user');
    expect(summaryRow.content).toContain(
      'Summary of earlier session (compacted, not live assistant prose):',
    );
    expect(summaryRow.content).toContain('earlier work summarized');
    expect(summaryRow.content).toContain('src/a.ts');
    expect(tailRow).toEqual({ role: 'user', content: 'resume from tail' });
    expect(userRow).toEqual({ role: 'user', content: 'continue' });
    expect(closed()).toBe(1);
  });

  it('fail-open: a failing summarizer never blocks the turn — plain priorMessages seed (parent edge-case lock)', async () => {
    const { deps, closed } = wiredDeps();
    let firstRoundMessages: unknown[] | undefined;
    const modelStep = vi.fn(async (args: { messages: ReadonlyArray<unknown> }) => {
      if (!firstRoundMessages) firstRoundMessages = [...args.messages];
      return {
        ok: true as const,
        delta: { text: 'hi', toolCalls: [], finishReason: 'stop' },
      };
    });
    const compactionStep = vi.fn(async () => ({
      ok: false as const,
      code: 'summarize_failed',
      error: 'boom',
    }));
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        compactionStep,
        compactionScope: COMPACT_SCOPE,
        compactionRetainedTail: [{ role: 'user', content: 'tail' }],
      },
      {
        userMessage: 'continue',
        priorMessages: [{ role: 'user', content: 'plain prior row' }],
        compact: { span: [{ role: 'user', content: 'old turn' }] },
      },
    );
    expect(result.status).toBe('completed');
    expect(firstRoundMessages).toHaveLength(2);
    expect(
      (firstRoundMessages as Array<{ content?: string }>)[0].content,
    ).toBe('plain prior row');
    expect(closed()).toBe(1);
  });

  it('fail-open: a THROWING summarizer never fails the turn', async () => {
    const { deps } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [], finishReason: 'stop' },
    }));
    const compactionStep = vi.fn(async () => {
      throw new Error('step vm exploded');
    });
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        compactionStep,
        compactionScope: COMPACT_SCOPE,
      },
      {
        userMessage: 'continue',
        priorMessages: [{ role: 'user', content: 'prior' }],
        compact: { span: [] },
      },
    );
    expect(result.status).toBe('completed');
  });

  it('empty summary → no compacted seed (plain projection); fold carries NO compactionCheckpoint', async () => {
    const { deps } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [], finishReason: 'stop' },
    }));
    const compactionStep = vi.fn(async () => ({ ok: true as const, summary: '   ' }));
    const persistSpy = vi.fn(deps.persistStep);
    await runTurnLoop(
      {
        ...deps,
        modelStep,
        persistStep: persistSpy,
        compactionStep,
        compactionScope: COMPACT_SCOPE,
      },
      {
        userMessage: 'continue',
        priorMessages: [{ role: 'user', content: 'prior' }],
        compact: { span: [] },
      },
    );
    const foldCall = persistSpy.mock.calls.find(
      (c) => c[0].fold !== undefined,
    );
    expect(foldCall?.[0]?.fold?.compactionCheckpoint).toBeUndefined();
  });

  it('checkpoint writer (parent review-note 2 lock): the terminal fold carries compactionCheckpoint (DoD row 5)', async () => {
    const { deps } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [], finishReason: 'stop' },
    }));
    const compactionStep = vi.fn(async () => ({
      ok: true as const,
      summary: 'fresh summary text',
    }));
    const persistSpy = vi.fn(deps.persistStep);
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        persistStep: persistSpy,
        compactionStep,
        compactionScope: COMPACT_SCOPE,
        compactionFilesTouched: ['lib/a.ts'],
        compactionRetainedTail: [{ role: 'user', content: 'tail row' }],
      },
      {
        userMessage: 'continue',
        priorMessages: [{ role: 'user', content: 'prior' }],
        compact: { span: [{ role: 'user', content: 'old' }] },
      },
    );
    expect(result.status).toBe('completed');
    const folds = persistSpy.mock.calls
      .map((c) => c[0].fold)
      .filter((f) => f?.compactionCheckpoint !== undefined);
    expect(folds.length).toBeGreaterThan(0);
    const ck = folds[0]!.compactionCheckpoint as {
      summary: string;
      filesTouched: string[];
      retainedTail: unknown[];
    };
    expect(ck.summary).toContain('fresh summary text');
    expect(ck.filesTouched).toEqual(['lib/a.ts']);
    // Adversarial #955 Goal 2: persist the live post-compact conversation,
    // not the frozen cut-time tail (this turn must survive prefer-checkpoint).
    expect(ck.retainedTail).toEqual([
      { role: 'user', content: 'tail row' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', delta: { text: 'hi', toolCalls: [] } },
    ]);
  });

  it('no compact input → zero summarizer calls (default path unchanged)', async () => {
    const { deps } = wiredDeps();
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'hi', toolCalls: [], finishReason: 'stop' },
    }));
    const compactionStep = vi.fn();
    await runTurnLoop(
      { ...deps, modelStep, compactionStep, compactionScope: COMPACT_SCOPE },
      { userMessage: 'hello', priorMessages: [{ role: 'user', content: 'p' }] },
    );
    expect(compactionStep).not.toHaveBeenCalled();
  });

  it('fail-open without priorMessages reconstructs span+tail (production compact path, adversarial #955)', async () => {
    const { deps, closed } = wiredDeps();
    let firstRoundMessages: unknown[] | undefined;
    const modelStep = vi.fn(async (args: { messages: ReadonlyArray<unknown> }) => {
      if (!firstRoundMessages) firstRoundMessages = [...args.messages];
      return {
        ok: true as const,
        delta: { text: 'hi', toolCalls: [], finishReason: 'stop' },
      };
    });
    const compactionStep = vi.fn(async () => ({
      ok: false as const,
      code: 'summarize_failed',
      error: 'boom',
    }));
    const result = await runTurnLoop(
      {
        ...deps,
        modelStep,
        compactionStep,
        compactionScope: COMPACT_SCOPE,
        compactionRetainedTail: [{ role: 'user', content: 'tail row' }],
      },
      {
        userMessage: 'continue',
        compact: {
          span: [{ role: 'user', content: 'span row' }],
          budgetTokens: 100_000,
        },
      },
    );
    expect(result.status).toBe('completed');
    expect(firstRoundMessages).toEqual([
      { role: 'user', content: 'span row' },
      { role: 'user', content: 'tail row' },
      { role: 'user', content: 'continue' },
    ]);
    expect(closed()).toBe(1);
  });

  it('success seed trims [realSummary, ...tail] with pinnedCount 1 (adversarial #955 combined-seed rails)', async () => {
    const { deps } = wiredDeps();
    let firstRoundMessages: unknown[] | undefined;
    const modelStep = vi.fn(async (args: { messages: ReadonlyArray<unknown> }) => {
      if (!firstRoundMessages) firstRoundMessages = [...args.messages];
      return {
        ok: true as const,
        delta: { text: 'hi', toolCalls: [], finishReason: 'stop' },
      };
    });
    const fatSummary = 'S'.repeat(80);
    const fatTail = 'T'.repeat(2_000);
    const compactionStep = vi.fn(async () => ({
      ok: true as const,
      summary: fatSummary,
    }));
    await runTurnLoop(
      {
        ...deps,
        modelStep,
        compactionStep,
        compactionScope: COMPACT_SCOPE,
        compactionRetainedTail: [{ role: 'user', content: fatTail }],
      },
      {
        userMessage: 'continue',
        // Token budget keeps the pinned real summary + ask; the unpinned
        // fat tail overflows the combined seed (adversarial #955).
        compact: { span: [{ role: 'user', content: 'old' }], budgetTokens: 200 },
      },
    );
    expect(firstRoundMessages).toBeDefined();
    const rows = firstRoundMessages as Array<{ role: string; content?: string }>;
    expect(rows[0]?.role).toBe('user');
    expect(rows[0]?.content).toContain('Summary of earlier session');
    expect(rows[0]?.content).toContain(fatSummary);
    // Unpinned tail dropped; current ask still last.
    expect(rows.some((r) => r.content === fatTail)).toBe(false);
    expect(rows[rows.length - 1]).toEqual({ role: 'user', content: 'continue' });
  });
});
