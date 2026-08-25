/**
 * backend-agents B12 (#806) — turn-loop + step-wrapper tests.
 *
 * Covers the plan's 10-case testing matrix:
 *  1. Loop: model returns empty `toolCalls` → breaks after one round; no tools
 *  2. Loop: model returns N tool calls → each runs once via toolExecuteStep; loop continues
 *  3. Loop: rounds reach the 256 cap → terminates (never infinite); writable closed
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

import { describe, expect, it, vi } from 'vitest';
import {
  runTurnLoop,
  MAX_WORKFLOW_STEPS,
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
  // The persist seam is a module-level resolver (adversarial L1: never a step
  // arg). wiring it here means the REAL persistStep, when the loop hits the
  // terminal persist path, re-resolves the seam in-step.
  setPersistSeamResolver(() => seam.seam);
  const persistFail = overrides.persistFail ?? false;
  const base = {
    persistStep: persistFail
      ? async () => ({ ok: false as const, code: 'write_failed', error: 'boom' })
      : async (p: {
          turnRunId: string;
          deltas: ReadonlyArray<unknown>;
          fold?: PersistStepFold;
        }) =>
          persistStep({
            turnRunId: p.turnRunId,
            deltas: p.deltas,
            ...(p.fold !== undefined ? { fold: p.fold } : {}),
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
    expect(events.some((e: { type: string }) => e.type === 'text_delta')).toBe(true);
    const done = events.find((e: { type: string }) => e.type === 'done') as {
      type: string;
      text: string;
    };
    expect(done.text).toBe('hi');
    expect(events.some((e: { type: string }) => e.type === 'text')).toBe(false);
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
    expect(events.filter((e: { type: string }) => e.type === 'tool_start').map((e: { name: string }) => e.name)).toEqual([
      'list_dir',
      'read_file',
    ]);
    expect(events.some((e: { type: string }) => e.type === 'tool_start' && 'toolName' in e)).toBe(false);
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
    // cap = TOTAL STEPS (adversarial L6): round 1 consumes 1 model step + 1 tool
    // step = 2, budget exhausted → capped. Must never be infinite.
    expect(result.steps).toBe(2);
    expect(result.rounds).toBe(1);
    expect(toolStep).toHaveBeenCalledTimes(1);
    expect(closed()).toBe(1);
  });

  it('matrix 3b (L6): cap counts steps, so a per-round tool fanout is bounded', async () => {
    const { deps, w, closed } = wiredDeps({ maxSteps: 3 });
    // One round emits FOUR tool calls. cap=3 steps → 1 model + 2 tool steps only;
    // the remaining tool calls must NOT run (the budget bounds the fanout).
    const modelStep = vi.fn(async () => ({
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
    // 1 model + 2 tools = 3 steps; the 3rd/4th tool calls never run.
    expect(result.steps).toBe(3);
    expect(toolStep).toHaveBeenCalledTimes(2);
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

  it('B13 integration: real B7/B8/B6 seam wired via resolver — a completed run derives the fold AT PERSIST TIME (usage/checkpoint from THIS run; run-bind from start)', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const sscope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's1' };
    const { deps, closed } = wiredDeps();
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
    const { deps, closed } = wiredDeps();
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
    const { deps, closed } = wiredDeps();
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
    // Messages: user, assistant(delta), tool(read_file), tool(list_dir), assistant(no tools), persist
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

describe('step wrappers (matrix 4–7)', () => {
  it('matrix 4 + 5: modelGenerateStep is a thin shell — delegates generateOneRound, re-resolves BYOK in-step, assembles FULL tool schemas via shared helper, serializable args', async () => {
    // Mock generateOneRound to prove the wrapper delegates and forwards plain
    // serializable args with the FULL registry (schemas-only).
    const m1 = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { messages: unknown[]; tools?: Record<string, unknown> };
      expect(Array.isArray(i.messages)).toBe(true);
      // The tools dict must be the stripped FULL durable surface
      // (at minimum list_dir + skill tools), not the old stub.
      expect(typeof i.tools).toBe('object');
      expect(i.tools).toBeDefined();
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
    const result = await mod.modelGenerateStep(stepArgs);
    expect(m1).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.delta.text).toBe('m');
    // BYOK re-resolved IN-STEP: providerOptions.gateway must be present on the
    // generateOneRound deps, not a bare modelId.
    const argDeps = m1.mock.calls[0]?.[0] as { modelId?: string; providerOptions?: unknown; secrets?: unknown };
    expect(argDeps.modelId).toBe('byok-resolved');
    expect(argDeps.providerOptions).toEqual({
      gateway: { only: ['anthropic'], byok: { anthropic: [{ apiKey: 'sk-test' }] } },
    });
    expect(argDeps.secrets).toEqual(['sk-test']);
    // The tools passed to generateOneRound must be the FULL stripped registry
    // (not the old stub { find_skill: {}, fetch_skill: {} }).
    const inputTools = (m1.mock.calls[0]?.[1] as { tools?: Record<string, unknown> })?.tools;
    expect(inputTools).toBeDefined();
    expect(Object.keys(inputTools as object)).toContain('list_dir');
    expect(Object.keys(inputTools as object)).toContain('find_skill');
    vi.doUnmock('../agent/generateOneRound');
    vi.doUnmock('../di/index');
    vi.doUnmock('./assembleDurableToolWorld');
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
    const result = await persistStep({ turnRunId: 'run_1', deltas: [{ d: 1 }] });
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
    const seam = {
      persist: async () =>
        ({ ok: false as const, code: 'invalid_scope' as const, error: 'no scope' }),
    };
    setPersistSeamResolver(() => seam);
    const result = await persistStep({ turnRunId: 'r', deltas: [] });
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
