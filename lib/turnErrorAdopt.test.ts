import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  adoptWorkerTranscriptOnError,
  shouldAdoptWorkerTranscriptOnError,
  withHostOnlySuffix,
} from './turnErrorAdopt';
import { createEmptySession } from './sessionStore';
import type { CloudGetResult } from './sessionRepository';

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
    expect(glue).not.toContain('Date.now()');
    expect(src).toContain('cloud: skipCloud ? false : undefined');
  });
});
