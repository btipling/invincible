import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractResolvedProvider,
  formatResolvedProviderLabel,
} from './resolvedProvider';
import {
  RESOLVED_PROVIDER_MAX_BYTES,
  sanitizeResolvedProvider,
} from '../sessionCloudCaps';
import { BYOK_PROVIDER_DEFS } from '../gateway/byokProviders';

describe('extractResolvedProvider', () => {
  it('reads gateway.routing.resolvedProvider then finalProvider (documented Gateway object)', () => {
    expect(
      extractResolvedProvider({
        gateway: {
          routing: {
            originalModelId: 'moonshotai/kimi-k3',
            resolvedProvider: 'fireworks',
            resolvedProviderApiModelId: 'Kimi-K2.5',
            finalProvider: 'togetherai',
          },
          cost: '0.004',
          generationId: 'gen_01A2B3C4D5E6F7G8H9J0K1L2M',
        },
      }),
    ).toBe('fireworks');
    expect(
      extractResolvedProvider({
        gateway: {
          routing: { finalProvider: 'togetherai' },
          generationId: 'gen_x',
        },
      }),
    ).toBe('togetherai');
  });

  it('same catalog id, togetherai vs fireworks routing → different slugs', () => {
    const modelId = 'moonshotai/kimi-k3';
    const together = extractResolvedProvider({
      gateway: {
        routing: {
          originalModelId: modelId,
          resolvedProvider: 'togetherai',
          finalProvider: 'togetherai',
        },
      },
    });
    const fireworks = extractResolvedProvider({
      gateway: {
        routing: {
          originalModelId: modelId,
          resolvedProvider: 'fireworks',
          finalProvider: 'fireworks',
        },
      },
    });
    expect(together).toBe('togetherai');
    expect(fireworks).toBe('fireworks');
    expect(together).not.toBe(fireworks);
  });

  it('routing.resolvedProvider wins over gateway.providerName / provider', () => {
    expect(
      extractResolvedProvider({
        gateway: {
          providerName: 'Together AI',
          provider: 'togetherai',
          routing: { resolvedProvider: 'fireworks', finalProvider: 'fireworks' },
        },
      }),
    ).toBe('fireworks');
  });

  it('prefers gateway.providerName then gateway.provider when routing is absent', () => {
    expect(
      extractResolvedProvider({
        gateway: { providerName: 'Together AI', provider: 'fireworks' },
      }),
    ).toBe('togetherai');
    expect(extractResolvedProvider({ gateway: { provider: 'Fireworks' } })).toBe(
      'fireworks',
    );
  });

  it('falls back to the first providerName/provider under any top-level key', () => {
    expect(
      extractResolvedProvider({
        togetherai: { providerName: 'togetherai' },
      }),
    ).toBe('togetherai');
    expect(
      extractResolvedProvider({
        other: { provider: 'Fireworks' },
      }),
    ).toBe('fireworks');
  });

  it('ignores junk, URLs, catalog model ids, and model-id routing fields', () => {
    expect(extractResolvedProvider(undefined)).toBeUndefined();
    expect(extractResolvedProvider(null)).toBeUndefined();
    expect(extractResolvedProvider('togetherai')).toBeUndefined();
    expect(
      extractResolvedProvider({ gateway: { provider: 'https://x' } }),
    ).toBeUndefined();
    expect(
      extractResolvedProvider({ gateway: { providerName: 'moonshotai/kimi-k3' } }),
    ).toBeUndefined();
    expect(
      extractResolvedProvider({ gateway: { provider: { nested: true } } }),
    ).toBeUndefined();
    expect(
      extractResolvedProvider({
        gateway: {
          routing: { resolvedProviderApiModelId: 'moonshotai/kimi-k3' },
          generationId: 'gen_x',
        },
      }),
    ).toBeUndefined();
  });
});

describe('formatResolvedProviderLabel', () => {
  it('maps known slugs and passes unknown slugs through', () => {
    expect(formatResolvedProviderLabel('togetherai')).toBe('Together AI');
    expect(formatResolvedProviderLabel('fireworks')).toBe('Fireworks');
    expect(formatResolvedProviderLabel('vertex')).toBe('Google Vertex AI');
    expect(formatResolvedProviderLabel('not-a-registry-slug')).toBe(
      'not-a-registry-slug',
    );
  });

  it('does not import byokProviders (server-only credential shapes)', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'lib/agent/resolvedProvider.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"][^'"]*byokProviders['"]/);
    expect(src).not.toMatch(/from ['"]\.\.\/gateway\//);
    expect(src).not.toMatch(/require\(['"][^'"]*byokProviders['"]\)/);
  });

  it('same catalog id, togetherai vs fireworks → different labels', () => {
    const modelId = 'moonshotai/kimi-k3';
    expect(formatResolvedProviderLabel('togetherai')).not.toBe(
      formatResolvedProviderLabel('fireworks'),
    );
    expect(modelId).toBe('moonshotai/kimi-k3');
  });

  it('every BYOK_PROVIDER_DEFS id maps to its registry label and fits the paint cap', () => {
    const encoder = new TextEncoder();
    for (const def of BYOK_PROVIDER_DEFS) {
      expect(formatResolvedProviderLabel(def.id)).toBe(def.label);
      expect(encoder.encode(def.label).length).toBeLessThanOrEqual(
        RESOLVED_PROVIDER_MAX_BYTES,
      );
    }
  });
});

describe('sanitizeResolvedProvider contract used by extract', () => {
  it('canonicalizes "Together AI" and rejects URL / model-id shapes', () => {
    expect(sanitizeResolvedProvider('Together AI')).toBe('togetherai');
    expect(sanitizeResolvedProvider('fireworks')).toBe('fireworks');
    expect(sanitizeResolvedProvider('https://x')).toBeUndefined();
    expect(sanitizeResolvedProvider('moonshotai/kimi-k3')).toBeUndefined();
  });
});
