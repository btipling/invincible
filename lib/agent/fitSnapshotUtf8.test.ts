import { describe, it, expect } from 'vitest';
import { fitSnapshotUtf8 } from './fitSnapshotUtf8';

const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

function snap(messages: Array<{ id: string; role: string; text: string; at: number }>): string {
  return JSON.stringify({ id: 's1', updatedAt: 1, messages });
}

describe('fitSnapshotUtf8', () => {
  it('returns identity when already under the cap', () => {
    const json = snap([{ id: 'a', role: 'user', text: 'hi', at: 1 }]);
    expect(fitSnapshotUtf8(json, 8 * 1024 * 1024)).toBe(json);
  });

  it('drops oldest messages until under the cap and keeps the newest', () => {
    const json = snap([
      { id: 'old', role: 'user', text: 'AAAA'.repeat(40), at: 1 },
      { id: 'mid', role: 'assistant', text: 'BBBB'.repeat(40), at: 2 },
      { id: 'new', role: 'user', text: 'newest', at: 3 },
    ]);
    const cap = byteLen(
      snap([
        { id: 'mid', role: 'assistant', text: 'BBBB'.repeat(40), at: 2 },
        { id: 'new', role: 'user', text: 'newest', at: 3 },
      ]),
    );
    const out = fitSnapshotUtf8(json, cap);
    expect(byteLen(out)).toBeLessThanOrEqual(cap);
    const body = JSON.parse(out) as { messages: Array<{ id: string; text: string }> };
    expect(body.messages.map((m) => m.id)).not.toContain('old');
    expect(body.messages.at(-1)?.text).toBe('newest');
    expect(body.messages.some((m) => m.id === 'new')).toBe(true);
  });

  it('clips a lone oversize row text; never throws', () => {
    const json = snap([{ id: 'only', role: 'user', text: 'é'.repeat(200), at: 1 }]);
    const cap = 120;
    const out = fitSnapshotUtf8(json, cap);
    expect(byteLen(out)).toBeLessThanOrEqual(cap);
    const body = JSON.parse(out) as { messages: Array<{ text: string }> };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.text.length).toBeLessThan(200);
    expect(() => fitSnapshotUtf8('not-json', 10)).not.toThrow();
    expect(fitSnapshotUtf8('not-json', 10)).toBe('not-json');
  });

  it('does not split a UTF-8 scalar when clipping', () => {
    const json = snap([{ id: 'e', role: 'user', text: 'éééééééé', at: 1 }]);
    const out = fitSnapshotUtf8(json, 90);
    expect(byteLen(out)).toBeLessThanOrEqual(90);
    const text = (JSON.parse(out) as { messages: Array<{ text: string }> }).messages[0]!
      .text;
    expect(() => Buffer.from(text, 'utf8')).not.toThrow();
    expect(text.includes('\uFFFD')).toBe(false);
  });

  it('preserves extra snapshot keys', () => {
    const json = JSON.stringify({
      id: 's1',
      updatedAt: 9,
      leftover: true,
      messages: [
        { id: 'a', role: 'user', text: 'x'.repeat(80), at: 1 },
        { id: 'b', role: 'user', text: 'keep', at: 2 },
      ],
    });
    const out = fitSnapshotUtf8(json, byteLen(json) - 40);
    const body = JSON.parse(out) as { leftover: boolean; updatedAt: number };
    expect(body.leftover).toBe(true);
    expect(body.updatedAt).toBe(9);
  });
});
