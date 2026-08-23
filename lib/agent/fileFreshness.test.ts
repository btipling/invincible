import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunFileFreshness,
  editGateError,
  fingerprintsComparable,
  fingerprintsEqual,
  hydrateRunFileFreshness,
  serializedLedgerBytes,
  serializeRunFileFreshness,
  TURN_FRESHLEDGER_SERIALIZED_MAX_BYTES,
  TURN_FRESHLEDGER_SERIALIZED_MAX_ENTRIES,
} from './fileFreshness';

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

describe('serializable RunFileFreshness projection (backend-agents E)', () => {
  it('serialize round-trips paths + fingerprints + truncated (plan test row 1)', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { mtimeMs: 100, size: 5, truncated: false });
    f.recordWrite('b.ts', { mtimeMs: 200, size: 9 });
    f.recordRead('trunc.ts', { truncated: true });

    const projection = serializeRunFileFreshness(f);
    expect(projection.truncated).toBe(false);
    const byPath = new Map(projection.paths.map((p) => [p.path, p]));
    expect(byPath.get('a.ts')).toEqual({
      path: 'a.ts',
      mtimeMs: 100,
      size: 5,
    });
    expect(byPath.get('b.ts')).toEqual({
      path: 'b.ts',
      mtimeMs: 200,
      size: 9,
    });
    expect(byPath.get('trunc.ts')).toEqual({ path: 'trunc.ts', truncated: true });

    // Hydrate in a "fresh process" and verify read-before-edit still holds.
    const h = hydrateRunFileFreshness(projection);
    expect(h.assertCanEdit('a.ts', { mtimeMs: 100, size: 5 })).toEqual({ ok: true });
    expect(h.assertCanEdit('b.ts', { mtimeMs: 200, size: 9 })).toEqual({ ok: true });
    expect(h.assertCanEdit('b.ts', { mtimeMs: 1, size: 1 })).toEqual({
      ok: false,
      code: 'stale',
    });
    expect(h.assertCanEdit('trunc.ts', { mtimeMs: 1, size: 1 })).toEqual({
      ok: false,
      code: 'truncated',
    });
    // Unknown path re-requires a read.
    expect(h.assertCanEdit('c.ts', { mtimeMs: 1, size: 1 })).toEqual({
      ok: false,
      code: 'read_required',
    });
  });

  it('hydrated ledger still records writes and re-serializes (plan test row 1 continuation)', () => {
    const f = createRunFileFreshness();
    f.recordRead('a.ts', { mtimeMs: 1, size: 1 });
    const h = hydrateRunFileFreshness(serializeRunFileFreshness(f));
    h.recordWrite('a.ts', { mtimeMs: 2, size: 2 });
    expect(h.assertCanEdit('a.ts', { mtimeMs: 2, size: 2 })).toEqual({ ok: true });
    expect(h.snapshot().paths.find((p) => p.path === 'a.ts')).toEqual({
      path: 'a.ts',
      mtimeMs: 2,
      size: 2,
    });
  });

  it('null / undefined / empty seed hydrates to an empty ledger (plan test row 1)', () => {
    expect(hydrateRunFileFreshness(null).snapshot()).toEqual({ paths: [], truncated: false });
    expect(hydrateRunFileFreshness(undefined).snapshot()).toEqual({
      paths: [],
      truncated: false,
    });
  });

  it('caps: bounded entries → truncation marker, never a throw (plan test row 2)', () => {
    const f = createRunFileFreshness();
    // Beyond the entries cap we expect the projection to drop the tail and mark truncated.
    for (let i = 0; i < TURN_FRESHLEDGER_SERIALIZED_MAX_ENTRIES + 50; i++) {
      const live = i % 2 === 0;
      if (live) f.recordRead(`f${i}.ts`, { mtimeMs: i, size: i });
      else f.recordRead(`g${i}.ts`, { truncated: true });
    }
    const projection = serializeRunFileFreshness(f);
    expect(projection.truncated).toBe(true);
    expect(projection.paths.length).toBeLessThanOrEqual(TURN_FRESHLEDGER_SERIALIZED_MAX_ENTRIES);
    // A bounded-projection JSON is well under the byte cap.
    expect(serializedLedgerBytes(projection)).toBeLessThanOrEqual(
      TURN_FRESHLEDGER_SERIALIZED_MAX_BYTES,
    );
    // Hydrating the truncated projection must not throw.
    expect(() => hydrateRunFileFreshness(projection)).not.toThrow();
  });

  it('caps: long paths exceed the byte budget → truncation marker', () => {
    const f = createRunFileFreshness();
    // A single row whose path text alone blows the byte budget.
    f.recordRead('x'.repeat(TURN_FRESHLEDGER_SERIALIZED_MAX_BYTES + 10), { mtimeMs: 1, size: 1 });
    const projection = serializeRunFileFreshness(f);
    expect(projection.truncated).toBe(true);
    expect(projection.paths.length).toBe(0);
  });

  it('caps: hostile/malformed seed rows are skipped, never thrown (fail closed)', () => {
    const hostile = {
      paths: [
        { path: 'ok.ts', mtimeMs: 1, size: 1 },
        { path: 42, mtimeMs: 2 },
        null,
        'bad',
        { mtimeMs: 9, size: 9 },
      ],
      truncated: false,
    } as unknown as import('./fileFreshness').FreshnessLedgerProjection;
    const h = hydrateRunFileFreshness(hostile);
    const proj = h.snapshot();
    const byPath = new Map(proj.paths.map((p) => [p.path, p]));
    expect(proj.truncated).toBe(false);
    expect(byPath.get('ok.ts')).toEqual({ path: 'ok.ts', mtimeMs: 1, size: 1 });
    expect(byPath.has('ok.ts')).toBe(true);
  });
});
