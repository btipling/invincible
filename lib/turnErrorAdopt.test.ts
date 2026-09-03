import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adoptWorkerTranscriptOnError,
  recoverWorkerTranscriptBeforePut,
  shouldAdoptWorkerTranscriptOnError,
  shouldHoldCloudPut,
  heldSessionPutBlocked,
  keepFrozenClock,
  putUnlessHeld,
  wrapRepoPut,
  withHostOnlySuffix,
  withLocalOnlySuffix,
} from './turnErrorAdopt';
import { createEmptySession, formatPromptWithHistory, type SessionSnapshot } from './sessionStore';
import { shouldAdoptServer, type CloudGetResult } from './sessionRepository';

describe('shouldAdoptWorkerTranscriptOnError', () => {
  it('is true for durable SSE error after the worker completed', () => {
    expect(
      shouldAdoptWorkerTranscriptOnError({
        ok: false,
        streamOpened: true,
        turnStatus: 'completed',
      }),
    ).toBe(true);
  });

  it('is false on success, incomplete attach, or still-running', () => {
    expect(
      shouldAdoptWorkerTranscriptOnError({
        ok: true,
        streamOpened: true,
        turnStatus: 'completed',
      }),
    ).toBe(false);
    expect(
      shouldAdoptWorkerTranscriptOnError({
        ok: false,
        streamOpened: false,
        turnStatus: 'completed',
      }),
    ).toBe(false);
    expect(
      shouldAdoptWorkerTranscriptOnError({
        ok: false,
        streamOpened: true,
        turnStatus: 'running',
      }),
    ).toBe(false);
    expect(
      shouldAdoptWorkerTranscriptOnError({
        ok: false,
        streamOpened: true,
        turnStatus: 'cancelling',
      }),
    ).toBe(false);
  });
});

describe('withHostOnlySuffix', () => {
  it('appends local error/system rows the worker snapshot lacks', () => {
    const worker = [
      { id: 'h1', role: 'user' as const, text: 'run the suite', at: 1 },
      { id: 'h2', role: 'assistant' as const, text: 'wrap-up', at: 2 },
    ];
    const local = [
      ...worker,
      {
        id: 'e1',
        role: 'error' as const,
        text: 'Turn ended · turn wall clock exceeded',
        at: 3,
      },
    ];
    expect(withHostOnlySuffix(worker, local).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'error',
    ]);
  });
});

describe('adoptWorkerTranscriptOnError', () => {
  it('replaces the thin local snapshot with the worker GET; skipCloud always', async () => {
    const local = createEmptySession('sess_1');
    local.updatedAt = 9_000;
    local.turnStatus = 'completed';
    local.turnRunId = undefined;
    const worker = createEmptySession('sess_1');
    worker.updatedAt = 8_000;
    worker.turnStatus = 'running';
    worker.turnRunId = 'wrun_stale';
    worker.messages = [
      { id: 'h1', role: 'user', text: 'run the suite', at: 1 },
      { id: 'h2', role: 'assistant', text: 'wrap-up: 3 tests still fail', at: 2 },
    ];
    const got = await adoptWorkerTranscriptOnError({
      get: async () => ({ action: 'ok', snapshot: worker }),
      session: local,
    });
    expect(got.skipCloud).toBe(true);
    expect(got.session.messages.map((m) => m.text)).toEqual([
      'run the suite',
      'wrap-up: 3 tests still fail',
    ]);
    expect(got.session.updatedAt).toBe(8_000);
    expect(got.session.turnStatus).toBe('completed');
    expect(got.session.turnRunId).toBeUndefined();
  });

  it('unions F21 queue via mergeAdoptedUsage so a Busy queueAppend survives', async () => {
    const local = createEmptySession('sess_1');
    local.updatedAt = 9_000;
    local.turnStatus = 'completed';
    local.queue = ['follow-up A'];
    local.messages = [
      { id: 'e1', role: 'error', text: 'Turn ended · turn wall clock exceeded', at: 9 },
    ];
    const worker = createEmptySession('sess_1');
    worker.updatedAt = 8_000;
    worker.messages = [
      { id: 'h1', role: 'user', text: 'run the suite', at: 1 },
      { id: 'h2', role: 'assistant', text: 'wrap-up: 3 tests still fail', at: 2 },
    ];
    const got = await adoptWorkerTranscriptOnError({
      get: async () => ({ action: 'ok', snapshot: worker }),
      session: local,
    });
    expect(got.skipCloud).toBe(true);
    expect(got.session.queue).toEqual(['follow-up A']);
    expect(got.session.messages.map((m) => m.text)).toEqual([
      'run the suite',
      'wrap-up: 3 tests still fail',
      'Turn ended · turn wall clock exceeded',
    ]);
  });

  it('skips cloud PUT and freezes updatedAt when GET is missing or fails', async () => {
    const local = createEmptySession('sess_1');
    local.updatedAt = 9_000;
    const noGet = await adoptWorkerTranscriptOnError({
      get: undefined,
      session: local,
    });
    expect(noGet.skipCloud).toBe(true);
    expect(noGet.session.updatedAt).toBe(0);

    const failed = await adoptWorkerTranscriptOnError({
      get: async (): Promise<CloudGetResult> => ({
        action: 'error',
        status: 500,
        message: 'boom',
      }),
      session: local,
    });
    expect(failed.skipCloud).toBe(true);
    expect(failed.session.updatedAt).toBe(0);
  });
});

