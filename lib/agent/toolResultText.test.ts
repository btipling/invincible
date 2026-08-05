import { describe, expect, it } from 'vitest';
import {
  flattenToolResultText,
  isLikelyMcpContentEnvelope,
  parseAndFlattenIfMcpEnvelope,
} from './toolResultText';

const exaEnvelope = {
  content: [
    {
      type: 'text',
      text: 'Title: Introducing Exa 2.0 | Exa Blog\nURL: https://exa.ai/blog/exa-api-2-0\nPublished: 2025-10-10T00:00:00.000Z\nAuthor: Exa Labs\nHighlights:\nIntroducing Exa 2.0',
    },
  ],
};

describe('flattenToolResultText', () => {
  it('extracts text from Exa-like MCP content envelope', () => {
    const out = flattenToolResultText(exaEnvelope);
    expect(out).toContain('Introducing Exa 2.0');
    expect(out).toContain('https://exa.ai/blog/exa-api-2-0');
    expect(out).not.toMatch(/^\s*\{/);
  });

  it('leaves plain strings as-is (including ERROR)', () => {
    expect(flattenToolResultText('  hello  ')).toBe('  hello  ');
    expect(flattenToolResultText('ERROR mcp_x: boom')).toBe('ERROR mcp_x: boom');
  });

  it('empty string / null / undefined → empty', () => {
    expect(flattenToolResultText('')).toBe('');
    expect(flattenToolResultText('   ')).toBe('');
    expect(flattenToolResultText(null)).toBe('');
    expect(flattenToolResultText(undefined)).toBe('');
  });

  it('unwraps string-encoded pure envelope JSON', () => {
    const raw = JSON.stringify(exaEnvelope);
    const out = flattenToolResultText(raw);
    expect(out).toContain('Introducing Exa 2.0');
    expect(out).not.toContain('"content"');
  });

  it('falls back to JSON for objects without content', () => {
    const out = flattenToolResultText({ foo: 1, bar: 'x' });
    expect(out).toBe('{"foo":1,"bar":"x"}');
  });

  it('uses text / message fields', () => {
    expect(flattenToolResultText({ text: 'hi' })).toBe('hi');
    expect(flattenToolResultText({ message: 'msg' })).toBe('msg');
  });

  it('joins array of textish', () => {
    expect(flattenToolResultText(['a', { text: 'b' }])).toBe('a\nb');
  });
});

describe('isLikelyMcpContentEnvelope / parseAndFlattenIfMcpEnvelope', () => {
  it('detects envelope objects', () => {
    expect(isLikelyMcpContentEnvelope(exaEnvelope)).toBe(true);
    expect(isLikelyMcpContentEnvelope({ content: [] })).toBe(false);
    expect(isLikelyMcpContentEnvelope({ content: [{ type: 'image' }] })).toBe(
      false,
    );
  });

  it('parses pure envelope JSON string', () => {
    const raw = JSON.stringify(exaEnvelope);
    const flat = parseAndFlattenIfMcpEnvelope(raw);
    expect(flat).toContain('Introducing Exa 2.0');
    expect(flat).not.toContain('"content"');
  });

  it('does not rewrite prose that mentions JSON', () => {
    const prose =
      'Here is what I found. The payload looked like {"content":[{"type":"text","text":"x"}]} but here is a summary.';
    expect(parseAndFlattenIfMcpEnvelope(prose)).toBeNull();
  });

  it('returns null for non-JSON', () => {
    expect(parseAndFlattenIfMcpEnvelope('hello')).toBeNull();
  });
});
