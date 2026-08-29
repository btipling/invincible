import { describe, expect, it } from 'vitest';
import { isTruncatedFinish } from './modelFinish';

describe('isTruncatedFinish', () => {
  it('length / content-filter / error are truncated', () => {
    expect(isTruncatedFinish('length')).toBe(true);
    expect(isTruncatedFinish('content-filter')).toBe(true);
    expect(isTruncatedFinish('error')).toBe(true);
  });

  it('stop / omitted / tool-calls are not', () => {
    expect(isTruncatedFinish('stop')).toBe(false);
    expect(isTruncatedFinish(undefined)).toBe(false);
    expect(isTruncatedFinish('tool-calls')).toBe(false);
  });
});
