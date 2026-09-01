import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_MODELS_CACHE_TTL_MS,
  GATEWAY_MODELS_FETCH_TIMEOUT_MS,
  MODELS_DEV_FETCH_MAX_BYTES,
} from '../sessionCloudCaps';
import {
  GATEWAY_MODELS_URL,
  MODELS_DEV_URL,
  effortValuesForModel,
  getGatewayEffortMap,
  getJoinedEffortMap,
  getModelsDevEffortMap,
  joinEffortMaps,
  parseGatewayEffortMap,
  parseModelsDevEffortMap,
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
    ]);
    expect(map.get('zai/glm-5.3-flash')).toEqual([]);
    expect(map.get('other/budget')).toEqual([]);
  });

  it('drops junk tokens, duplicates, and non-wire values (max)', () => {
    const map = parseGatewayEffortMap({
      data: [
        {
          id: 'm',
          reasoning_options: [
            {
              type: 'effort',
              values: [
                'BAD TOKEN',
                '',
                'max',
                'low',
                'low',
                'high',
                'v0',
                'xhigh',
                'none',
              ],
            },
          ],
        },
      ],
    });
    expect(map.get('m')).toEqual(['low', 'high', 'xhigh', 'none']);
  });

  it('drops max (not in Gateway language-model wire enum, #911)', () => {
    const map = parseGatewayEffortMap({
      data: [
        {
          id: 'zai/glm-5.3-flash',
          reasoning_options: [
            { type: 'effort', values: ['low', 'high', 'max'] },
          ],
        },
        {
          id: 'openai/gpt-5.6-luna',
          reasoning_options: [
            {
              type: 'effort',
              values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
            },
          ],
        },
      ],
    });
    expect(map.get('zai/glm-5.3-flash')).toEqual(['low', 'high']);
    expect(map.get('openai/gpt-5.6-luna')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('returns empty map on garbage payload', () => {
    expect(parseGatewayEffortMap(null).size).toBe(0);
    expect(parseGatewayEffortMap({}).size).toBe(0);
    expect(parseGatewayEffortMap({ data: 'nope' }).size).toBe(0);
  });
});

describe('parseModelsDevEffortMap', () => {
  it('reads vercel.models object keys; ignores lab maps, toggle, nested row.id', () => {
    const map = parseModelsDevEffortMap({
      vercel: {
        models: {
          'zai/glm-5.3-flash': {
            id: 'wrong/id',
            reasoning_options: [
              { type: 'effort', values: ['low', 'high', 'max'] },
              { type: 'toggle' },
            ],
          },
          'zai/glm-5.3': {
            reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
          },
          'other/toggle': {
            reasoning_options: [{ type: 'toggle' }],
          },
        },
      },
      zai: {
        models: {
          'glm-5.3-flash': {
            reasoning_options: [{ type: 'effort', values: ['should-not'] }],
          },
        },
      },
    });
    expect(map.get('zai/glm-5.3-flash')).toEqual(['low', 'high']);
    expect(map.get('zai/glm-5.3')).toEqual(['low', 'high']);
    expect(map.get('other/toggle')).toEqual([]);
    expect(map.has('glm-5.3-flash')).toBe(false);
    expect(map.has('wrong/id')).toBe(false);
  });

  it('returns empty map on garbage / missing vercel.models', () => {
    expect(parseModelsDevEffortMap(null).size).toBe(0);
    expect(parseModelsDevEffortMap({}).size).toBe(0);
    expect(parseModelsDevEffortMap({ vercel: { models: [] } }).size).toBe(0);
    expect(parseModelsDevEffortMap({ zai: { models: { x: {} } } }).size).toBe(0);
  });
});

describe('joinEffortMaps', () => {
  it('overlay fills empty/missing Gateway; nonempty Gateway wins disagreement', () => {
    const overlay = new Map<string, string[]>([
      ['overlay-fill', ['low', 'high']],
      ['empty-overlay', []],
      ['overlay-only', ['low']],
      ['disagreement', ['low', 'medium', 'high']],
    ]);
    const gateway = new Map<string, string[]>([
      ['overlay-fill', []],
      ['empty-overlay', ['low', 'medium']],
      ['gateway-only', ['none', 'low']],
      ['both-empty', []],
      ['disagreement', ['none', 'low', 'medium', 'high']],
    ]);
    const joined = joinEffortMaps(overlay, gateway);
    expect(joined.get('overlay-fill')).toEqual(['low', 'high']);
    expect(joined.get('empty-overlay')).toEqual(['low', 'medium']);
    expect(joined.get('overlay-only')).toEqual(['low']);
    expect(joined.get('gateway-only')).toEqual(['none', 'low']);
    expect(joined.get('both-empty')).toEqual([]);
    // Live shape: grok-4.3 — overlay must not drop Gateway `none`.
    expect(joined.get('disagreement')).toEqual(['none', 'low', 'medium', 'high']);
    expect(joined.get('missing')).toBeUndefined();
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
    expect(boom).toHaveBeenCalledTimes(1);

    // Negative/stale cache: a failed refresh must not be retried inside TTL.
    const staleAgain = await getGatewayEffortMap({
      fetchImpl: boom,
      now: () => 1_000 + GATEWAY_MODELS_CACHE_TTL_MS + 1,
    });
    expect(staleAgain.get('openai/gpt-5.6')).toEqual(['low', 'high']);
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it('empty map when first fetch throws', async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const map = await getGatewayEffortMap({ fetchImpl, now: () => 0 });
    expect(map.size).toBe(0);

    const again = await getGatewayEffortMap({ fetchImpl, now: () => 0 });
    expect(again.size).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('HTTP !ok fail-opens to empty map', async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ data: [{ id: 'should-not', reasoning_options: [] }] }),
    }));
    const map = await getGatewayEffortMap({ fetchImpl, now: () => 0 });
    expect(map.size).toBe(0);
    const again = await getGatewayEffortMap({ fetchImpl, now: () => 1 });
    expect(again.size).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('overlapping callers share one in-flight GET', async () => {
    type GatewayRes = {
      ok: boolean;
      json: () => Promise<unknown>;
    };
    let release: ((res: GatewayRes) => void) | undefined;
    const fetchImpl: FetchImpl = vi.fn(
      () =>
        new Promise<GatewayRes>((resolve) => {
          release = resolve;
        }),
    );
    const a = getGatewayEffortMap({ fetchImpl, now: () => 0 });
    const b = getGatewayEffortMap({ fetchImpl, now: () => 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release!({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'openai/gpt-5.6',
            reasoning_options: [{ type: 'effort', values: ['low'] }],
          },
        ],
      }),
    });
    const [ma, mb] = await Promise.all([a, b]);
    expect(ma.get('openai/gpt-5.6')).toEqual(['low']);
    expect(mb.get('openai/gpt-5.6')).toEqual(['low']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function modelsDevJson(models: Record<string, unknown>): FetchImpl {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ vercel: { models } }),
  }));
}

