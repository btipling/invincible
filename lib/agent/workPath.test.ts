import { describe, expect, it } from 'vitest';
import {
  WorkPathError,
  canonicalizePath,
  formatCwdAnnotation,
  normalizeWorkspaceRel,
  parseInitialCwd,
  resolveAgainstCwd,
  resolveExecCwd,
  resolveExecCwdForTool,
  resolvePathForTool,
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

  it('collapses extra separators immediately after R (join of R + / + /src)', () => {
    expect(workspaceAbsToRel(ROOT, '/vercel/workspace//src/foo.ts')).toBe(
      'src/foo.ts',
    );
    expect(workspaceAbsToRel(ROOT, '/vercel/workspace///a/b')).toBe('a/b');
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

describe('resolvePathForTool', () => {
  it('in-jail absolute maps to the same workspace-relative key as relative', () => {
    expect(resolvePathForTool(ROOT, '.', `${ROOT}/src/foo.ts`)).toBe(
      'src/foo.ts',
    );
    expect(resolvePathForTool(ROOT, '.', `${ROOT}/src/foo.ts`)).toBe(
      resolvePathForTool(ROOT, '.', 'src/foo.ts'),
    );
    // same key as the underlying seam
    expect(resolvePathForTool(ROOT, '.', `${ROOT}/src/foo.ts`)).toBe(
      canonicalizePath(ROOT, `${ROOT}/src/foo.ts`),
    );
  });

  it('collapses trailing slash and extra separators (shared key)', () => {
    expect(resolvePathForTool(ROOT, '.', `${ROOT}/src/foo.ts/`)).toBe(
      'src/foo.ts',
    );
    expect(resolvePathForTool(ROOT, '.', `${ROOT}//src/foo.ts`)).toBe(
      'src/foo.ts',
    );
  });

  it('out-of-jail absolute and escapes fail closed', () => {
    expect(() => resolvePathForTool(ROOT, '.', '/etc/passwd')).toThrow(
      /escapes workspace root/,
    );
    expect(() =>
      resolvePathForTool(ROOT, '.', `${ROOT}/../escape`),
    ).toThrow(/escapes workspace root/);
    const R2 = '/other/workspace';
    expect(() =>
      resolvePathForTool(ROOT, '.', `${R2}/src/foo.ts`),
    ).toThrow(/escapes workspace root/);
  });

  it('rejects control characters in either R or path', () => {
    expect(() =>
      resolvePathForTool(`${ROOT}\n`, '.', `${ROOT}/a/b`),
    ).toThrow(/control/i);
    expect(() =>
      resolvePathForTool(ROOT, '.', `${ROOT}/a\nb.ts`),
    ).toThrow(/control/i);
  });

  it('relative input resolves against logical cwd (R present or absent)', () => {
    expect(resolvePathForTool(ROOT, 'invincible', 'sandbox/x.ts')).toBe(
      'invincible/sandbox/x.ts',
    );
    expect(resolvePathForTool(null, 'invincible', 'sandbox/x.ts')).toBe(
      'invincible/sandbox/x.ts',
    );
  });

  it('R unavailable (null / undefined / empty) fails closed on absolute, keeps relative', () => {
    const msg = /root unavailable — use a workspace-relative path/;
    for (const R of [null, undefined, '']) {
      expect(() => resolvePathForTool(R, '.', `${ROOT}/src/foo.ts`)).toThrow(
        msg,
      );
      expect(() => resolvePathForTool(R, '.', '/etc/passwd')).toThrow(msg);
      // relative unaffected
      expect(resolvePathForTool(R, 'invincible', 'sandbox/x.ts')).toBe(
        'invincible/sandbox/x.ts',
      );
    }
  });
});

describe('resolveExecCwdForTool', () => {
  it('empty/missing resolves to logical cwd', () => {
    expect(resolveExecCwdForTool(ROOT, 'invincible')).toBe('invincible');
    expect(resolveExecCwdForTool(ROOT, 'invincible', null)).toBe('invincible');
    expect(resolveExecCwdForTool(ROOT, 'invincible', '  ')).toBe('invincible');
  });

  it('relative exec cwd resolves against logical cwd', () => {
    expect(resolveExecCwdForTool(ROOT, 'invincible', 'sandbox')).toBe(
      'invincible/sandbox',
    );
  });

  it('in-jail absolute exec cwd canonicalizes to workspace-relative', () => {
    expect(resolveExecCwdForTool(ROOT, 'invincible', `${ROOT}/sandbox`)).toBe(
      'sandbox',
    );
  });

  it('out-of-jail absolute exec cwd fails closed', () => {
    expect(() =>
      resolveExecCwdForTool(ROOT, 'invincible', '/etc'),
    ).toThrow(/escapes workspace root/);
  });

  it('R unavailable fails exec cwd absolute with the same root-unavailable message', () => {
    for (const R of [null, undefined, '']) {
      expect(() =>
        resolveExecCwdForTool(R, 'invincible', `${ROOT}/sandbox`),
      ).toThrow(/root unavailable — use a workspace-relative path/);
    }
  });
});
