import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HARNESS_SESSION_LABEL_MAX_BYTES,
  HARNESS_SESSION_RAIL_MAX,
} from './sessionCloudCaps';
import {
  buildSessionCatalogEntries,
  foldPendingSessionSwitch,
  sessionSummaryLabel,
} from './sessionSummaryLabel';

describe('sessionSummaryLabel', () => {
  it('uses a trimmed nonempty title', () => {
    expect(sessionSummaryLabel({ id: 'abc12345', title: '  Hello  ' })).toBe('Hello');
  });

  it('untitled long id uses last-7 suffix', () => {
    expect(sessionSummaryLabel({ id: 'abcdefghijklmnop' })).toBe('Untitled · …jklmnop');
  });

  it('untitled short id uses the full id', () => {
    expect(sessionSummaryLabel({ id: 'abc' })).toBe('Untitled · abc');
    expect(sessionSummaryLabel({ id: 'abcdefgh' })).toBe('Untitled · abcdefgh');
  });

  it('null / empty title is untitled', () => {
    expect(sessionSummaryLabel({ id: 'zzzzzzzz', title: null })).toBe('Untitled · zzzzzzzz');
    expect(sessionSummaryLabel({ id: 'zzzzzzzz', title: '   ' })).toBe('Untitled · zzzzzzzz');
  });
});

describe('buildSessionCatalogEntries', () => {
  it('sorts by updatedAt desc', () => {
    const rows = buildSessionCatalogEntries(
      [
        { id: 'old-id-aaaaaaa', updatedAt: 1, title: 'old' },
        { id: 'new-id-bbbbbbb', updatedAt: 9, title: 'new' },
        { id: 'mid-id-ccccccc', updatedAt: 5, title: 'mid' },
      ],
      null,
    );
    expect(rows.map((r) => r.id)).toEqual(['new-id-bbbbbbb', 'mid-id-ccccccc', 'old-id-aaaaaaa']);
  });

  it('treats missing / 0 updatedAt as last', () => {
    const rows = buildSessionCatalogEntries(
      [
        { id: 'zero-id-aaaaaa', updatedAt: 0, title: 'zero' },
        { id: 'hot-id-bbbbbbb', updatedAt: 3, title: 'hot' },
        { id: 'none-id-cccccc', title: 'none' },
      ],
      null,
    );
    expect(rows[0]?.id).toBe('hot-id-bbbbbbb');
  });

  it('pins current to front even when not among the newest 256', () => {
    const many = Array.from({ length: HARNESS_SESSION_RAIL_MAX + 5 }, (_, i) => ({
      id: `sess-${String(i).padStart(8, '0')}`,
      updatedAt: 1000 + i,
      title: `t${i}`,
    }));
    const stale = many[0]!;
    const rows = buildSessionCatalogEntries(many, stale.id);
    expect(rows[0]?.id).toBe(stale.id);
    expect(rows).toHaveLength(HARNESS_SESSION_RAIL_MAX);
    expect(rows.filter((r) => r.id === stale.id)).toHaveLength(1);
    // newest others fill the rest
    expect(rows[1]?.id).toBe(many[many.length - 1]!.id);
  });

  it('prepends current when absent from sessions', () => {
    const rows = buildSessionCatalogEntries(
      [{ id: 'other-id-aaaaaa', updatedAt: 1, title: 'other' }],
      'brand-new-bbbbbb',
    );
    expect(rows[0]).toEqual({
      id: 'brand-new-bbbbbb',
      label: sessionSummaryLabel({ id: 'brand-new-bbbbbb' }),
    });
    expect(rows[1]?.id).toBe('other-id-aaaaaa');
  });

  it('drops non-Redis-safe ids', () => {
    const rows = buildSessionCatalogEntries(
      [
        { id: 'good-id-aaaaaaa', title: 'ok' },
        { id: 'has space', title: 'bad' },
        { id: 'also:colon', title: 'bad2' },
      ],
      null,
    );
    expect(rows.map((r) => r.id)).toEqual(['good-id-aaaaaaa']);
  });

  it('truncates long titles to the label byte cap', () => {
    const title = '文'.repeat(200);
    const rows = buildSessionCatalogEntries([{ id: 'id-aaaaaaa', title }], null);
    const bytes = new TextEncoder().encode(rows[0]!.label);
    expect(bytes.length).toBeLessThanOrEqual(HARNESS_SESSION_LABEL_MAX_BYTES);
    expect(rows[0]!.label.length).toBeGreaterThan(0);
  });
});

describe('foldPendingSessionSwitch', () => {
  it('applies when not inflight', () => {
    const seen: string[] = [];
    expect(
      foldPendingSessionSwitch(false, () => 'sess-a', (id) => seen.push(id)),
    ).toBe('switched');
    expect(seen).toEqual(['sess-a']);
  });

  it('acks and drops while inflight (does not call onSwitch)', () => {
    let taken = false;
    const seen: string[] = [];
    expect(
      foldPendingSessionSwitch(
        true,
        () => {
          taken = true;
          return 'sess-b';
        },
        (id) => seen.push(id),
      ),
    ).toBe('dropped');
    expect(taken).toBe(true);
    expect(seen).toEqual([]);
  });

  it('none when take returns null / empty', () => {
    expect(foldPendingSessionSwitch(false, () => null, () => {})).toBe('none');
    expect(foldPendingSessionSwitch(false, () => '', () => {})).toBe('none');
  });
});

describe('session-rail cap parity (TS ↔ Zig)', () => {
  const zig = readFileSync(resolve(process.cwd(), 'native/harness/src/session_catalog.zig'), 'utf8');
  it('HARNESS_SESSION_RAIL_MAX matches MAX_SESSION_CATALOG', () => {
    const m = zig.match(/pub const MAX_SESSION_CATALOG: u32 = (\d+);/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(HARNESS_SESSION_RAIL_MAX);
    expect(HARNESS_SESSION_RAIL_MAX).toBe(256);
  });
  it('HARNESS_SESSION_LABEL_MAX_BYTES matches MAX_SESSION_LABEL_LEN', () => {
    const m = zig.match(/pub const MAX_SESSION_LABEL_LEN: usize = (\d+);/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(HARNESS_SESSION_LABEL_MAX_BYTES);
    expect(HARNESS_SESSION_LABEL_MAX_BYTES).toBe(128);
  });
});
