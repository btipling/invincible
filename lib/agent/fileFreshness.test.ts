import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunFileFreshness,
  editGateError,
  fingerprintsComparable,
  fingerprintsEqual,
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