describe('getModelsDevEffortMap', () => {
  it('fetches, caches, fail-opens last-good, and negative-caches', async () => {
    const fetchImpl = modelsDevJson({
      'zai/glm-5.3-flash': {
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    });
    const first = await getModelsDevEffortMap({ fetchImpl, now: () => 1_000 });
    expect(first.get('zai/glm-5.3-flash')).toEqual(['low', 'high']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      MODELS_DEV_URL,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        redirect: 'error',
      }),
    );

    const second = await getModelsDevEffortMap({
      fetchImpl,
      now: () => 1_000 + GATEWAY_MODELS_CACHE_TTL_MS - 1,
    });
    expect(second.get('zai/glm-5.3-flash')).toEqual(['low', 'high']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const boom: FetchImpl = vi.fn(async () => {
      throw new Error('timeout');
    });
    const stale = await getModelsDevEffortMap({
      fetchImpl: boom,
      now: () => 1_000 + GATEWAY_MODELS_CACHE_TTL_MS + 1,
    });
    expect(stale.get('zai/glm-5.3-flash')).toEqual(['low', 'high']);
    expect(boom).toHaveBeenCalledTimes(1);

    const staleAgain = await getModelsDevEffortMap({
      fetchImpl: boom,
      now: () => 1_000 + GATEWAY_MODELS_CACHE_TTL_MS + 1,
    });
    expect(staleAgain.get('zai/glm-5.3-flash')).toEqual(['low', 'high']);
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it('empty map when first fetch throws; negative-cached', async () => {
    const fetchImpl: FetchImpl = vi.fn(async () => {
      throw new Error('down');
    });
    const map = await getModelsDevEffortMap({ fetchImpl, now: () => 0 });
    expect(map.size).toBe(0);
    const again = await getModelsDevEffortMap({ fetchImpl, now: () => 0 });
    expect(again.size).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('overlapping callers share one in-flight GET', async () => {
    type OverlayRes = {
      ok: boolean;
      json: () => Promise<unknown>;
    };
    let release: ((res: OverlayRes) => void) | undefined;
    const fetchImpl: FetchImpl = vi.fn(
      () =>
        new Promise<OverlayRes>((resolve) => {
          release = resolve;
        }),
    );
    const a = getModelsDevEffortMap({ fetchImpl, now: () => 0 });
    const b = getModelsDevEffortMap({ fetchImpl, now: () => 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release!({
      ok: true,
      json: async () => ({
        vercel: {
          models: {
            'zai/glm-5.3-flash': {
              reasoning_options: [{ type: 'effort', values: ['low'] }],
            },
          },
        },
      }),
    });
    const [ma, mb] = await Promise.all([a, b]);
    expect(ma.get('zai/glm-5.3-flash')).toEqual(['low']);
    expect(mb.get('zai/glm-5.3-flash')).toEqual(['low']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('oversize arrayBuffer fail-opens without decoding the dump', async () => {
    const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(MODELS_DEV_FETCH_MAX_BYTES + 1));
    const json = vi.fn(async () => {
      throw new Error('json must not run when arrayBuffer is present');
    });
    const fetchImpl: FetchImpl = vi.fn(async () => ({
      ok: true,
      json,
      arrayBuffer,
    }));
    const map = await getModelsDevEffortMap({ fetchImpl, now: () => 0 });
    expect(map.size).toBe(0);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
    expect(decodeSpy).not.toHaveBeenCalled();
    decodeSpy.mockRestore();
  });

  it('arrayBuffer success path decodes then parses (production glue)', async () => {
    const payload = {
      vercel: {
        models: {
          'zai/glm-5.3-flash': {
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          },
        },
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const json = vi.fn(async () => {
      throw new Error('json must not run when arrayBuffer is present');
    });
    const fetchImpl: FetchImpl = vi.fn(async () => ({
      ok: true,
      json,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }));
    const map = await getModelsDevEffortMap({ fetchImpl, now: () => 0 });
    expect(map.get('zai/glm-5.3-flash')).toEqual(['low', 'high']);
    expect(json).not.toHaveBeenCalled();
  });

  it('streaming body success path decodes then parses', async () => {
    const payload = {
      vercel: {
        models: {
          'zai/glm-5.3-flash': {
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          },
        },
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const json = vi.fn(async () => {
      throw new Error('json must not run when body is present');
    });
    const arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer must not run when body is present');
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const fetchImpl: FetchImpl = vi.fn(async () => ({
      ok: true,
      json,
      arrayBuffer,
      body,
    }));
    const map = await getModelsDevEffortMap({ fetchImpl, now: () => 0 });
    expect(map.get('zai/glm-5.3-flash')).toEqual(['low', 'high']);
    expect(json).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('streaming body oversize aborts before assembling the dump', async () => {
    const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');
    const json = vi.fn(async () => {
      throw new Error('json must not run when body is present');
    });
    const arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer must not run when body is present');
    });
    const chunk = new Uint8Array(64 * 1024);
    const limit = MODELS_DEV_FETCH_MAX_BYTES + chunk.byteLength;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= limit) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent += chunk.byteLength;
      },
    });
    const fetchImpl: FetchImpl = vi.fn(async () => ({
      ok: true,
      json,
      arrayBuffer,
      body,
    }));
    const map = await getModelsDevEffortMap({ fetchImpl, now: () => 0 });
    expect(map.size).toBe(0);
    expect(json).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(decodeSpy).not.toHaveBeenCalled();
    expect(sent).toBeLessThanOrEqual(MODELS_DEV_FETCH_MAX_BYTES + chunk.byteLength);
    decodeSpy.mockRestore();
  });

  it('resetGatewayModelsCache drops overlay so the next read refetches', async () => {
    const fetchImpl = modelsDevJson({
      'zai/glm-5.3-flash': {
        reasoning_options: [{ type: 'effort', values: ['low'] }],
      },
    });
    await getModelsDevEffortMap({ fetchImpl, now: () => 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resetGatewayModelsCache();
    await getModelsDevEffortMap({ fetchImpl, now: () => 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('getJoinedEffortMap', () => {
  it('dispatches shared fetchImpl on URL; overlay fills empty Gateway', async () => {
    const fetchImpl: FetchImpl = vi.fn(async (input) => {
      if (input === MODELS_DEV_URL) {
        return {
          ok: true,
          json: async () => ({
            vercel: {
              models: {
                'zai/glm-5.3-flash': {
                  reasoning_options: [
                    { type: 'effort', values: ['low', 'high'] },
                  ],
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
            data: [
              { id: 'zai/glm-5.3-flash', reasoning_options: null },
              {
                id: 'openai/gpt-5.6',
                reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected ${input}`);
    });
    const map = await getJoinedEffortMap({ fetchImpl, now: () => 0 });
    expect(map.get('zai/glm-5.3-flash')).toEqual(['low', 'high']);
    expect(map.get('openai/gpt-5.6')).toEqual(['low', 'high']);
    const urls = vi.mocked(fetchImpl).mock.calls.map((c) => c[0]);
    expect(urls).toEqual(expect.arrayContaining([MODELS_DEV_URL, GATEWAY_MODELS_URL]));
    expect(urls).toHaveLength(2);
  });
});

describe('effortValuesForModel', () => {
  it('reads the joined map', async () => {
    const fetchImpl: FetchImpl = vi.fn(async (input) => {
      if (input === MODELS_DEV_URL) {
        return {
          ok: true,
          json: async () => ({
            vercel: {
              models: {
                'zai/glm-5.3-flash': {
                  reasoning_options: [
                    { type: 'effort', values: ['low', 'high'] },
                  ],
                },
              },
            },
          }),
        };
      }
      if (input === GATEWAY_MODELS_URL) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      throw new Error(`unexpected ${input}`);
    });
    await expect(
      effortValuesForModel('zai/glm-5.3-flash', { fetchImpl, now: () => 0 }),
    ).resolves.toEqual(['low', 'high']);
    await expect(
      effortValuesForModel('missing/id', { fetchImpl, now: () => 0 }),
    ).resolves.toEqual([]);
  });
});

describe('catalog source locks', () => {
  it('never calls getAvailableModels and never sends Authorization', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'lib/gateway/modelCatalog.ts'),
      'utf8',
    );
    expect(src.includes('getAvailableModels')).toBe(false);
    expect(src).not.toMatch(/Authorization/);
    expect(src).not.toMatch(/AI_GATEWAY_API_KEY/);
  });
});

describe('gateway fetch timeout cap', () => {
  it('is the locked NEW cap', () => {
    expect(GATEWAY_MODELS_FETCH_TIMEOUT_MS).toBe(5_000);
    expect(MODELS_DEV_FETCH_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});
