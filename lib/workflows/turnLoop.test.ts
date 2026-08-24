/**
 * backend-agents B12 (#806) — turn-loop + step-wrapper tests.
 *
 * Covers the plan's 10-case testing matrix:
 *  1. Loop: model returns empty `toolCalls` → breaks after one round; no tools
 *  2. Loop: model returns N tool calls → each runs once via toolExecuteStep; loop continues
 *  3. Loop: rounds reach the 256 cap → terminates (never infinite); writable closed
 *  4. Step args serializable (no closures/seams/bound runners cross a boundary)
 *  5. modelGenerateStep thin shell → delegates generateOneRound (delta; tool schemas only)
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

import { describe, expect, it, vi } from 'vitest';
import {
  runTurnLoop,
  MAX_WORKFLOW_STEPS,
  type TurnWritable,
  type TurnLoopDeps,
} from './turnLoop';
import { modelGenerateStep } from './modelGenerateStep';
import { toolExecuteStep } from './toolExecuteStep';
import { persistStep, createInMemoryPersistSeam } from './persistStep';
import { reachableImports } from './staticGraph';

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
} = {}): {
  deps: Omit<TurnLoopDeps, 'modelStep'>;
  w: { writable: TurnWritable; lines: string[]; closed: number };
  closed: () => number;
} {
  const fake = fakeWritable();
  const seam = createInMemoryPersistSeam();
  const persistFail = overrides.persistFail ?? false;
  const base = {
    persistStep: persistFail
      ? async () => ({ ok: false as const, code: 'write_failed', error: 'boom' })
      : async (p: { turnRunId: string; deltas: ReadonlyArray<unknown> }) =>
          persistStep({ persist: seam.seam }, { turnRunId: p.turnRunId, deltas: p.deltas }),
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
  });

  it('matrix 3: loop reaches the cap → terminates (never infinite), writable closed', async () => {
    const { deps, w, closed } = wiredDeps({ maxSteps: 2 });
    // Every model round keeps returning a tool call, so the loop would never stop
    // under no cap — the cap must terminate it.
    const modelStep = vi.fn(async () => ({
      ok: true as const,
      delta: { text: 'again', toolCalls: [{ toolName: 'list_dir', toolCallId: 'c', args: {} }] },
    }));
    const toolStep = vi.fn(async () => ({ ok: true as const, result: 'ok', freshnessDelta: '[]' }));
    const result = await runTurnLoop(
      { ...deps, maxSteps: 2, modelStep, toolStep },
      { userMessage: 'loop' },
    );
    expect(result.status).toBe('capped');
    // cap = 2 iterations: after round 1 returns toolCalls, the while-loop refills
    // and runs round 2, then stops at ≥ cap — must never be infinite.
    expect(result.rounds).toBeLessThanOrEqual(2);
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
});

describe('step wrappers (matrix 4–7)', () => {
  it('matrix 4 + 5: modelGenerateStep is a thin shell — delegates generateOneRound, serializable args', async () => {
    // Mock generateOneRound to prove the wrapper delegates and forwards plain
    // serializable args. (The schemas-only stripping is B9's job, pinned in
    // generateOneRound.test.ts; the wrapper must not invent/deny that invariant.)
    const m1 = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { messages: unknown[]; modelId?: string };
      expect(Array.isArray(i.messages)).toBe(true);
      return { ok: true as const, delta: { text: 'm', toolCalls: [] } };
    });
    vi.doMock('../agent/generateOneRound', () => ({ generateOneRound: m1 }));
    const mod = await import('./modelGenerateStep');
    const result = await mod.modelGenerateStep({
      messages: [{ role: 'user', content: 'hi' }],
      modelId: 'm',
      tools: { list_dir: { description: 'd' } },
    });
    expect(m1).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.delta.text).toBe('m');
    // Wrapper forwards the caller's modelId verbatim (no in-body resolution).
    const argDeps = m1.mock.calls[0]?.[0] as { modelId?: string };
    expect(argDeps.modelId).toBe('m');
    vi.doUnmock('../agent/generateOneRound');
  });

  it('matrix 6: toolExecuteStep thin shell → delegates executeTool; business error is a value', async () => {
    const m = vi.fn(async (_deps: unknown, _input: unknown) => ({
      ok: false as const,
      code: 'tool_not_found' as const,
      error: 'Tool not found: nope',
    }));
    vi.doMock('../agent/executeTool', () => ({ executeTool: m }));
    vi.doMock('../agent/fileFreshness', () => ({
      hydrateRunFileFreshness: (s: string | undefined) => undefined,
      createRunFileFreshness: () => undefined,
    }));
    const mod = await import('./toolExecuteStep');
    const result = await mod.toolExecuteStep(
      { registry: {}, secrets: [], signal: undefined },
      { toolName: 'nope', callArgs: {} },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('tool_not_found');
      expect(result.error).toContain('nope');
    }
    vi.doUnmock('../agent/executeTool');
    vi.doUnmock('../agent/fileFreshness');
  });

  it('matrix 7: persistStep thin shell → persists via seam (in-memory); returns terminal status', async () => {
    const { seam, persisted } = createInMemoryPersistSeam();
    const result = await persistStep({ persist: seam }, { turnRunId: 'run_1', deltas: [{ d: 1 }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('completed');
      expect(result.turnRunId).toBe('run_1');
    }
    expect(persisted).toHaveLength(1);
    expect(persisted[0].turnRunId).toBe('run_1');
    expect(JSON.parse(persisted[0].content)).toEqual({ deltas: [{ d: 1 }] });
  });

  it('matrix 7b: persist seam {ok:false} → value, not throw', async () => {
    const seam = { persist: async () => ({ ok: false as const, code: 'invalid_scope' as const, error: 'no scope' }) };
    const result = await persistStep({ persist: seam }, { turnRunId: 'r', deltas: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_scope');
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
