import { describe, expect, it, vi, afterEach } from 'vitest';
import { logTurnModel, logTurnPersist } from './turnLog';

describe('turnLog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logTurnModel writes one JSON line with tag', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logTurnModel({
      ok: true,
      finishReason: 'length',
      toolCallCount: 0,
      textChars: 12,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const row = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(row.tag).toBe('invincible.turn.model');
    expect(row.ok).toBe(true);
    expect(row.finishReason).toBe('length');
    expect(row.toolCallCount).toBe(0);
    expect(row.textChars).toBe(12);
    expect(row.reasoningChars).toBeUndefined();
    expect(row.completion).toBeUndefined();
  });

  it('logTurnModel includes reasoningChars and completion when passed', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logTurnModel({
      ok: true,
      finishReason: 'error',
      toolCallCount: 0,
      textChars: 0,
      reasoningChars: 2400,
      completion: 1800,
    });
    const row = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(row.reasoningChars).toBe(2400);
    expect(row.completion).toBe(1800);
    expect(row.textChars).toBe(0);
  });

  it('logTurnPersist writes one JSON line with tag', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logTurnPersist({
      ok: true,
      terminal: true,
      status: 'completed',
      turnRunId: 'wrun_x',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const row = JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(row.tag).toBe('invincible.turn.persist');
    expect(row.terminal).toBe(true);
    expect(row.status).toBe('completed');
    expect(row.turnRunId).toBe('wrun_x');
  });
});
