import { describe, expect, it } from 'vitest';
import {
  WorkPathError,
  canonicalizePath,
  formatCwdAnnotation,
  normalizeWorkspaceRel,
  parseInitialCwd,
  resolveAgainstCwd,
  resolveExecCwd,
  workspaceAbsToRel,
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

  it('rejects newlines and other control characters', () => {
    expect(() => normalizeWorkspaceRel('a\nb')).toThrow(/control/i);
    expect(() => normalizeWorkspaceRel('a\rb')).toThrow(/control/i);
    expect(() => normalizeWorkspaceRel('a\tb')).toThrow(/control/i);
    expect(() => normalizeWorkspaceRel('foo\n:evil')).toThrow(/control/i);
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

  it('rejects control characters on path arg', () => {
    expect(() => resolveAgainstCwd('invincible', 'a\nb')).toThrow(/control/i);
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
  it('rejects control characters', () => {
    const r = parseInitialCwd('a\nb');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/control/i);
  });
  it('accepts relative', () => {
    expect(parseInitialCwd('invincible')).toEqual({
      ok: true,
      cwd: 'invincible',
    });
  });
});

const ROOT = '/vercel/workspace';

describe('workspaceAbsToRel', () => {
  it('maps root and under-root absolutes to workspace-relative', () => {
    expect(workspaceAbsToRel(ROOT, '/vercel/workspace')).toBe('.');
    expect(workspaceAbsToRel(ROOT, '/vercel/workspace/')).toBe('.');
    expect(workspaceAbsToRel(ROOT, '/vercel/workspace/src/foo.ts')).toBe(
      'src/foo.ts',
    );
    expect(workspaceAbsToRel(ROOT, '/vercel/workspace/src/foo.ts/')).toBe(
      'src/foo.ts',
    );
  });

  it('normalizes . .. inside the tail', () => {
    expect(workspaceAbsToRel(ROOT, '/vercel/workspace/a/./b')).toBe('a/b');
    expect(workspaceAbsToRel(ROOT, '/vercel/workspace/a/../b')).toBe('b');
  });

  it('rejects absolutes outside R, other roots, and non-absolute input', () => {
    expect(() => workspaceAbsToRel(ROOT, '/etc/passwd')).toThrow(WorkPathError);
    expect(() => workspaceAbsToRel(ROOT, '/other/src/foo.ts')).toThrow(WorkPathError);
    expect(() => workspaceAbsToRel(ROOT, '/vercel/workspace.txt')).toThrow(
      WorkPathError,
    );
    expect(() => workspaceAbsToRel(ROOT, 'src/foo.ts')).toThrow(/absolute/i);
    expect(() => workspaceAbsToRel(ROOT, 'C:\\foo')).toThrow(/absolute/i);
  });

  it('rejects an escaping tail (.. above root)', () => {
    expect(() => workspaceAbsToRel(ROOT, '/vercel/workspace/../etc')).toThrow(
      WorkPathError,
    );
  });

  it('rejects control chars in R or abs', () => {
    expect(() => workspaceAbsToRel('/vercel/wo\nrkspace', '/vercel/w')).toThrow(
      /control/i,
    );
    expect(() => workspaceAbsToRel(ROOT, '/vercel/workspace/a\nb')).toThrow(
      /control/i,
    );
  });

  it('normalizes the root itself (trailing slash tolerance)', () => {
    expect(workspaceAbsToRel(`${ROOT}/`, `${ROOT}/src/a.ts`)).toBe('src/a.ts');
  });
});

describe('canonicalizePath', () => {
  it('relative stays relative (unchanged ledger key)', () => {
    expect(canonicalizePath(ROOT, 'src/foo.ts')).toBe('src/foo.ts');
    expect(canonicalizePath(ROOT, '.')).toBe('.');
    expect(canonicalizePath(ROOT, '')).toBe('.');
  });

  it('absolute under R maps to the same workspace-relative key', () => {
    expect(canonicalizePath(ROOT, `${ROOT}/src/foo.ts`)).toBe('src/foo.ts');
    expect(canonicalizePath(ROOT, `${ROOT}/src/foo.ts`)).toBe(
      canonicalizePath(ROOT, 'src/foo.ts'),
    );
    expect(canonicalizePath(ROOT, `${ROOT}/`)).toBe('.');
  });

  it('rejects host-absolute outside R / escapes — fail closed', () => {
    expect(() => canonicalizePath(ROOT, '/etc/passwd')).toThrow(WorkPathError);
    expect(() => canonicalizePath(ROOT, `${ROOT}/../escape`)).toThrow(WorkPathError);
    expect(() => canonicalizePath(ROOT, `${ROOT}_other/src`)).toThrow(WorkPathError);
    expect(() => canonicalizePath(ROOT, 'C:\\Windows')).toThrow(WorkPathError);
  });

  it('a different binding root (R2) never matches this binding', () => {
    const R2 = '/other/workspace';
    expect(() => canonicalizePath(ROOT, `${R2}/src/foo.ts`)).toThrow(WorkPathError);
    // But under its own binding it is valid and canonical.
    expect(canonicalizePath(R2, `${R2}/src/foo.ts`)).toBe('src/foo.ts');
  });
});
