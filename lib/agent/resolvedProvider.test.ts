import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractResolvedProvider,
  formatResolvedProviderLabel,
} from './resolvedProvider';
import { sanitizeResolvedProvider } from '../sessionCloudCaps';

describe('extractResolvedProvider', () => {
  it('prefers gateway.providerName then gateway.provider', () => {
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

  it('ignores junk, URLs, and catalog model ids', () => {
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
});

describe('sanitizeResolvedProvider contract used by extract', () => {
  it('canonicalizes "Together AI" and rejects URL / model-id shapes', () => {
    expect(sanitizeResolvedProvider('Together AI')).toBe('togetherai');
    expect(sanitizeResolvedProvider('fireworks')).toBe('fireworks');
    expect(sanitizeResolvedProvider('https://x')).toBeUndefined();
    expect(sanitizeResolvedProvider('moonshotai/kimi-k3')).toBeUndefined();
  });
});
