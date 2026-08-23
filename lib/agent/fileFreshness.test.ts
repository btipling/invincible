import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunFileFreshness,
  editGateError,
  fingerprintsComparable,
  fingerprintsEqual,
  hydrateRunFileFreshness,
  serializeRunFileFreshness,
  TURN_FRESHLEDGER_MAX_GRANTS,
  TURN_FRESHLEDGER_SERIALIZED_MAX_BYTES,
} from './fileFreshness';
import type { FreshnessSeed } from './fileFreshness';

describe('fingerprintsComparable / equal', () => {
  it('requires finite mtime+size on both sides', () => {
    expect(fingerprintsComparable({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 2 })).toBe(
      true,
    );
    expect(fingerprintsComparable({ mtimeMs: 1, size: 2 }, { size: 2 })).toBe(false);
    expect(fingerprintsComparable({ mtimeMs: 1, size: 2 }, { mtimeMs: 0, size: 2 })).toBe(
      true,
    );
    expect(fingerprintsEqual({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 2 })).toBe(true);
    expect(fingerprintsEqual({ mtimeMs: 1, size: 2 }, { mtimeMs: 9, size: 2 })).toBe(false);
    expect(fingerprintsEqual({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 9 })).toBe(false);
  });
});

describe('createRunFileFreshness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('assertCanEdit without grant → read_required', () => {
    const f = createRunFileFreshness();
    expect(f.assertCanEdit('a.ts', { mtimeMs: 1, size: 1 })).toEqual({
      ok: false,
      code: 'read_required',
    });
  });

  it('truncated grant → truncated', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { truncated: true });
    expect(f.assertCanEdit('a.ts', { mtimeMs: 1, size: 10 })).toEqual({
      ok: false,
      code: 'truncated',
    });
  });

  it('matching mtime+size → ok', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { mtimeMs: 100, size: 5, truncated: false });
    expect(f.assertCanEdit('a.ts', { mtimeMs: 100, size: 5 })).toEqual({ ok: true });
  });

  it('mismatched mtime or size → stale', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { mtimeMs: 100, size: 5 });
    expect(f.assertCanEdit('a.ts', { mtimeMs: 101, size: 5 })).toEqual({
      ok: false,
      code: 'stale',
    });
    expect(f.assertCanEdit('a.ts', { mtimeMs: 100, size: 6 })).toEqual({
      ok: false,
      code: 'stale',
    });
  });

  it('missing mtime on grant or live → ok (degrade) and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { size: 5 });
    expect(f.assertCanEdit('a.ts', { mtimeMs: 1, size: 5 })).toEqual({ ok: true });
    expect(f.assertCanEdit('a.ts', { size: 99 })).toEqual({ ok: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/gate 2/i);
  });

  it('recordWrite refreshes grant for second edit', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { mtimeMs: 1, size: 1 });
    f.recordWrite('a.ts', { mtimeMs: 2, size: 2 });
    expect(f.assertCanEdit('a.ts', { mtimeMs: 2, size: 2 })).toEqual({ ok: true });
    expect(f.assertCanEdit('a.ts', { mtimeMs: 1, size: 1 })).toEqual({
      ok: false,
      code: 'stale',
    });
  });

  it('editGateError stable strings', () => {
    expect(editGateError('str_replace', 'read_required')).toMatch(
      /^ERROR str_replace: read_file required/,
    );
    expect(editGateError('write_file', 'stale')).toMatch(
      /^ERROR write_file: file changed since last read_file/,
    );
    expect(editGateError('str_replace', 'truncated')).toMatch(/truncated read_file/);
  });
});

