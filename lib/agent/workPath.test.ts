import { describe, expect, it } from 'vitest';
import {
  WorkPathError,
  formatCwdAnnotation,
  normalizeWorkspaceRel,
  parseInitialCwd,
  resolveAgainstCwd,
  resolveExecCwd,
} from './workPath';

describe('normalizeWorkspaceRel', () => {
  it('maps empty and dot to .', () => {
    expect(normalizeWorkspaceRel('')).toBe('.');
    expect(normalizeWorkspaceRel('  ')).toBe('.');
    expect(normalizeWorkspaceRel('.')).toBe('.');
    expect(normalizeWorkspaceRel('./.')).toBe('.');
  });

  it('collapses segments and backslashes', () => {
    expect(normalizeWorkspaceRel('a\\b\\c')).toBe('a/b/c');
    expect(normalizeWorkspaceRel('a/./b')).toBe('a/b');
    expect(normalizeWorkspaceRel('a/b/../c')).toBe('a/c');
  });

  it('rejects host absolute and null byte', () => {
    expect(() => normalizeWorkspaceRel('/etc/passwd')).toThrow(WorkPathError);
    expect(() => normalizeWorkspaceRel('C:\\Windows')).toThrow(WorkPathError);
    expect(() => normalizeWorkspaceRel('a\0b')).toThrow(WorkPathError);
  });

  it('rejects escape above root', () => {
    expect(() => normalizeWorkspaceRel('..')).toThrow(/escapes/);
    expect(() => normalizeWorkspaceRel('a/../../b')).toThrow(/escapes/);
  });
});

describe('resolveAgainstCwd (prefix-aware)', () => {
  it('joins short relative under cwd', () => {
    expect(resolveAgainstCwd('invincible', 'sandbox/a')).toBe(
      'invincible/sandbox/a',
    );
    expect(resolveAgainstCwd('invincible', './sandbox/a')).toBe(
      'invincible/sandbox/a',
    );
  });

  it('does not double-prefix already-rooted paths', () => {
    expect(resolveAgainstCwd('invincible', 'invincible/a')).toBe('invincible/a');
    expect(resolveAgainstCwd('invincible', 'invincible')).toBe('invincible');
  });

  it('handles .. under cwd', () => {
    expect(resolveAgainstCwd('invincible', '..')).toBe('.');
    expect(resolveAgainstCwd('invincible/sub', '../x')).toBe('invincible/x');
  });

  it('cwd . is identity after normalize', () => {
    expect(resolveAgainstCwd('.', 'foo/bar')).toBe('foo/bar');
  });

  it('does not treat similar prefixes as rooted', () => {
    expect(resolveAgainstCwd('foo', 'foobar/x')).toBe('foo/foobar/x');
  });
});

describe('resolveExecCwd', () => {
  it('defaults to logical cwd', () => {
    expect(resolveExecCwd('invincible')).toBe('invincible');
    expect(resolveExecCwd('invincible', null)).toBe('invincible');
    expect(resolveExecCwd('invincible', '  ')).toBe('invincible');
  });

  it('resolves relative exec cwd', () => {
    expect(resolveExecCwd('invincible', 'sandbox')).toBe('invincible/sandbox');
  });
});

describe('formatCwdAnnotation', () => {
  it('omits when root', () => {
    expect(formatCwdAnnotation('.')).toBe('');
  });
  it('includes when nested', () => {
    expect(formatCwdAnnotation('invincible')).toBe(' cwd=invincible');
  });
});

describe('parseInitialCwd', () => {
  it('defaults omit to .', () => {
    expect(parseInitialCwd(undefined)).toEqual({ ok: true, cwd: '.' });
  });
  it('rejects host abs', () => {
    const r = parseInitialCwd('/tmp');
    expect(r.ok).toBe(false);
  });
  it('rejects non-string', () => {
    const r = parseInitialCwd(1);
    expect(r.ok).toBe(false);
  });
  it('accepts relative', () => {
    expect(parseInitialCwd('invincible')).toEqual({
      ok: true,
      cwd: 'invincible',
    });
  });
});
