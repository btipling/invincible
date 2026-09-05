import { describe, expect, it } from 'vitest';
import { CONTEXT_WINDOW_DEFAULT_TOKENS } from '../sessionCloudCaps';
import { contextWindowForModel } from './contextWindow';

describe('contextWindowForModel (plan #944, rows 1–2)', () => {
  it('row 1 — returns the published catalog window for a known id', () => {
    const map = new Map<string, number>([
      ['anthropic/claude-a', 200_000],
      ['openai/gpt-5.6', 400_000],
    ]);
    expect(contextWindowForModel(map, 'anthropic/claude-a')).toBe(200_000);
    expect(contextWindowForModel(map, 'openai/gpt-5.6')).toBe(400_000);
  });

  it('row 2 — unknown id / failed fetch (empty map) → conservative default, never a fabricated number', () => {
    expect(contextWindowForModel(new Map(), 'missing/id')).toBe(
      CONTEXT_WINDOW_DEFAULT_TOKENS,
    );
    expect(contextWindowForModel(undefined, 'x/y')).toBe(
      CONTEXT_WINDOW_DEFAULT_TOKENS,
    );
    expect(CONTEXT_WINDOW_DEFAULT_TOKENS).toBe(200_000);
  });

  it('row 2 — poison values in the map fail closed to the default', () => {
    const map = new Map<string, number>([
      ['bad/zero', 0],
      ['bad/negative', -5],
      ['bad/frac', 1.5],
    ]);
    expect(contextWindowForModel(map, 'bad/zero')).toBe(
      CONTEXT_WINDOW_DEFAULT_TOKENS,
    );
    expect(contextWindowForModel(map, 'bad/negative')).toBe(
      CONTEXT_WINDOW_DEFAULT_TOKENS,
    );
    expect(contextWindowForModel(map, 'bad/frac')).toBe(
      CONTEXT_WINDOW_DEFAULT_TOKENS,
    );
  });
});