describe('RunFileFreshness projection (serialize/hydrate/snapshot)', () => {
  it('row 1: fresh grants serialize → hydrate(seed) round-trips fp exactly', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { mtimeMs: 100, size: 5, truncated: false });
    f.recordWrite('b.ts', { mtimeMs: 200, size: 33 });
    const h = hydrateRunFileFreshness(serializeRunFileFreshness(f));
    expect(h.assertCanEdit('a.ts', { mtimeMs: 100, size: 5 })).toEqual({ ok: true });
    expect(h.assertCanEdit('b.ts', { mtimeMs: 200, size: 33 })).toEqual({ ok: true });
  });

  it('row 2: truncated grant survives round-trip (never upgraded to fresh)', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { truncated: true });
    const h = hydrateRunFileFreshness(serializeRunFileFreshness(f));
    expect(h.assertCanEdit('a.ts', { mtimeMs: 1, size: 1 })).toEqual({
      ok: false,
      code: 'truncated',
    });
  });

  it('row 3: empty ledger serializes and hydrates to read_required-only', () => {
    const f = createRunFileFreshness();
    expect(JSON.parse(serializeRunFileFreshness(f))).toEqual({
      grants: [],
      truncated: false,
    });
    const h = hydrateRunFileFreshness(serializeRunFileFreshness(f));
    expect(h.assertCanEdit('a.ts', { mtimeMs: 1, size: 1 })).toEqual({
      ok: false,
      code: 'read_required',
    });
  });

  it('row 4: hostile seed with a bad kind is dropped, no throw, path → read_required', () => {
    const h = hydrateRunFileFreshness([
      { path: 'a.ts', kind: 'evil' },
      { path: 'b.ts', kind: 'truncated' },
    ] as unknown as FreshnessSeed);
    expect(h.assertCanEdit('a.ts', { mtimeMs: 1, size: 1 })).toEqual({
      ok: false,
      code: 'read_required',
    });
    expect(h.assertCanEdit('b.ts', { mtimeMs: 1, size: 1 })).toEqual({
      ok: false,
      code: 'truncated',
    });
  });

  it('row 5: hostile seed with non-finite fp → fp stripped to read-grant-only, no throw', () => {
    const h = hydrateRunFileFreshness([
      { path: 'a.ts', kind: 'fresh', fp: { mtimeMs: NaN, size: 5 } },
      { path: 'b.ts', kind: 'fresh', fp: { mtimeMs: Infinity, size: 5 } },
    ] as unknown as FreshnessSeed);
    // NaN/Infinity dropped → grant exists but is not gate-2 comparable (degrade → ok)
    expect(h.assertCanEdit('a.ts', { mtimeMs: 1, size: 5 })).toEqual({ ok: true });
    expect(h.assertCanEdit('b.ts', { mtimeMs: 1, size: 5 })).toEqual({ ok: true });
  });

  it('row 6: JSON garbage / wrong shape never throws; well-formed rows survive', () => {
    expect(() => hydrateRunFileFreshness('not json at all [[[')).not.toThrow();
    expect(() => hydrateRunFileFreshness('{"not":"an array"}')).not.toThrow();
    expect(() =>
      hydrateRunFileFreshness([42, 'x', null] as unknown as FreshnessSeed),
    ).not.toThrow();

    const h = hydrateRunFileFreshness(
      '[{"path":"a.ts","kind":"fresh","fp":{"mtimeMs":1,"size":2}},{"path":"b.ts","kind":"evil"}]',
    );
    expect(h.assertCanEdit('a.ts', { mtimeMs: 1, size: 2 })).toEqual({ ok: true });
    expect(h.assertCanEdit('b.ts', { mtimeMs: 1, size: 2 })).toEqual({
      ok: false,
      code: 'read_required',
    });
  });

  it('row 7: byte-cap overflow truncates with a marker, never throws', () => {
    const huge = 'x'.repeat(25_000);
    const f = createRunFileFreshness({
      seed: [
        { path: huge + '1', kind: 'truncated' },
        { path: huge + '2', kind: 'fresh', fp: { mtimeMs: 1, size: 2 } },
        { path: huge + '3', kind: 'fresh', fp: { mtimeMs: 1, size: 2 } },
      ] as unknown as FreshnessSeed,
    });
    const out = serializeRunFileFreshness(f);
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
    expect(parsed.grants.length).toBeLessThan(3);
    expect(out.length).toBeLessThanOrEqual(TURN_FRESHLEDGER_SERIALIZED_MAX_BYTES);
  });

  it('row 7b: row-cap overflow truncates snapshot with a marker, never throws', () => {
    const f = createRunFileFreshness();
    for (let i = 0; i < TURN_FRESHLEDGER_MAX_GRANTS + 1; i++) {
      f.recordWrite(`f${i}.ts`, { mtimeMs: i, size: i });
    }
    const snap = f.snapshot();
    expect(snap.truncated).toBe(true);
    expect(snap.grants.length).toBe(TURN_FRESHLEDGER_MAX_GRANTS);
  });

  it('row 8: rehydrated freshness enforces gate-2 stale across the boundary', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { mtimeMs: 100, size: 5 });
    const h = hydrateRunFileFreshness(serializeRunFileFreshness(f));
    expect(h.assertCanEdit('a.ts', { mtimeMs: 101, size: 5 })).toEqual({
      ok: false,
      code: 'stale',
    });
    expect(h.assertCanEdit('a.ts', { mtimeMs: 100, size: 6 })).toEqual({
      ok: false,
      code: 'stale',
    });
  });

  it('row 9: snapshot() on a live instance equals the grants serialize emits', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { mtimeMs: 1, size: 2 });
    f.recordWrite('b.ts', { mtimeMs: 3, size: 4 });
    const snap = f.snapshot();
    const parsed = JSON.parse(serializeRunFileFreshness(f));
    expect(parsed.truncated).toBe(false);
    expect(parsed.grants).toEqual(snap.grants);
  });

  it('row 10: missing fp round-trips as read-grant-only (no gate-2)', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', {});
    const h = hydrateRunFileFreshness(serializeRunFileFreshness(f));
    // not gate-2 comparable → degrades to ok, never stale
    expect(h.assertCanEdit('a.ts', { mtimeMs: 5, size: 5 })).toEqual({ ok: true });
  });

  it('row 11: projection is a delta/seed, not transcript content', () => {
    const f = createRunFileFreshness({
      seed: [
        { path: 'transcript.md', kind: 'fresh', fp: { mtimeMs: 1, size: 2 } },
      ] as unknown as FreshnessSeed,
    });
    const parsed = JSON.parse(serializeRunFileFreshness(f));
    expect(parsed).toEqual({
      grants: [{ path: 'transcript.md', kind: 'fresh', fp: { mtimeMs: 1, size: 2 } }],
      truncated: false,
    });
  });
});
