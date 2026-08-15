import { describe, expect, it } from 'vitest';
import {
  USAGE_SUMMARY_MAX_BYTES,
  USAGE_TOKEN_MAX,
  formatTokenCount,
  formatUsageSummary,
  mapProviderUsage,
  sanitizeUsageSummary,
  usageSummaryByteLength,
  type UsageSummary,
} from './usageSummary';

describe('mapProviderUsage (plan #539 / #327)', () => {
  it('maps AI SDK v7 LanguageModelUsage shape', () => {
    const s = mapProviderUsage({
      inputTokens: 1200,
      outputTokens: 820,
      totalTokens: 2020,
      inputTokenDetails: { cacheReadTokens: 400 },
    });
    expect(s).toEqual({
      source: 'provider',
      prompt: 1200,
      completion: 820,
      total: 2020,
      cached: 400,
    });
  });

  it('maps the legacy v5 shape (promptTokens/completionTokens/cachedInputTokens)', () => {
    const s = mapProviderUsage({
      promptTokens: 5,
      completionTokens: 7,
      cachedInputTokens: 2,
    });
    expect(s).toEqual({
      source: 'provider',
      prompt: 5,
      completion: 7,
      cached: 2,
    });
  });

  it('returns undefined when the provider reported no usable counts', () => {
    expect(mapProviderUsage(undefined)).toBeUndefined();
    expect(mapProviderUsage(null)).toBeUndefined();
    expect(mapProviderUsage('nope')).toBeUndefined();
    expect(mapProviderUsage({})).toBeUndefined();
    expect(mapProviderUsage({ inputTokenDetails: { cacheReadTokens: 3 } })).toBeUndefined();
  });

  it('clamps hostile / pathological values to USAGE_TOKEN_MAX', () => {
    const s = mapProviderUsage({
      inputTokens: 1e15,
      outputTokens: -5,
      totalTokens: Number.NaN,
    });
    expect(s).toBeDefined();
    expect(s!.prompt).toBe(USAGE_TOKEN_MAX);
    // negative output is dropped (clamped to 0), NaN total dropped
    expect(s!.completion).toBe(0);
    expect(s!.total).toBeUndefined();
  });

  it('bounded carrier: an oversize serialized summary is omitted, never breaks', () => {
    // Every field clamped to its ceiling produces a serialized form over the cap —
    // prove the omit path holds (over-cap → undefined, never a truncation lie).
    const s = mapProviderUsage({
      inputTokens: 1e14,
      outputTokens: 1e14,
      totalTokens: 1e14,
      inputTokenDetails: { cacheReadTokens: 1e14 },
    });
    expect(s).toBeUndefined();
  });

  it('keeps a realistic summary under USAGE_SUMMARY_MAX_BYTES', () => {
    const s = mapProviderUsage({
      inputTokens: 1200,
      outputTokens: 820,
      totalTokens: 2020,
    })!;
    expect(usageSummaryByteLength(s)).toBeLessThanOrEqual(USAGE_SUMMARY_MAX_BYTES);
    // A realistic summary is comfortably under the 96-byte carrier cap.
    expect(usageSummaryByteLength(s)).toBeLessThan(USAGE_SUMMARY_MAX_BYTES - 20);
  });
});

describe('sanitizeUsageSummary (read-side, fail-closed)', () => {
  it('passes a valid provider summary through', () => {
    const valid: UsageSummary = {
      source: 'provider',
      prompt: 100,
      completion: 50,
      total: 150,
    };
    expect(sanitizeUsageSummary(valid)).toEqual(valid);
  });

  it('rejects a non-provider / absent source (never presented as API truth)', () => {
    expect(sanitizeUsageSummary({ source: 'estimated', prompt: 10, completion: 5 })).toBeUndefined();
    expect(sanitizeUsageSummary({ prompt: 10, completion: 5 })).toBeUndefined();
    expect(sanitizeUsageSummary('provider')).toBeUndefined();
    expect(sanitizeUsageSummary(undefined)).toBeUndefined();
  });

  it('clamps poison: negative / non-finite / non-number counts', () => {
    const s = sanitizeUsageSummary({
      source: 'provider',
      prompt: '900', // string — dropped
      completion: -4, // clamped to 0
      total: Number.NaN, // dropped
    });
    // completion present (clamped) → summary survives with a clean 0
    expect(s).toBeDefined();
    expect(s!.prompt).toBeUndefined();
    expect(s!.completion).toBe(0);
  });

  it('omits an over-cap summary rather than shipping a giant carrier', () => {
    const big: UsageSummary = {
      source: 'provider',
      prompt: USAGE_TOKEN_MAX,
      completion: USAGE_TOKEN_MAX,
      total: USAGE_TOKEN_MAX,
      cached: USAGE_TOKEN_MAX,
    };
    expect(usageSummaryByteLength(big)).toBeGreaterThan(USAGE_SUMMARY_MAX_BYTES);
    expect(sanitizeUsageSummary(big)).toBeUndefined();
  });
});

describe('formatTokenCount / formatUsageSummary (host slot display)', () => {
  it('abbreviates absolute tokens (never a % of window)', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1200)).toBe('1.2k');
    expect(formatTokenCount(250000)).toBe('250k');
    expect(formatTokenCount(2500000)).toBe('2.5M');
  });

  it('renders prompt/completion/total/cached when present', () => {
    const s: UsageSummary = {
      source: 'provider',
      prompt: 1200,
      completion: 800,
      total: 2000,
      cached: 300,
    };
    expect(formatUsageSummary(s)).toBe('1.2k in · 800 out · 2k tok · 300 cached');
  });

  it('hides on absent usage or a non-provider source', () => {
    expect(formatUsageSummary(undefined)).toBeUndefined();
    expect(
      formatUsageSummary({ source: 'estimated', prompt: 5 } as never),
    ).toBeUndefined();
  });

  it('shows only what it has (never invents a total)', () => {
    expect(formatUsageSummary({ source: 'provider', prompt: 42 })).toBe('42 in');
  });
});
