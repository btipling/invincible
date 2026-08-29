/**
 * backend-agents B12 (#806) — turn-loop + step-wrapper tests.
 *
 * Covers the plan's 10-case testing matrix:
 *  1. Loop: model returns empty `toolCalls` → breaks after one round; no tools
 *  2. Loop: model returns N tool calls → each runs once via toolExecuteStep; loop continues
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
import { reachableImports } from './staticGraph';
import { createTurnPersistSeam } from '../agent/turnPersistSeam';
import { MemoryBlobTranscriptStore } from '../sessions/blobStores';
import { MemorySessionStore } from '../sessions/memorySessionStore';
import type { ObjectScope } from '../sessions/blobStore';
import { parseCloudSessionSnapshot } from '../sessionRepository';
import { STEP_BUDGET_WRAPUP, STEP_BUDGET_ERROR } from '../agent/modelFinish';

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
    toolStep: async (): Promise<{ ok: false; code: 'tool_not_found'; error: string }> => ({
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

  it('finishReason length + empty tools → failed, SSE error, no done, terminal persist', async () => {
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
    expect(result.status).toBe('failed');
    expect(result.error).toBe('output truncated');
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.some((e: { type: string }) => e.type === 'done')).toBe(false);
    expect(events.some((e: { type: string; error?: string }) => e.type === 'error' && e.error === 'output truncated')).toBe(true);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy.mock.calls[0]![0].terminal).toBeUndefined();
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
    const toolStep = vi.fn(async () => ({ ok: true as const, result: 'ok', freshnessDelta: '[]' }));
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

  it('matrix 2: model returns N tool calls → each tool runs once via toolExecuteStep; loop continues', async () => {
    const { deps, w, closed } = wiredDeps();
    // Round 1 emits 2 tool calls (both run as tools); round 2 emits none, so the
    // loop breaks cleanly. Non-stateful mocks here would loop to the 256 cap.
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
    const toolStep = vi.fn(async ({ toolName }: { toolName: string }) => ({
      ok: true as const,
      result: `out:${toolName}`,
      freshnessDelta: '[]',
    }));
    const result = await runTurnLoop({ ...deps, modelStep, toolStep }, { userMessage: 'go' });
    expect(modelStep).toHaveBeenCalledTimes(2);
    expect(toolStep).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(2);
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.filter((e: { type: string }) => e.type === 'tool_start')).toEqual([]);
    expect(events.filter((e: { type: string }) => e.type === 'tool_result').map((e: { name: string }) => e.name)).toEqual([
      'list_dir',
      'read_file',
    ]);
    expect(events.some((e: { type: string }) => e.type === 'tool_start' && 'toolName' in e)).toBe(false);
  });

  it('matrix 3: loop reaches the cap → terminates (never infinite), writable closed', async () => {
    const { deps, w, closed } = wiredDeps({ maxSteps: 2 });
    // Every model round keeps returning a tool call, so the loop would never stop
    // under no cap — the cap must terminate it.
    const modelStep = vi.fn(async (_args: unknown) => ({
      ok: true as const,
      delta: { text: 'again', toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }] },
    }));
    const toolStep = vi.fn(async () => ({ ok: true as const, result: 'ok', freshnessDelta: '[]' }));
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
    expect(capEvents.some((e: { type: string }) => e.type === 'done')).toBe(false);
    expect(
      capEvents.some(
        (e: { type: string; error?: string }) =>
          e.type === 'error' && e.error === 'step budget exhausted',
      ),
    ).toBe(true);
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

  it('matrix 3b (L6): cap counts steps, so a per-round tool fanout is bounded', async () => {
    const { deps, w, closed } = wiredDeps({ maxSteps: 3 });
    // One round emits FOUR tool calls. cap=3 steps → 1 model + 1 user-line
    // persist + 1 tool; the remaining tool calls must NOT run.
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
    const toolStep = vi.fn(async () => ({ ok: true as const, result: 'r', freshnessDelta: '[]' }));
    const result = await runTurnLoop(
      { ...deps, maxSteps: 3, modelStep, toolStep },
      { userMessage: 'fan' },
    );
    expect(result.status).toBe('capped');
    // 1 model + 1 user-line persist + 1 tool = 3 steps; tools 2–4 never run.
    // Terminal persist on cap is a fourth step. Wrap-up does not run extra tools.
    expect(result.steps).toBe(4);
    expect(modelStep).toHaveBeenCalledTimes(2);
    expect((modelStep.mock.calls[1]?.[0] as { disableTools?: boolean }).disableTools).toBe(true);
    expect(toolStep).toHaveBeenCalledTimes(1);
    const fanWrap = modelStep.mock.calls[1]?.[0] as {
      messages: Array<{ role?: string; toolCallId?: string; ok?: boolean }>;
    };
    const fanTools = fanWrap.messages.filter((m) => m.role === 'tool');
    expect(fanTools.map((m) => m.toolCallId).sort()).toEqual(['tc0', 'tc1', 'tc2', 'tc3']);
    expect(fanTools.filter((m) => m.ok === false)).toHaveLength(3);
    const fanErrIdx = fanWrap.messages.findIndex((m) => m.role === 'error');
    const lastToolIdx = fanWrap.messages.reduce(
      (acc, m, i) => (m.role === 'tool' ? i : acc),
      -1,
    );
    expect(lastToolIdx).toBeGreaterThan(-1);
    expect(lastToolIdx).toBeLessThan(fanErrIdx);
    expect(closed()).toBe(1);
    const fanEvents = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(fanEvents.some((e: { type: string }) => e.type === 'done')).toBe(false);
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

  it('wrap-up {ok:false} still terminal-persists and SSE-caps [adversarial #879 Minor]', async () => {
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
    expect(result.status).toBe('capped');
    expect(result.error).toBe(STEP_BUDGET_ERROR);
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
          e.type === 'error' && e.error === STEP_BUDGET_ERROR,
      ),
    ).toBe(true);
    expect(events.some((e: { error?: string }) => e.error === 'wrap boom')).toBe(false);
    expect(closed()).toBe(1);
  });

  it('wrap-up throw still terminal-persists and SSE-caps [adversarial #879 Minor]', async () => {
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
    expect(result.status).toBe('capped');
    expect(result.error).toBe(STEP_BUDGET_ERROR);
    const last = persistSpy.mock.calls[persistSpy.mock.calls.length - 1]?.[0] as {
      terminal?: boolean;
    };
    expect(last.terminal).toBeUndefined();
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(
      events.some(
        (e: { type: string; error?: string }) =>
          e.type === 'error' && e.error === STEP_BUDGET_ERROR,
      ),
    ).toBe(true);
    expect(events.some((e: { error?: string }) => e.error === 'wrap threw')).toBe(false);
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
    const toolStep = vi.fn(async () => ({
      ok: true as const,
      result: 'ok',
      freshnessDelta: '[]',
    }));
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
    const toolStep = vi.fn(async () => ({
      ok: true as const,
      result: 'ok',
      freshnessDelta: '[]',
    }));
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

  it('failed tool after user-line persist does not extra-persist', async () => {
    const { deps, closed } = wiredDeps();
    const persistSpy = vi.fn(deps.persistStep);
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: {
        text: 'call',
        toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
      },
    }));
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
    expect(result.error).toBe('down');
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect((persistSpy.mock.calls[0]?.[0] as { terminal?: boolean }).terminal).toBe(
      false,
    );
    expect(closed()).toBe(1);
  });

  it('mid-turn persist {ok:false} fails the loop before tools run', async () => {
    const { deps, closed } = wiredDeps({ persistFail: true });
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: {
        text: 'call',
        toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1', args: {} }],
      },
    }));
    const toolStep = vi.fn();
    const result = await runTurnLoop({ ...deps, modelStep, toolStep }, { userMessage: 'go' });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
    expect(toolStep).not.toHaveBeenCalled();
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
    const toolStep = vi.fn(async (a: { toolName: string; freshnessSeed?: string }) =>
      a.toolName === 'read_file'
        ? { ok: true as const, result: 'R', freshnessDelta: 'LEDGER-R1' }
        : {
            // write_file must see the round-1 ledger threaded in
            ok: true as const,
            result: `W:${a.freshnessSeed ?? '(none)'}`,
            freshnessDelta: 'LEDGER-R2',
          },
    );
    const result = await runTurnLoop({ ...deps, modelStep, toolStep }, { userMessage: 'g' });
    expect(result.status).toBe('completed');
    expect(result.rounds).toBe(3);
    // The write tool (2nd call) received the round-1 ledger as its seed.
    expect(toolStep).toHaveBeenCalledTimes(2);
    const writeCall = toolStep.mock.calls[1]?.[0] as { toolName: string; freshnessSeed?: string };
    expect(writeCall.freshnessSeed).toBe('LEDGER-R1');
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

  it('matrix 9b: persist {ok:false} → value, loop terminates cleanly, writable closed once', async () => {
    const { deps, w, closed } = wiredDeps({ persistFail: true });
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'done', toolCalls: [] },
    }));
    const result = await runTurnLoop({ ...deps, modelStep }, { userMessage: 'x' });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('boom');
    expect(closed()).toBe(1);
    const events = w.lines.map((l) => JSON.parse(l.replace(/^data: /, '').trim()));
    expect(events.find((e: { type: string }) => e.type === 'error')).toEqual({
      type: 'error',
      error: 'boom',
    });
    expect(events.some((e: { type: string }) => e.type === 'error' && 'message' in e)).toBe(
      false,
    );
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
    const toolStep = vi.fn(async (a: { toolName: string }) =>
      a.toolName === 'change_dir'
        ? { ok: true as const, result: 'change_dir lib: ok cwd=lib', freshnessDelta: '[]' }
        : { ok: true as const, result: 'switched active sandbox to id=sb_b tools=[]', freshnessDelta: '[]' },
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
    const toolStep = vi.fn(async () => ({ ok: true as const, result: 'r', freshnessDelta: '[]' }));
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
    const toolStep = vi.fn(async (a: { toolName: string; persistRunBind?: { cwd?: string; activeSandboxId?: string } }) => {
      if (a.toolName === 'change_dir') {
        return { ok: true as const, result: 'change_dir lib: ok cwd=lib', freshnessDelta: '[]' };
      }
      // list_dir: capture what cwd the loop passed to THIS tool step.
      return { ok: true as const, result: `cwd=${a.persistRunBind?.cwd ?? '(none)'}`, freshnessDelta: '[]' };
    });
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, turnRunId: 'wr_bind', persistRunBind: { cwd: 'app' } },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    // Two tool calls: change_dir then list_dir.
    expect(toolStep).toHaveBeenCalledTimes(2);
    // First tool (change_dir) still sees start bind.
    const firstCall = toolStep.mock.calls[0]?.[0] as { toolName: string; persistRunBind?: { cwd?: string } };
    expect(firstCall.toolName).toBe('change_dir');
    expect(firstCall.persistRunBind?.cwd).toBe('app');
    // Second tool (list_dir) MUST see the UPDATED cwd from change_dir.
    const secondCall = toolStep.mock.calls[1]?.[0] as { toolName: string; persistRunBind?: { cwd?: string } };
    expect(secondCall.toolName).toBe('list_dir');
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
    const toolStep = vi.fn(async (a: { toolName: string; persistRunBind?: { activeSandboxId?: string } }) => {
      if (a.toolName === 'meta_sandbox_switch') {
        return { ok: true as const, result: 'switched active sandbox to id=sb_b tools=[]', freshnessDelta: '[]' };
      }
      return { ok: true as const, result: 'ok', freshnessDelta: '[]' };
    });
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, turnRunId: 'wr_switch2', persistRunBind: { activeSandboxId: 'sb_a' } },
      { userMessage: 'go' },
    );
    expect(result.status).toBe('completed');
    expect(toolStep).toHaveBeenCalledTimes(1);
    // The switch tool itself still sees the start bind (sb_a).
    const firstCall = toolStep.mock.calls[0]?.[0] as { toolName: string; persistRunBind?: { activeSandboxId?: string } };
    expect(firstCall.toolName).toBe('meta_sandbox_switch');
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
    const toolStep = vi.fn(async (a: { toolName: string; persistRunBind?: { cwd?: string } }) => {
      // change_dir FAILS — the bind must NOT be overwritten.
      return { ok: false as const, code: 'sandbox_error' as const, error: 'no such dir' };
    });
    // The first tool call fails → loop terminates with a tool error value.
    // But the loop writes tool_result with error and returns completed, not
    // failed — per the existing "business error as value" convention.
    const result = await runTurnLoop(
      { ...deps, modelStep, toolStep, turnRunId: 'wr_failbind', persistRunBind: { cwd: 'app' } },
      { userMessage: 'go' },
    );
    // A failed tool terminates the loop cleanly (business error is a value).
    expect(result.status).toBe('completed');
    expect(toolStep).toHaveBeenCalledTimes(1);
    const call = toolStep.mock.calls[0]?.[0] as { toolName: string; persistRunBind?: { cwd?: string } };
    expect(call.persistRunBind?.cwd).toBe('app'); // start bind, unchanged
    // modelStep was called once (the tool error terminates before round 2).
    expect(modelStep).toHaveBeenCalledTimes(1);
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
    const toolStep = vi.fn(async (a: { toolName: string; persistRunBind?: { cwd?: string; activeSandboxId?: string } }) => ({
      ok: true as const,
      result: `read cwd=${a.persistRunBind?.cwd} sandbox=${a.persistRunBind?.activeSandboxId}`,
      freshnessDelta: '[]',
    }));
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
    const first = toolStep.mock.calls[0]?.[0] as { toolName: string; persistRunBind?: { cwd?: string; activeSandboxId?: string } };
    expect(first.toolName).toBe('read_file');
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
    const toolStep = vi.fn(async (a: { toolName: string }) => ({
      ok: true as const,
      result: `result of ${a.toolName}`,
      freshnessDelta: '[]',
    }));
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
    const toolStep = vi.fn(async () => ({
      ok: true as const,
      result: 'ok',
      freshnessDelta: '[]',
    }));
    await runTurnLoop({ ...deps, modelStep, toolStep }, { userMessage: 'go' });
    const events = parseEvents(w.lines);
    const types = events.map((e) => e.type);
    expect(types).not.toContain('reasoning_delta');
    expect(types).not.toContain('tool_start');
    expect(types).toContain('tool_result');
    expect(types.indexOf('tool_result')).toBeLessThan(types.indexOf('done'));
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
    vi.doMock('../tenancy/skillInject', () => ({
      resolveSkillPreamble: async () => ({
        preamble: '### Skill attached: create-plan\nPlan in YAML.',
        attachedSlugs: ['create-plan'],
        events: [],
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
    expect(argDeps.system).toContain('<attached_skills>');
    expect(argDeps.system).toContain('### Skill attached: create-plan');
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
    vi.doUnmock('./turnSseWrite');
    vi.doUnmock('../tenancy/harnessSessionsRedis');
    vi.doUnmock('../tenancy/personaInject');
    vi.doUnmock('../tenancy/skillInject');
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
    vi.doMock('../agent/executeTool', () => ({ executeTool: m }));
    vi.doMock('../agent/fileFreshness', () => ({
      hydrateRunFileFreshness: (_s: string | undefined) => ({}),
      createRunFileFreshness: () => ({}),
    }));
    const mod = await import('./toolExecuteStep');
    // The tool world (registry) is resolved IN-STEP from the module resolver —
    // never passed as a serialized step arg (adversarial L1).
    mod.setToolWorldResolver(() => ({ registry: {}, secrets: [], signal: undefined, freshness: {} }));
    const stepArgs = { toolName: 'nope', callArgs: {} };
    // Step args must be plain serializable values.
    expect(JSON.parse(JSON.stringify(stepArgs))).toEqual(stepArgs);
    const result = await mod.toolExecuteStep(stepArgs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('tool_not_found');
      expect(result.error).toContain('nope');
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('../agent/fileFreshness');
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
    const mod = await import('./toolExecuteStep');
    // Resolver SET → test path. Pass the marked freshness directly.
    mod.setToolWorldResolver(() => ({
      registry: { test_tool: {} },
      secrets: [],
      signal: undefined,
      freshness: freshnessMarker,
    }));
    const result = await mod.toolExecuteStep({
      toolName: 'test_tool',
      callArgs: {},
      freshnessSeed: 'seed',
    });
    expect(result.ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    vi.doUnmock('../agent/executeTool');
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
      deltas: unknown[];
    };
    expect(body.id).toBe(LOOP_SCOPE.sessionId);
    expect(body.deltas).toEqual([{ d: 1 }]);
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
});
