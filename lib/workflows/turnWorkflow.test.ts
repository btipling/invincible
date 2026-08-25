/**
 * backend-agents B13 (#807) — `turnWorkflow` ENTRY-level adapter test.
 *
 * The adversarial review L1 flagged that `turnWorkflow` (the `'use workflow'`
 * entry) is never invoked anywhere in the test tree, so a `persistStepFn`
 * destructure that DROPS the derived `fold` would pass typecheck while silently
 * no-op-ing the terminal persist fold (DoD rows 3/5). This file exercises the
 * REAL entry with the workflow SDK (`getWritable`) and the B9 model core mocked,
 * then asserts the loop-derived fold (usage + checkpoint) AND the pre-run
 * sandbox run-bind (cwd/activeSandboxId) all reach the real B7/B8/B6 seam's
 * envelope write.
 *
 * Kept in its OWN file (hoisted `vi.mock`) so the per-test `doMock`s that
 * matrix 4–7 of `turnLoop.test.ts` perform on `../agent/generateOneRound` are
 * never cross-polluted — a dynamic `import('./turnWorkflow')` in that shared
 * file would load `modelGenerateStep` and break the sibling mocks.
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('workflow', () => ({
  getWritable: () => ({
    getWriter: () => ({
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    }),
    close: vi.fn(async () => {}),
  }),
  // C14b (#835): turnRunId is DERIVED in-workflow (never a start() arg), so the
  // entry reads it from getWorkflowMetadata().workflowRunId.
  getWorkflowMetadata: () => ({ workflowRunId: 'wr_0000_meta' }),
}));

vi.mock('../agent/generateOneRound', () => ({
  generateOneRound: async () => ({
    ok: true as const,
    delta: { text: 'adapter-done', toolCalls: [], usage: { source: 'provider', total: 2 } },
  }),
  // toolsWithoutExecutors: strip execute closures for serialization across the
  // step boundary. In tests the registry is empty, so this returns empty.
  toolsWithoutExecutors: (t: Record<string, unknown>) => t,
}));

// modelGenerateStep re-resolves BYOK in-step via a dynamic import of the DI
// root, and assembles the tool world via assembleDurableToolWorld. Mock both
// so the entry test doesn't try to open a real DB connection.
vi.mock('../di/index', () => ({
  createProdServices: () => ({
    resolveInferenceForRequest: {
      resolveByokForRequest: async () => ({
        ok: true as const,
        modelId: 'mock-model',
        provider: 'mock',
        credentials: {},
        only: ['mock'] as [string],
        byok: { mock: [{}] },
        secretId: 'sec-mock',
        secretsToRedact: [],
      }),
    },
  }),
}));

// The shared durable-tool-world helper is called by modelGenerateStep in prod.
// In tests, mock it to return a minimal world — no real sandbox/MCP/HTTP.
vi.mock('./assembleDurableToolWorld', () => ({
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

import { turnWorkflow } from './turnWorkflow';
import { setPersistSeamResolver } from './persistStep';
import { createTurnPersistSeam } from '../agent/turnPersistSeam';
import { MemoryBlobTranscriptStore } from '../sessions/blobStores';
import { MemorySessionStore } from '../sessions/memorySessionStore';
import type { ObjectScope } from '../sessions/blobStore';

describe('turnWorkflow entry (backend-agents B13)', () => {
  it('forward the loop-derived fold to the real seam: usage + checkpoint + run-bind all reach envelope meta', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const scope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's1' };
    setPersistSeamResolver(() => createTurnPersistSeam({ blobStore, envelopeStore, scope }));

    // NO tools key — tool schemas are assembled in-step via the shared helper.
    const result = await turnWorkflow({
      userMessage: 'go adapter',
      modelId: 'mock-model',
      scope: { tenantId: 't', userId: 'u', sessionId: 's1' },
      persistRunBind: { cwd: 'app', activeSandboxId: 'sb_adapter' },
    });
    expect(result.status).toBe('completed');

    const env = await envelopeStore.readEnvelope({ tenantId: 't', userId: 'u', sessionId: 's1' });
    // Fold NOT dropped by the adapter: pre-run sandbox run-bind folded…
    expect(env?.meta?.activeSandboxId).toBe('sb_adapter');
    expect(env?.meta?.logicalCwd).toBe('app');
    // …and this-run-derived usage + checkpoint reach the envelope via the real seam.
    expect(JSON.parse(env?.meta?.usage as string)).toEqual({ source: 'provider', total: 2 });
    const ckptPointer = env?.meta?.checkpointPointer;
    const ckptBody = typeof ckptPointer === 'string' ? JSON.parse((await blobStore.read(ckptPointer)) ?? 'null') : [];
    expect(ckptBody).toEqual([
      { role: 'user', content: 'go adapter' },
      { role: 'assistant', content: 'adapter-done' },
    ]);
    expect(env?.meta?.turnStatus).toBe('completed');
    expect(env?.meta?.transcriptPointer).toBeDefined();
    // C14b matrix row 8: the terminal persist's turnRunId is the workflow-run
    // id derived in-workflow (must equal the route-side run.runId, never the
    // session id 's1').
    expect(env?.meta?.turnRunId).toBe('wr_0000_meta');
  });

  it('turnWorkflow.ts source does not call getWriter (plan #842 — I/O is step-only)', () => {
    const src = readFileSync(fileURLToPath(new URL('./turnWorkflow.ts', import.meta.url)), 'utf8');
    // Comments may name the SDK method (adversarial-review #843 Nit L8); code must not.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code.includes('getWriter')).toBe(false);
    expect(src).toMatch(/writeTurnSse/);
    expect(src).toMatch(/closeTurnSse/);
  });

  it("writeTurnSse/closeTurnSse bodies are 'use step' and own getWriter/close (plan #842 adversarial L6)", () => {
    const src = readFileSync(fileURLToPath(new URL('./turnSseStep.ts', import.meta.url)), 'utf8');
    const writeIdx = src.indexOf('export async function writeTurnSse');
    const closeIdx = src.indexOf('export async function closeTurnSse');
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(writeIdx);
    const writeFn = src.slice(writeIdx, closeIdx);
    const closeFn = src.slice(closeIdx);
    expect(writeFn).toMatch(/\{\s*'use step';/);
    expect(closeFn).toMatch(/\{\s*'use step';/);
    expect(writeFn).toMatch(/getWriter\s*\(/);
    expect(closeFn).toMatch(/\.close\s*\(/);
  });
});
