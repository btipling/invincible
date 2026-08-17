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
  foldSessionListResult,
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

  it('discards leftover submit on switch, not on drop / none', () => {
    const discarded: string[] = [];
    const discard = () => discarded.push('x');
    expect(
      foldPendingSessionSwitch(false, () => 'sess-a', () => {}, discard),
    ).toBe('switched');
    expect(discarded).toEqual(['x']);
    discarded.length = 0;
    expect(
      foldPendingSessionSwitch(true, () => 'sess-b', () => {}, discard),
    ).toBe('dropped');
    expect(discarded).toEqual([]);
    expect(
      foldPendingSessionSwitch(false, () => null, () => {}, discard),
    ).toBe('none');
    expect(discarded).toEqual([]);
  });
});

describe('foldSessionListResult', () => {
  const prev = [
    { id: 'keep-id-aaaaaa', title: 'keep' },
    { id: 'old-id-bbbbbbb', title: 'old' },
  ];

  it('ok replaces the list and leaves cloud enabled', () => {
    const next = foldSessionListResult(prev, {
      action: 'ok',
      sessions: [{ id: 'new-id-ccccccc', title: 'new' }],
    });
    expect(next.sessions).toEqual([{ id: 'new-id-ccccccc', title: 'new' }]);
    expect(next.cloudEnabled).toBeUndefined();
  });

  it('disabled keeps last list and flips cloud off', () => {
    const next = foldSessionListResult(prev, { action: 'disabled' });
    expect(next.sessions).toEqual(prev);
    expect(next.cloudEnabled).toBe(false);
  });

  it('5xx / error keeps last list and does not flip cloud', () => {
    const next = foldSessionListResult(prev, { action: 'error', status: 503 } as {
      action: string;
    });
    expect(next.sessions).toEqual(prev);
    expect(next.cloudEnabled).toBeUndefined();
  });
});

describe('HarnessHost poll / list wiring (PR #642 review)', () => {
  const host = readFileSync(resolve(process.cwd(), 'app/harness/HarnessHost.tsx'), 'utf8');

  it('switch tick discards leftover submit and sets Ready', () => {
    expect(host).toContain('b.takePendingSubmit()');
    expect(host).toContain('b.setLifecycle(Lifecycle.Ready)');
    expect(host).toContain('foldPendingSessionSwitch(');
    expect(host).toMatch(/takePendingSubmit\(\);\s*\n\s*b\.setLifecycle\(Lifecycle\.Ready\)/);
  });

  it('refreshSessions folds list via foldSessionListResult (5xx keeps last)', () => {
    expect(host).toContain('foldSessionListResult');
    const fn = host.slice(host.indexOf('const refreshSessions'), host.indexOf('const activateSession'));
    expect(fn).toContain('foldSessionListResult');
    expect(fn).not.toMatch(/setSessions\(\[\]\)/);
  });

  // Adversarial #642: New and Clear must discard session-switch pending.
  it('onClear acks pending session switch (like discardPendingModelChange)', () => {
    expect(host).toContain('bridge.takePendingSessionSwitch()');
    const onClear = host.slice(host.indexOf('const onClear = useCallback'), host.indexOf('const onNewSession'));
    expect(onClear).toContain('takePendingSessionSwitch()');
    expect(onClear).toContain('discardPendingModelChange');
  });

  it('onNewSession acks pending session switch before async', () => {
    const onNew = host.slice(host.indexOf('const onNewSession = useCallback'), host.indexOf('  const onSwitchSession = useCallback'));
    expect(onNew).toContain('takePendingSessionSwitch()');
  });

  it('switchInFlightRef exists and guards poll, Clear, New, and onSwitchSession', () => {
    expect(host).toContain('switchInFlightRef');
    // Poll: inflightRef.current || switchInFlightRef.current → ack-and-drop.
    expect(host).toContain('inflightRef.current || switchInFlightRef.current');
    // Clear / New both guard with switchInFlightRef.
    const onClear = host.slice(host.indexOf('const onClear = useCallback'), host.indexOf('  const onNewSession'));
    expect(onClear).toContain('switchInFlightRef.current');
    // NOTE: use a unique prefix so indexOf doesn't match onSwitchSessionRef (the useRef).
    const onNew = host.slice(host.indexOf('const onNewSession = useCallback'), host.indexOf('  const onSwitchSession = useCallback'));
    expect(onNew).toContain('switchInFlightRef.current');
    // onSwitchSession is the last callback before the useEffect catalog push.
    const onSwitch = host.slice(host.indexOf('  const onSwitchSession = useCallback'), host.indexOf('onSwitchSessionRef.current = onSwitchSession'));
    expect(onSwitch).toContain('switchInFlightRef.current');
  });

  it('onSwitchSession sets switchInFlightRef and re-checks sessionRef after await', () => {
    const onSwitch = host.slice(host.indexOf('  const onSwitchSession = useCallback'), host.indexOf('onSwitchSessionRef.current = onSwitchSession'));
    expect(onSwitch).toContain('switchInFlightRef.current = true');
    expect(onSwitch).toContain('switchInFlightRef.current = false');
    expect(onSwitch).toContain('sourceId');
    expect(onSwitch).toContain('sessionRef.current.id !== sourceId');
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
