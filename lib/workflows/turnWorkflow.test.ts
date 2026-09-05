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

import { describe, expect, it, vi, afterEach } from 'vitest';
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
  // entry reads it from getWorkflowMetadata().workflowRunId. Plan #923: the
  // entry ALSO reads workflowStartedAt (runtime-pinned, replay-stable Date) to
  // derive the 1-hour wall-clock deadlineAt — the mock must supply it.
  getWorkflowMetadata: () => ({
    workflowRunId: 'wr_0000_meta',
    // Future Date so the derived deadlineAt is not already elapsed (the entry's
    // wall-clock deadline would otherwise send the loop straight to wrap-up).
    workflowStartedAt: new Date(Date.now() + 3_600_000),
  }),
}));

// Mutable generateOneRound impl — the default mirrors the original adapter
// behavior; the plan #936 two-turn integration test overrides it per-turn.
// The declared return type is intentionally broad (the real generateOneRound
// returns a union of model-round shapes) so per-test overrides with or without
// `usage` / `toolCalls` all stay assignable.
const generateImpl = vi.hoisted(() => ({
  fn: async (_deps: unknown, _input: unknown): Promise<unknown> => ({
    ok: true as const,
    delta: { text: 'adapter-done', toolCalls: [], usage: { source: 'provider', total: 2 } },
  }),
}));

