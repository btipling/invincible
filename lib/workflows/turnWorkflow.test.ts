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

vi.mock('workflow', () => ({
  getWritable: () => ({
    getWriter: () => ({ write: vi.fn(async () => {}), close: vi.fn(async () => {}) }),
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

    const result = await turnWorkflow({
      userMessage: 'go adapter',
      tools: {},
      modelId: 'mock-model',
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
});
