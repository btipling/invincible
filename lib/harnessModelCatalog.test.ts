import { describe, expect, it } from 'vitest';
import {
  contextWindowFor,
  parseModelCatalogEntries,
} from './harnessModelCatalog';

describe('parseModelCatalogEntries (plan #944, testing row 13)', () => {
  it('parses ids, effort lists, and published windows in one pass', () => {
    const parsed = parseModelCatalogEntries([
      {
        id: 'zai/glm-5.3-flash',
        reasoningOptions: ['low', 'high', 'xhigh'],
        contextWindow: 128_000,
      },
      { id: 'openai/gpt-5.6', reasoningOptions: [], contextWindow: 400_000 },
    ]);
    expect(parsed?.models).toEqual(['zai/glm-5.3-flash', 'openai/gpt-5.6']);
    expect(parsed?.reasoningById['zai/glm-5.3-flash']).toEqual([
      'low',
      'high',
      'xhigh',
    ]);
    expect(parsed?.windowById['zai/glm-5.3-flash']).toBe(128_000);
    expect(parsed?.windowById['openai/gpt-5.6']).toBe(400_000);
  });

  it('a missing/invalid window omits the model from windowById (fail-closed, never fabricated)', () => {
    const parsed = parseModelCatalogEntries([
      { id: 'a/b' },
      { id: 'c/d', contextWindow: 0 },
      { id: 'e/f', contextWindow: 1.5 },
      { id: 'g/h', contextWindow: -1 },
      { id: 'i/j', contextWindow: 'big' },
      { id: 'k/l', contextWindow: Number.NaN },
    ]);
    expect(parsed?.models).toEqual(['a/b', 'c/d', 'e/f', 'g/h', 'i/j', 'k/l']);
    expect(parsed?.windowById).toEqual({});
  });

  it('non-array payload → undefined (invalid catalog response)', () => {
    expect(parseModelCatalogEntries(undefined)).toBeUndefined();
    expect(parseModelCatalogEntries({ models: [] })).toBeUndefined();
    expect(parseModelCatalogEntries('nope')).toBeUndefined();
  });

  it('skips empty ids; dedupes; keeps first-seen order', () => {
    const parsed = parseModelCatalogEntries([
      { id: '  x/y  ', contextWindow: 8_000 },
      { id: '' },
      { id: 'x/y', contextWindow: 16_000 },
    ]);
    expect(parsed?.models).toEqual(['x/y']);
    expect(parsed?.windowById['x/y']).toBe(8_000); // first wins
  });

  it('contextWindowFor: unknown id / missing map → undefined (caller defaults)', () => {
    expect(contextWindowFor({ 'a/b': 1_000 }, 'a/b')).toBe(1_000);
    expect(contextWindowFor({ 'a/b': 1_000 }, 'missing')).toBeUndefined();
    expect(contextWindowFor(undefined, 'a/b')).toBeUndefined();
    expect(contextWindowFor({ 'a/b': 1_000 }, undefined)).toBeUndefined();
    // Poison stored value re-fails closed.
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      contextWindowFor({ bad: 0 } as any, 'bad'),
    ).toBeUndefined();
  });
});