describe('shouldHoldCloudPut / recoverWorkerTranscriptBeforePut (adversarial #935)', () => {
  it('holds only on skipCloud + frozen updatedAt (GET miss)', () => {
    expect(shouldHoldCloudPut({ skipCloud: true, session: { updatedAt: 0 } })).toBe(
      true,
    );
    expect(shouldHoldCloudPut({ skipCloud: true, session: { updatedAt: 8_000 } })).toBe(
      false,
    );
    expect(shouldHoldCloudPut({ skipCloud: false, session: { updatedAt: 0 } })).toBe(
      false,
    );
  });

  it('withLocalOnlySuffix keeps a follow-up user the worker snapshot lacks', () => {
    const worker = [
      { id: 'h1', role: 'user' as const, text: 'run the suite', at: 1 },
      { id: 'h2', role: 'assistant' as const, text: 'wrap-up', at: 2 },
    ];
    const local = [
      { id: 'e1', role: 'error' as const, text: 'Turn ended · turn wall clock exceeded', at: 3 },
      { id: 'u2', role: 'user' as const, text: 'fix the remaining 3', at: 4 },
    ];
    expect(withLocalOnlySuffix(worker, local).map((m) => m.text)).toEqual([
      'run the suite',
      'wrap-up',
      'Turn ended · turn wall clock exceeded',
      'fix the remaining 3',
    ]);
  });

  it('withLocalOnlySuffix does not copy a local partial assistant onto the worker wrap-up', () => {
    const worker = [
      { id: 'h1', role: 'user' as const, text: 'run the suite', at: 1 },
      { id: 'h2', role: 'assistant' as const, text: 'wrap-up: 3 tests still fail', at: 2 },
    ];
    const local = [
      { id: 'h1', role: 'user' as const, text: 'run the suite', at: 1 },
      { id: 'acc', role: 'assistant' as const, text: 'wrap-up: 3 tests sti', at: 2 },
      {
        id: 'e1',
        role: 'error' as const,
        text: 'Turn ended · turn wall clock exceeded',
        at: 3,
      },
    ];
    expect(withLocalOnlySuffix(worker, local).map((m) => m.text)).toEqual([
      'run the suite',
      'wrap-up: 3 tests still fail',
      'Turn ended · turn wall clock exceeded',
    ]);
  });

  it('withLocalOnlySuffix treats a history-fold worker user as covering the composer line', () => {
    const prior = [
      { id: 'p1', role: 'user' as const, text: 'earlier', at: 1 },
      { id: 'p2', role: 'assistant' as const, text: 'ok', at: 2 },
    ];
    const fold = formatPromptWithHistory(prior, 'run the suite');
    const worker = [
      ...prior,
      { id: 'h1', role: 'user' as const, text: fold, at: 3 },
      { id: 'h2', role: 'assistant' as const, text: 'wrap-up: 3 tests still fail', at: 4 },
    ];
    const local = [
      ...prior,
      { id: 'u1', role: 'user' as const, text: 'run the suite', at: 3 },
      { id: 'acc', role: 'assistant' as const, text: 'wrap-up: 3 tests sti', at: 4 },
      {
        id: 'e1',
        role: 'error' as const,
        text: 'Turn ended · turn wall clock exceeded',
        at: 5,
      },
    ];
    expect(withLocalOnlySuffix(worker, local).map((m) => m.text)).toEqual([
      'earlier',
      'ok',
      fold,
      'wrap-up: 3 tests still fail',
      'Turn ended · turn wall clock exceeded',
    ]);
  });

  it('withLocalOnlySuffix copies a GET-miss follow-up user and its later assistant', () => {
    const worker = [
      { id: 'h1', role: 'user' as const, text: 'run the suite', at: 1 },
      { id: 'h2', role: 'assistant' as const, text: 'wrap-up: 3 tests still fail', at: 2 },
    ];
    const local = [
      { id: 'h1', role: 'user' as const, text: 'run the suite', at: 1 },
      { id: 'acc', role: 'assistant' as const, text: 'wrap-up: 3 tests sti', at: 2 },
      {
        id: 'e1',
        role: 'error' as const,
        text: 'Turn ended · turn wall clock exceeded',
        at: 3,
      },
      { id: 'u2', role: 'user' as const, text: 'fix the remaining 3', at: 4 },
      { id: 'a2', role: 'assistant' as const, text: 'patched the three failures', at: 5 },
    ];
    expect(withLocalOnlySuffix(worker, local).map((m) => m.text)).toEqual([
      'run the suite',
      'wrap-up: 3 tests still fail',
      'Turn ended · turn wall clock exceeded',
      'fix the remaining 3',
      'patched the three failures',
    ]);
  });

  it('GET ok recover suffixes the follow-up and clears skipCloud so a flatten PUT is safe', async () => {
    const local = createEmptySession('sess_1');
    local.updatedAt = 0;
    local.messages = [
      { id: 'e1', role: 'error', text: 'Turn ended · turn wall clock exceeded', at: 9 },
      { id: 'u2', role: 'user', text: 'fix the remaining 3', at: 10 },
    ];
    const worker = createEmptySession('sess_1');
    worker.updatedAt = 8_000;
    worker.messages = [
      { id: 'h1', role: 'user', text: 'run the suite', at: 1 },
      { id: 'h2', role: 'assistant', text: 'wrap-up: 3 tests still fail', at: 2 },
    ];
    const got = await recoverWorkerTranscriptBeforePut({
      get: async () => ({ action: 'ok', snapshot: worker }),
      session: local,
    });
    expect(got.skipCloud).toBe(false);
    expect(got.session.messages.map((m) => m.text)).toEqual([
      'run the suite',
      'wrap-up: 3 tests still fail',
      'Turn ended · turn wall clock exceeded',
      'fix the remaining 3',
    ]);
  });

  it('GET ok recover does not suffix a local partial assistant onto the worker wrap-up', async () => {
    const local = createEmptySession('sess_1');
    local.updatedAt = 0;
    local.messages = [
      { id: 'u1', role: 'user', text: 'run the suite', at: 1 },
      { id: 'acc', role: 'assistant', text: 'wrap-up: 3 tests sti', at: 8 },
      { id: 'e1', role: 'error', text: 'Turn ended · turn wall clock exceeded', at: 9 },
    ];
    const worker = createEmptySession('sess_1');
    worker.updatedAt = 8_000;
    worker.messages = [
      { id: 'h1', role: 'user', text: 'run the suite', at: 1 },
      { id: 'h2', role: 'assistant', text: 'wrap-up: 3 tests still fail', at: 2 },
    ];
    const got = await recoverWorkerTranscriptBeforePut({
      get: async () => ({ action: 'ok', snapshot: worker }),
      session: local,
    });
    expect(got.skipCloud).toBe(false);
    expect(got.session.messages.map((m) => m.text)).toEqual([
      'run the suite',
      'wrap-up: 3 tests still fail',
      'Turn ended · turn wall clock exceeded',
    ]);
  });

  it('GET ok recover keeps a GET-miss follow-up assistant after the extra user', async () => {
    const local = createEmptySession('sess_1');
    local.updatedAt = 0;
    local.messages = [
      { id: 'u1', role: 'user', text: 'run the suite', at: 1 },
      { id: 'acc', role: 'assistant', text: 'wrap-up: 3 tests sti', at: 8 },
      { id: 'e1', role: 'error', text: 'Turn ended · turn wall clock exceeded', at: 9 },
      { id: 'u2', role: 'user', text: 'fix the remaining 3', at: 10 },
      { id: 'a2', role: 'assistant', text: 'patched the three failures', at: 11 },
    ];
    const worker = createEmptySession('sess_1');
    worker.updatedAt = 8_000;
    worker.messages = [
      { id: 'h1', role: 'user', text: 'run the suite', at: 1 },
      { id: 'h2', role: 'assistant', text: 'wrap-up: 3 tests still fail', at: 2 },
    ];
    const got = await recoverWorkerTranscriptBeforePut({
      get: async () => ({ action: 'ok', snapshot: worker }),
      session: local,
    });
    expect(got.skipCloud).toBe(false);
    expect(got.session.messages.map((m) => m.text)).toEqual([
      'run the suite',
      'wrap-up: 3 tests still fail',
      'Turn ended · turn wall clock exceeded',
      'fix the remaining 3',
      'patched the three failures',
    ]);
  });

  it('GET miss recover keeps skipCloud so a thin snapshot is not PUT', async () => {
    const local = createEmptySession('sess_1');
    local.updatedAt = 0;
    const got = await recoverWorkerTranscriptBeforePut({
      get: async () => ({ action: 'error', status: 500, message: 'boom' }),
      session: local,
    });
    expect(got.skipCloud).toBe(true);
    expect(got.session.updatedAt).toBe(0);
  });
});

