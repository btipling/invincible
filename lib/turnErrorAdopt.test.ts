import { describe, expect, it } from 'vitest';
import {
  adoptWorkerTranscriptOnError,
  shouldAdoptWorkerTranscriptOnError,
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

describe('adoptWorkerTranscriptOnError', () => {
  it('replaces the thin local snapshot with the worker GET', async () => {
    const local = createEmptySession('sess_1');
    local.updatedAt = 9_000;
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
    expect(got.skipCloud).toBe(false);
    expect(got.session.messages.map((m) => m.text)).toEqual([
      'run the suite',
      'wrap-up: 3 tests still fail',
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
