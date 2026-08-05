import { describe, expect, it } from 'vitest';
import { mcpToolKey, sanitizeMcpToolName } from './toolNames';

describe('sanitizeMcpToolName', () => {
  it('keeps simple names', () => {
    expect(sanitizeMcpToolName('web_search')).toBe('web_search');
    expect(sanitizeMcpToolName('Get-Weather')).toBe('Get-Weather');
  });

  it('replaces spaces and punctuation', () => {
    expect(sanitizeMcpToolName('web search')).toBe('web_search');
    expect(sanitizeMcpToolName('foo/bar')).toBe('foo_bar');
    expect(sanitizeMcpToolName('  a..b  ')).toBe('a_b');
  });

  it('returns null for empty after sanitize', () => {
    expect(sanitizeMcpToolName('')).toBeNull();
    expect(sanitizeMcpToolName('!!!')).toBeNull();
    expect(sanitizeMcpToolName('   ')).toBeNull();
  });

  it('truncates to 64', () => {
    const long = 'a'.repeat(80);
    expect(sanitizeMcpToolName(long)?.length).toBe(64);
  });
});

describe('mcpToolKey', () => {
  it('prefixes slug', () => {
    expect(mcpToolKey('exa', 'web_search')).toBe('mcp_exa__web_search');
  });

  it('null when sanitize empty or slug empty', () => {
    expect(mcpToolKey('exa', '!!!')).toBeNull();
    expect(mcpToolKey('', 'web')).toBeNull();
  });
});
