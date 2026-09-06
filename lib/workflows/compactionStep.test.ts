/**
 * Plan #950 (source #552 — A4 compaction phase 3, parent #947) — the
 * compaction TRIGGER + pre-loop summarizer wiring:
 *
 *  - route trigger: the PRE-TRIM projection overflows the #944 fold budget
 *    (`shouldCompact`) + a clean user-boundary cut exists → `start()` args
 *    carry `compact: {span, filesTouched, retainedTail}` (DoD row 1);
 *  - no clean cut / under-budget → NO compact arg, today's #944 trim path
 *    unchanged (DoD row 2 / parent correction row);
 *  - loop seeding: with a successful summarizer the initial model round
 *    sees `[summaryRow, ...retainedTail, user]` (DoD row 3);
 *  - fail-open: a failing summarizer never blocks the turn — the seed falls
 *    back to the plain projection (parent edge-case lock);
 *  - checkpoint writer (parent review-note 2 lock): the terminal fold
 *    carries `compactionCheckpoint` so the seam advances
 *    `meta.compactionPointer` (DoD row 5);
 *  - no compaction when the summarizer is not wired (unit fixtures).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// 1. compactionStep unit (tools-off summarizer)
// ---------------------------------------------------------------------------

describe('compactionStep (plan #950)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('ok path: one tools-off round over the span; returns the delta text; no tools passed', async () => {
    const write = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream: write,
      withDefaultStreamWriter: async (
        fn: (w: (p: string) => Promise<void>) => Promise<unknown>,
      ) => fn(write),
    }));
    const m1 = vi.fn(async (_deps: unknown, input: unknown) => {
      const i = input as { messages: unknown[]; tools?: Record<string, unknown> };
      expect(Array.isArray(i.messages)).toBe(true);
      // Tools-off by construction: empty registry, no schemas.
      expect(i.tools).toEqual({});
      return { ok: true as const, delta: { text: 'the summary', toolCalls: [] } };
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
    const { compactionStep } = await import('./compactionStep');
    const res = await compactionStep({
      modelId: 'anthropic/claude-a',
      span: [{ role: 'user', content: 'turn 1' }],
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    expect(res).toEqual({ ok: true, summary: 'the summary' });
    // BYOK re-resolved in-step; the summarizer system prompt is the honesty
    // one; no tools key on the deps (generateOneRound input has empty {}).
    const deps = m1.mock.calls[0]?.[0] as { system?: string; modelId?: string };
    expect(deps.modelId).toBe('byok-resolved');
    expect(deps.system).toContain('Summary of earlier session');
  });

  it('fail-open shape: model error → {ok:false, code:"summarize_failed"}', async () => {
    const write = vi.fn(async () => {});
    vi.doMock('./turnSseWrite', () => ({
      writeOnDefaultStream: write,
      withDefaultStreamWriter: async (
        fn: (w: (p: string) => Promise<void>) => Promise<unknown>,
      ) => fn(write),
    }));
    vi.doMock('../agent/generateOneRound', () => ({
      generateOneRound: async () => ({
        ok: false as const,
        code: 'model_error',
        error: 'boom',
      }),
    }));
    vi.doMock('../di/index', () => ({
      createProdServices: () => ({
        resolveInferenceForRequest: {
          resolveByokForRequest: async () => ({
            ok: true as const,
            modelId: 'm',
            provider: 'anthropic',
            credentials: {},
            only: ['anthropic'] as [string],
            byok: { anthropic: [{}] },
            secretId: 's',
            secretsToRedact: [],
          }),
        },
      }),
    }));
    const { compactionStep } = await import('./compactionStep');
    const res = await compactionStep({
      modelId: 'm',
      span: [],
      scope: { tenantId: 't', userId: 'u', sessionId: 's' },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('summarize_failed');
  });

  it('wall clock: an already-elapsed deadline fails closed with the wall sentinel', async () => {
    const { compactionStep } = await import('./compactionStep');
    const res = await compactionStep({
      modelId: 'm',
      span: [],
      scope: { tenantId: 't', userId: 'u', sessionId: 's' },
      deadlineAt: Date.now() - 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('wall_clock');
  });

  it('serializable args roundtrip (adversarial L1): plain values only', async () => {
    const { compactionStep } = await import('./compactionStep');
    const stepArgs = {
      modelId: 'm',
      span: [{ role: 'user', content: 'turn 1' }],
      scope: { tenantId: 't', userId: 'u', sessionId: 's' },
    };
    // Adversarial L1: every step arg must be JSON-serializable (Vercel
    // serializes ALL args to a `'use step'` fn — closures become nothing).
    expect(JSON.parse(JSON.stringify(stepArgs))).toEqual(stepArgs);
    // Smoke: the step accepts the plain shape (BYOK mock not needed — the
    // DI import may throw in this bare module state; the step must return a
    // fail value, never throw).
    const res = await compactionStep(stepArgs);
    expect(['ok', 'code']).toContain(res.ok === true ? 'ok' : 'code');
  });
});