vi.mock('../agent/generateOneRound', () => ({
  generateOneRound: (deps: unknown, input: unknown) => generateImpl.fn(deps, input),
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
import { setToolWorldResolver } from './toolExecuteStep';
import { createRunFileFreshness } from '../agent/fileFreshness';
import { createTurnPersistSeam } from '../agent/turnPersistSeam';
import { MemoryBlobTranscriptStore } from '../sessions/blobStores';
import { MemorySessionStore } from '../sessions/memorySessionStore';
import type { ObjectScope } from '../sessions/blobStore';
import { setSessionStoreForTests } from '../tenancy/harnessSessionsRedis';
import { setBlobStoreForTests } from '../tenancy/harnessSessionsRedis';

afterEach(() => {
  setSessionStoreForTests(null);
  setBlobStoreForTests(null);
});

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

  it('plan #936 row 10 — two turns end-to-end: turn 1 runs a tool → projection persisted; turn 2 seeds the model step with structured tool-call/tool-result pairs', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const scope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's936' };
    setPersistSeamResolver(() => createTurnPersistSeam({ blobStore, envelopeStore, scope }));
    // Wire an executable read_file so turn 1's tool batch actually runs.
    setToolWorldResolver(() => ({
      registry: {
        read_file: {
          execute: async () => 'turn-1 file body',
        },
      },
      secrets: [],
      signal: new AbortController().signal,
      freshness: createRunFileFreshness(),
    }));

    // --- Turn 1: model calls read_file (round 1), then returns done (round 2). ---
    let turn1Round = 0;
    generateImpl.fn = async () => {
      turn1Round += 1;
      if (turn1Round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'reading',
            toolCalls: [{ toolName: 'read_file', toolCallId: 'c1', args: { path: 'x' } }],
          },
        };
      }
      return { ok: true as const, delta: { text: 'turn-1 done', toolCalls: [] } };
    };
    const r1 = await turnWorkflow({
      userMessage: 'read the file',
      modelId: 'mock-model',
      scope,
    });
    if (r1.status !== 'completed') {
      throw new Error(`turn 1 failed: ${JSON.stringify({ status: r1.status, error: (r1 as { error?: string }).error })}`);
    }
    expect(r1.status).toBe('completed');

    // The terminal persist wrote the model-messages projection as its own Blob
    // object; only the pointer rides meta.modelMessagesPointer.
    const env1 = await envelopeStore.readEnvelope(scope);
    const mmPointer = env1?.meta?.modelMessagesPointer;
    expect(typeof mmPointer).toBe('string');
    const projection = JSON.parse((await blobStore.read(mmPointer as string)) ?? 'null') as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(projection)).toBe(true);
    // Projection carries turn-1's user / assistant(+tool-calls) / tool rows with
    // toolCallId linkage — NOT a flattened prose fold.
    expect(projection.map((r) => r.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const projTool = projection.find((r) => r.role === 'tool') as
      | { toolCallId?: string; result?: string }
      | undefined;
    expect(projTool?.toolCallId).toBe('c1');
    expect(projTool?.result).toBe('turn-1 file body');

    // --- Turn 2: seed from the persisted projection; the model step receives
    // […turn-1 rows, {role:'user', content: rawPrompt}] converted to ModelMessage[]. ---
    let turn2Messages: Array<Record<string, unknown>> | undefined;
    let turn2Call = 0;
    generateImpl.fn = async (_deps: unknown, input: unknown) => {
      turn2Call += 1;
      if (turn2Call === 1) {
        turn2Messages = (input as { messages: Array<Record<string, unknown>> }).messages;
      }
      return { ok: true as const, delta: { text: 'turn-2 answer', toolCalls: [] } };
    };
    const r2 = await turnWorkflow({
      userMessage: 'use what you found',
      modelId: 'mock-model',
      scope,
      priorMessages: projection,
    });
    expect(r2.status).toBe('completed');
    expect(turn2Messages).toBeDefined();
    const m = turn2Messages!;
    // The seeded history arrives as typed ModelMessage rows: turn-1 user, an
    // assistant with a tool-call part, a tool with a tool-result part (linked by
    // toolCallId), turn-1's closing assistant, then the new raw user prompt.
    const roles = m.map((r) => r.role);
    expect(roles[0]).toBe('user');
    expect(roles.at(-1)).toBe('user');
    // The LAST user row is the RAW turn-2 prompt (never a flattened fold).
    const lastUser = m.at(-1) as { role: string; content?: unknown };
    expect(lastUser.content).toBe('use what you found');
    // A tool-call part + a tool-result part share the toolCallId c1.
    const asstWithCall = m.find(
      (r) =>
        r.role === 'assistant' &&
        Array.isArray(r.content) &&
        (r.content as Array<{ type?: string }>).some((p) => p.type === 'tool-call'),
    ) as { content: Array<{ type: string; toolCallId?: string }> } | undefined;
    expect(asstWithCall).toBeDefined();
    const callPart = asstWithCall!.content.find((p) => p.type === 'tool-call');
    expect(callPart?.toolCallId).toBe('c1');
    const toolMsg = m.find((r) => r.role === 'tool') as
      | { content: Array<{ type: string; toolCallId?: string; output?: { value?: string } }> }
      | undefined;
    expect(toolMsg).toBeDefined();
    const resultPart = toolMsg!.content.find((p) => p.type === 'tool-result');
    expect(resultPart?.toolCallId).toBe('c1');
    expect(resultPart?.output?.value).toBe('turn-1 file body');
  });

  it('plan #941 row 9 — two turns with a freshness reminder: turn 1 persists {paths}; turn 2 with the pointer folds the reminder as the trailing user row', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const scope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's941' };
    setPersistSeamResolver(() => createTurnPersistSeam({ blobStore, envelopeStore, scope }));
    setToolWorldResolver(() => ({
      registry: { read_file: { execute: async () => 'turn-1 file body' } },
      secrets: [],
      signal: new AbortController().signal,
      freshness: createRunFileFreshness(),
    }));
    // The in-step reminder read resolves the global test seams
    // (`setSessionStoreForTests` / `setBlobStoreForTests`) — point them at
    // THIS test's in-memory stores.
    setSessionStoreForTests(envelopeStore);
    setBlobStoreForTests(blobStore);

    // --- Turn 1: reads a file → volatile {paths} persisted. ---
    let turn1Round = 0;
    generateImpl.fn = async () => {
      turn1Round += 1;
      if (turn1Round === 1) {
        return {
          ok: true as const,
          delta: {
            text: 'reading',
            toolCalls: [{ toolName: 'read_file', toolCallId: 'c1', args: { path: 'src/foo.ts' } }],
          },
        };
      }
      return { ok: true as const, delta: { text: 'turn-1 done', toolCalls: [] } };
    };
    const r1 = await turnWorkflow({ userMessage: 'read it', modelId: 'mock-model', scope });
    expect(r1.status).toBe('completed');
    const env1 = await envelopeStore.readEnvelope(scope);
    const frPointer = env1?.meta?.freshnessReminderPointer;
    expect(typeof frPointer).toBe('string');
    const frBody1 = JSON.parse((await blobStore.read(frPointer as string)) ?? 'null') as {
      paths: string[];
    };
    expect(frBody1).toEqual({ paths: ['src/foo.ts'] });

    // --- Turn 2: the pointer rides in; the model step sees the trailing
    // reminder user row (below the whole seeded history). ---
    let turn2Messages: Array<Record<string, unknown>> | undefined;
    let turn2Call = 0;
    generateImpl.fn = async (_deps: unknown, input: unknown) => {
      turn2Call += 1;
      if (turn2Call === 1) {
        turn2Messages = (input as { messages: Array<Record<string, unknown>> }).messages;
      }
      return { ok: true as const, delta: { text: 'turn-2 answer', toolCalls: [] } };
    };
    const r2 = await turnWorkflow({
      userMessage: 'now edit it',
      modelId: 'mock-model',
      scope,
      priorMessages: [
        { role: 'user', content: 'read the file' },
        {
          role: 'assistant',
          delta: { text: 'reading', toolCalls: [{ toolName: 'read_file', toolCallId: 'c1', args: { path: 'src/foo.ts' } }] },
        },
        { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'turn-1 file body' },
      ],
      freshnessReminderPointer: frPointer as string,
    });
    expect(r2.status).toBe('completed');
    expect(turn2Messages).toBeDefined();
    const m = turn2Messages!;
    // The reminder is the LAST row (trailing fold), a `user` message starting
    // with the `Error:` prefix; the raw prompt sits directly before it.
    const last = m.at(-1) as { role: string; content?: unknown };
    expect(last.role).toBe('user');
    expect(String(last.content).startsWith('Error: File-freshness law for this session')).toBe(
      true,
    );
    expect(String(last.content)).toContain('- src/foo.ts');
    expect(String(last.content)).toContain('a FULL read');
    expect((m.at(-2) as { role: string; content?: unknown }).content).toBe('now edit it');

    // Turn 3 (zero-read): volatility — {paths:[]} persisted, pointer advanced.
    generateImpl.fn = async () => ({
      ok: true as const,
      delta: { text: 'no tools', toolCalls: [] },
    });
    const r3 = await turnWorkflow({
      userMessage: 'nothing to read',
      modelId: 'mock-model',
      scope,
    });
    expect(r3.status).toBe('completed');
    const env3 = await envelopeStore.readEnvelope(scope);
    const newPtr = env3?.meta?.freshnessReminderPointer;
    expect(typeof newPtr).toBe('string');
    const parsed3 = JSON.parse((await blobStore.read(newPtr as string)) ?? 'null') as {
      paths: string[];
    };
    expect(parsed3).toEqual({ paths: [] });
  });

  it('plan #941 — zero-read turn persists {paths:[]} and ADVANCES the pointer (clears a stale list)', async () => {
    const blobStore = new MemoryBlobTranscriptStore();
    const envelopeStore = new MemorySessionStore();
    const scope: ObjectScope = { tenantId: 't', userId: 'u', sessionId: 's941b' };
    setPersistSeamResolver(() => createTurnPersistSeam({ blobStore, envelopeStore, scope }));
    // Seed a stale pointer from a prior turn.
    await envelopeStore.upsertEnvelope(scope, {
      id: scope.sessionId,
      userId: scope.userId,
      tenantId: scope.tenantId,
      updatedAt: 10,
      meta: { freshnessReminderPointer: 't_fr_stale_ptr_0000' },
    });
    generateImpl.fn = async () => ({
      ok: true as const,
      delta: { text: 'no tools', toolCalls: [] },
    });
    const r = await turnWorkflow({ userMessage: 'hi', modelId: 'mock-model', scope });
    expect(r.status).toBe('completed');
    const env = await envelopeStore.readEnvelope(scope);
    const ptr = env?.meta?.freshnessReminderPointer;
    expect(typeof ptr).toBe('string');
    expect(ptr).not.toBe('t_fr_stale_ptr_0000');
    const parsed = JSON.parse((await blobStore.read(ptr as string)) ?? 'null') as {
      paths: string[];
    };
    expect(parsed.paths).toEqual([]);
  });

  it('turnWorkflow.ts source does not call getWriter (plan #842 — I/O is step-only)', () => {
    const src = readFileSync(fileURLToPath(new URL('./turnWorkflow.ts', import.meta.url)), 'utf8');
    // Comments may name the SDK method (adversarial-review #843 Nit L8); code must not.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code.includes('getWriter')).toBe(false);
    expect(src).toMatch(/writeTurnSse/);
    expect(src).toMatch(/closeTurnSse/);
  });

  it("writeTurnSse is 'use step' and delegates to writeOnDefaultStream; helper owns getWriter (plan #850)", () => {
    const stepSrc = readFileSync(fileURLToPath(new URL('./turnSseStep.ts', import.meta.url)), 'utf8');
    const writeSrc = readFileSync(fileURLToPath(new URL('./turnSseWrite.ts', import.meta.url)), 'utf8');
    const writeIdx = stepSrc.indexOf('export async function writeTurnSse');
    const closeIdx = stepSrc.indexOf('export async function closeTurnSse');
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(writeIdx);
    const writeFn = stepSrc.slice(writeIdx, closeIdx);
    const closeFn = stepSrc.slice(closeIdx);
    const writeFnCode = writeFn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const writeHelperCode = writeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(writeFn).toMatch(/\{\s*'use step';/);
    expect(writeFn).toMatch(/writeOnDefaultStream/);
    expect(writeFnCode).not.toMatch(/getWriter\s*\(/);
    expect(closeFn).toMatch(/\{\s*'use step';/);
    expect(closeFn).toMatch(/\.close\s*\(/);
    expect(writeHelperCode).not.toMatch(/['"]use step['"]/);
    expect(writeSrc).toMatch(/export async function writeOnDefaultStream/);
    expect(writeSrc).toMatch(/export async function withDefaultStreamWriter/);
    expect(writeSrc).toMatch(/getWriter\s*\(/);
  });

  it("modelGenerateStep live-writes via withDefaultStreamWriter; does not import turnSseStep (plan #855)", () => {
    const src = readFileSync(
      fileURLToPath(new URL('./modelGenerateStep.ts', import.meta.url)),
      'utf8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/'use step'/);
    expect(code).toMatch(/withDefaultStreamWriter/);
    expect(code).not.toMatch(/\bwriteOnDefaultStream\b/);
    expect(code).toMatch(/formatLiveModelSse/);
    expect(code).toMatch(/onEvent:/);
    expect(code).not.toMatch(/from ['"]\.\/turnSseStep['"]/);
    expect(code).not.toMatch(/\bwriteTurnSse\b/);
    expect(code).not.toMatch(/\bcloseTurnSse\b/);
  });

  it('turnLoop/turnWorkflow do not import turnSseWrite (plan #850 static-graph leaf)', () => {
    const loop = readFileSync(fileURLToPath(new URL('./turnLoop.ts', import.meta.url)), 'utf8');
    const entry = readFileSync(
      fileURLToPath(new URL('./turnWorkflow.ts', import.meta.url)),
      'utf8',
    );
    const loopCode = loop.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const entryCode = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(loopCode).not.toMatch(/turnSseWrite/);
    expect(entryCode).not.toMatch(/turnSseWrite/);
  });

  it('forwards disableTools into modelGenerateStep (adversarial #879)', () => {
    const src = readFileSync(fileURLToPath(new URL('./turnWorkflow.ts', import.meta.url)), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/disableTools/);
    expect(code).toMatch(
      /\.\.\.\s*\(\s*disableTools\s*\?\s*\{\s*disableTools:\s*true\s*\}\s*:\s*\{\s*\}\s*\)/,
    );
  });

  it('forwards deadlineAt + wrapUp into both step adapters (adversarial-review #926)', () => {
    const src = readFileSync(fileURLToPath(new URL('./turnWorkflow.ts', import.meta.url)), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Derived once from the SDK-pinned startedAt — never a live Date.now() in
    // the `'use workflow'` body (replay determinism; plan #925 row 10).
    expect(code).toMatch(
      /workflowStartedAt\.getTime\(\)\s*\+\s*TURN_WALL_CLOCK_MAX_MS/,
    );
    // Both step closures thread the serialized number (the 4h mid-step abort
    // is dead if either drop is silent — persist-fold bug class).
    expect(code).toMatch(/deadlineAt,/);
    expect(code).toMatch(/wrapUp\s*!==\s*undefined/);
    expect(code).toMatch(/\{\s*wrapUp\s*\}/);
  });

  it('forwards serializable reasoning into modelGenerateStep; does not fetch Gateway (plan #897)', () => {
    const entry = readFileSync(fileURLToPath(new URL('./turnWorkflow.ts', import.meta.url)), 'utf8');
    const step = readFileSync(
      fileURLToPath(new URL('./modelGenerateStep.ts', import.meta.url)),
      'utf8',
    );
    const entryCode = entry.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const stepCode = step.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(entryCode).toMatch(/reasoning\?:\s*string/);
    expect(entryCode).toMatch(/args\.reasoning\s*!==\s*undefined/);
    expect(entryCode).not.toMatch(/modelCatalog/);
    expect(stepCode).toMatch(/reasoning\?:\s*string/);
    expect(stepCode).toMatch(/args\.reasoning\s*!==\s*undefined/);
    expect(stepCode).not.toMatch(/modelCatalog/);
    expect(stepCode).not.toMatch(/ai-gateway\.vercel\.sh/);
  });
});
