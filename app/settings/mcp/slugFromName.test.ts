import { describe, expect, it } from 'vitest';
import { slugFromName } from './slugFromName';

describe('slugFromName', () => {
  it('lowercases and replaces non-slug chars', () => {
    expect(slugFromName('Exa Search')).toBe('exa_search');
  });

  it('prefixes non-letter start', () => {
    expect(slugFromName('9tools')).toMatch(/^s/);
  });

  it('truncates to 32', () => {
    expect(slugFromName('a'.repeat(50)).length).toBeLessThanOrEqual(32);
  });

  it('empty becomes s', () => {
    expect(slugFromName('   ')).toBe('s');
  });
});
