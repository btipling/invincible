import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_WINDOW_DEFAULT_TOKENS } from '../sessionCloudCaps';
import {
  GATEWAY_MODELS_URL,
  MODELS_DEV_URL,
  joinWindowMaps,
  parseGatewayWindowMap,
  parseModelsDevWindowMap,
  resetGatewayModelsCache,
  type FetchImpl,
} from './modelCatalog';

afterEach(() => {
  resetGatewayModelsCache();
});

describe('gateway window map (plan #944)', () => {
  it('parses Gateway `context_length`; rows without one are absent', () => {
    const map = parseGatewayWindowMap({
      data: [
        { id: 'openai/gpt-5.6', context_length: 400_000 },
        { id: 'anthropic/claude-a', context_length: '200000' },
        { id: 'zai/glm-5.3-flash' },
        { id: 'bad/zero', context_length: 0 },
        { id: 'bad/neg', context_length: -1 },
        { id: 'bad/frac', context_length: 1.5 },
      ],
    });
    expect(map.get('openai/gpt-5.6')).toBe(400_000);
    expect(map.get('anthropic/claude-a')).toBe(200_000);
    expect(map.has('zai/glm-5.3-flash')).toBe(false);
    expect(map.has('bad/zero')).toBe(false);
    expect(map.has('bad/neg')).toBe(false);
    expect(map.has('bad/frac')).toBe(false);
  });

  it('parses models.dev `limit.context`; garbage payload → empty map', () => {
    const map = parseModelsDevWindowMap({
      vercel: {
        models: {
          'zai/glm-5.3-flash': { limit: { context: 128_000 } },
          'no/window': { reasoning_options: [] },
          'no/limit': {},
        },
      },
    });
    expect(map.get('zai/glm-5.3-flash')).toBe(128_000);
    expect(map.has('no/window')).toBe(false);
    expect(map.has('no/limit')).toBe(false);
    expect(parseModelsDevWindowMap(null).size).toBe(0);
    expect(parseModelsDevWindowMap({}).size).toBe(0);
    expect(parseModelsDevWindowMap({ vercel: { models: [] } }).size).toBe(0);
  });

  it('joinWindowMaps: Gateway wins disagreements; overlay fills holes', () => {
    const joined = joinWindowMaps(
      new Map([
        ['overlay-fill', 128_000],
        ['disagreement', 999_999],
      ]),
      new Map([['disagreement', 400_000]]),
    );
    expect(joined.get('overlay-fill')).toBe(128_000);
    expect(joined.get('disagreement')).toBe(400_000);
  });

  it('getJoinedWindowMap fetches both sources with one GET each; fail-open to empty', async () => {
    const fetchImpl: FetchImpl = vi.fn(async (input) => {
      if (input === MODELS_DEV_URL) {
        return {
          ok: true,
          json: async () => ({
            vercel: {
              models: { 'zai/glm-5.3-flash': { limit: { context: 128_000 } } },
            },
          }),
        };
      }
      if (input === GATEWAY_MODELS_URL) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'openai/gpt-5.6', context_length: 400_000 }],
          }),
        };
      }
      throw new Error(`unexpected ${input}`);
    });
    const { getJoinedWindowMap } = await import('./modelCatalog');
    const map = await getJoinedWindowMap({ fetchImpl, now: () => 0 });
    expect(map.get('openai/gpt-5.6')).toBe(400_000);
    expect(map.get('zai/glm-5.3-flash')).toBe(128_000);
  });

  it('failed fetches fail-open to the empty map (conservative default is the caller’s)', async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const { getJoinedWindowMap } = await import('./modelCatalog');
    const map = await getJoinedWindowMap({ fetchImpl, now: () => 0 });
    expect(map.size).toBe(0);
  });

  it('adversarial #945 — effort + window share one GET per source', async () => {
    const fetchImpl: FetchImpl = vi.fn(async (input) => {
      if (input === MODELS_DEV_URL) {
        return {
          ok: true,
          json: async () => ({
            vercel: {
              models: {
                'zai/glm-5.3-flash': {
                  limit: { context: 128_000 },
                  reasoning_options: [{ type: 'effort', values: ['low'] }],
                },
              },
            },
          }),
        };
      }
      if (input === GATEWAY_MODELS_URL) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'openai/gpt-5.6', context_length: 400_000 }],
          }),
        };
      }
      throw new Error(`unexpected ${input}`);
    });
    const { getJoinedWindowMap, getJoinedEffortMap } = await import('./modelCatalog');
    await getJoinedEffortMap({ fetchImpl, now: () => 0 });
    await getJoinedWindowMap({ fetchImpl, now: () => 0 });
    const urls = vi.mocked(fetchImpl).mock.calls.map((c) => c[0]);
    expect(urls.filter((u) => u === GATEWAY_MODELS_URL)).toHaveLength(1);
    expect(urls.filter((u) => u === MODELS_DEV_URL)).toHaveLength(1);
  });

  it('the conservative default stays locked', () => {
    expect(CONTEXT_WINDOW_DEFAULT_TOKENS).toBe(200_000);
  });
});
