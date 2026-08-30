import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_MODELS_CACHE_TTL_MS,
  GATEWAY_MODELS_FETCH_TIMEOUT_MS,
  REASONING_EFFORT_VALUES_MAX,
} from '../sessionCloudCaps';
import {
  GATEWAY_MODELS_URL,
  getGatewayEffortMap,
  parseGatewayEffortMap,
  resetGatewayModelsCache,
  type FetchImpl,
} from './modelCatalog';

afterEach(() => {
  resetGatewayModelsCache();
});

describe('parseGatewayEffortMap', () => {
  it('keeps effort values and ignores toggle / budget_tokens', () => {
    const map = parseGatewayEffortMap({
      data: [
        {
          id: 'openai/gpt-5.6',
          reasoning_options: [
            {
              type: 'effort',
              values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
            },
            { type: 'toggle' },
          ],
        },
        { id: 'zai/glm-5.3-flash', reasoning_options: null },
        {
          id: 'other/budget',
          reasoning_options: [{ type: 'budget_tokens', min: 1, max: 9 }],
        },
      ],
    });
    expect(map.get('openai/gpt-5.6')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(map.get('zai/glm-5.3-flash')).toEqual([]);
    expect(map.get('other/budget')).toEqual([]);
  });

  it('drops junk tokens and caps at REASONING_EFFORT_VALUES_MAX', () => {
    const values = Array.from({ length: REASONING_EFFORT_VALUES_MAX + 5 }, (_, i) => `v${i}`);
    values.unshift('BAD TOKEN', '');
    const map = parseGatewayEffortMap({
      data: [{ id: 'm', reasoning_options: [{ type: 'effort', values }] }],
    });
    const got = map.get('m') ?? [];
    expect(got).toHaveLength(REASONING_EFFORT_VALUES_MAX);
    expect(got[0]).toBe('v0');
    expect(got.includes('BAD TOKEN' as never)).toBe(false);
  });

  it('returns empty map on garbage payload', () => {
    expect(parseGatewayEffortMap(null).size).toBe(0);
    expect(parseGatewayEffortMap({}).size).toBe(0);
    expect(parseGatewayEffortMap({ data: 'nope' }).size).toBe(0);
  });
});

describe('getGatewayEffortMap', () => {
  it('fetches, caches, and fail-opens on throw', async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'openai/gpt-5.6',
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          },
        ],
      }),
    }));
    const first = await getGatewayEffortMap({ fetchImpl, now: () => 1_000 });
    expect(first.get('openai/gpt-5.6')).toEqual(['low', 'high']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      GATEWAY_MODELS_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const second = await getGatewayEffortMap({
      fetchImpl,
      now: () => 1_000 + GATEWAY_MODELS_CACHE_TTL_MS - 1,
    });
    expect(second.get('openai/gpt-5.6')).toEqual(['low', 'high']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const boom: FetchImpl = vi.fn(async () => {
      throw new Error('timeout');
    });
    const stale = await getGatewayEffortMap({
      fetchImpl: boom,
      now: () => 1_000 + GATEWAY_MODELS_CACHE_TTL_MS + 1,
    });
    expect(stale.get('openai/gpt-5.6')).toEqual(['low', 'high']);
  });

  it('empty map when first fetch throws', async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const map = await getGatewayEffortMap({ fetchImpl, now: () => 0 });
    expect(map.size).toBe(0);
  });

  it('HTTP !ok fail-opens to empty map', async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ data: [{ id: 'should-not', reasoning_options: [] }] }),
    }));
    const map = await getGatewayEffortMap({ fetchImpl, now: () => 0 });
    expect(map.size).toBe(0);
  });
});

describe('gateway fetch timeout cap', () => {
  it('is the locked NEW cap', () => {
    expect(GATEWAY_MODELS_FETCH_TIMEOUT_MS).toBe(5_000);
  });
});
