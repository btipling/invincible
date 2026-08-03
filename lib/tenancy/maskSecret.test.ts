import { describe, expect, it } from 'vitest';
import { maskSecret } from './maskSecret';

describe('maskSecret', () => {
  it('returns ******** for short secrets', () => {
    expect(maskSecret('')).toBe('********');
    expect(maskSecret('ab')).toBe('********');
    expect(maskSecret('abc')).toBe('********');
  });

  it('shows last 4 for longer secrets', () => {
    expect(maskSecret('tok_live_abcdef')).toBe('••••••••cdef');
    expect(maskSecret('1234')).toBe('••••••••1234');
  });
});