describe('held-session PUT fence (adversarial #935 pass 4)', () => {
  it('blocks only the held session id', () => {
    expect(heldSessionPutBlocked(true, 'sess_1', 'sess_1')).toBe(true);
    expect(heldSessionPutBlocked(true, 'sess_1', 'sess_2')).toBe(false);
    expect(heldSessionPutBlocked(false, 'sess_1', 'sess_1')).toBe(false);
    expect(heldSessionPutBlocked(true, null, 'sess_1')).toBe(false);
  });

  it('keepFrozenClock forces 0 when blocked and leaves a live clock otherwise', () => {
    const next = createEmptySession('sess_1');
    next.updatedAt = 12_345;
    next.selectedModel = 'xai/grok-4';
    expect(keepFrozenClock(true, next).updatedAt).toBe(0);
    expect(keepFrozenClock(true, next).selectedModel).toBe('xai/grok-4');
    expect(keepFrozenClock(false, next).updatedAt).toBe(12_345);
  });

  it('model-pick while hold does not repo.put and keeps freeze-0 so F5 still adopts worker', () => {
    const thin = createEmptySession('sess_1');
    thin.updatedAt = 0;
    thin.messages = [{ id: 'u1', role: 'user', text: 'run the suite', at: 1 }];
    const picked = { ...thin, updatedAt: Date.now(), selectedModel: 'xai/grok-4' };
    const blocked = heldSessionPutBlocked(true, 'sess_1', picked.id);
    const persisted = keepFrozenClock(blocked, picked);
    const puts: SessionSnapshot[] = [];
    putUnlessHeld(blocked, (_id, s) => puts.push(s), picked.id, picked);
    expect(blocked).toBe(true);
    expect(persisted.updatedAt).toBe(0);
    expect(persisted.selectedModel).toBe('xai/grok-4');
    expect(puts).toEqual([]);

    const worker = createEmptySession('sess_1');
    worker.updatedAt = 8_000;
    worker.messages = [
      { id: 'h1', role: 'user', text: 'run the suite', at: 1 },
      { id: 'h2', role: 'assistant', text: 'wrap-up: 3 tests still fail', at: 2 },
    ];
    expect(shouldAdoptServer(persisted, worker)).toBe(true);
    expect(shouldAdoptServer(picked, worker)).toBe(false);
  });

  it('wrapRepoPut no-ops put while blocked and passes through otherwise', () => {
    const puts: string[] = [];
    const repo = {
      put: (id: string, _snapshot: SessionSnapshot) => {
        puts.push(id);
      },
    };
    wrapRepoPut(true, repo)?.put('sess_1', createEmptySession('sess_1'));
    expect(puts).toEqual([]);
    wrapRepoPut(false, repo)?.put('sess_1', createEmptySession('sess_1'));
    expect(puts).toEqual(['sess_1']);
  });
});

describe('HarnessHost adopt glue (plan #934 adversarial)', () => {
  it('skips cloud PUT after error adopt; never stamps Date.now() on the GET-ok path', () => {
    const src = readFileSync('app/harness/HarnessHost.tsx', 'utf8');
    const start = src.indexOf('Plan #934 / source #933');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('const persisted = persistTurn', start);
    expect(end).toBeGreaterThan(start);
    const glue = src.slice(start, end);
    expect(glue).toContain('adoptWorkerTranscriptOnError');
    expect(glue).toContain('skipCloud = adopted.skipCloud');
    expect(glue).toContain('shouldHoldCloudPut');
    expect(glue).toContain('holdSessionIdRef');
    expect(glue).not.toContain('Date.now()');
    expect(src).toContain('cloud: skipCloud ? false : undefined');
    expect(src).toContain('holdCloudPutRef');
    expect(src).toContain('holdSessionIdRef');
    expect(src).toContain('recoverWorkerTranscriptBeforePut');
    expect(src).toContain('heldSessionPutBlocked');
    expect(src).toContain('keepFrozenClock');
    expect(src).toContain('persistMetaHeld');
    expect(src).toContain('repoHeld(');
    expect(src).toContain('wrapRepoPut');
  });
});
