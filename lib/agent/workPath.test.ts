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
  rewriteExecRootToRel,
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

  it('#466 re-roots to an exact ancestor under cwd', () => {
    expect(resolveAgainstCwd('invincible/docs', 'invincible')).toBe('invincible');
    expect(resolveAgainstCwd('invincible/docs', './invincible')).toBe(
      'invincible',
    );
  });

  it('#466 deep ancestor chain re-roots (a/b/c + a, a/b)', () => {
    expect(resolveAgainstCwd('a/b/c', 'a')).toBe('a');
    expect(resolveAgainstCwd('a/b/c', 'a/b')).toBe('a/b');
    // A non-ancestor sibling of an ancestor segment is NOT re-rooted.
    expect(resolveAgainstCwd('a/b/c', 'b')).toBe('a/b/c/b');
  });

  it('#466 no false prefix on the ancestor side (foobar/x + foo stays relative)', () => {
    // `foo` shares a name prefix with `foobar` but is NOT an ancestor of
    // `foobar/x` (`cwd` does not start with `foo/`), so it is joined, not
    // re-rooted.
    expect(resolveAgainstCwd('foobar/x', 'foo')).toBe('foobar/x/foo');
  });

  it('#466 equal path still resolves as rooted (no re-root of equal)', () => {
    expect(resolveAgainstCwd('invincible', 'invincible')).toBe('invincible');
    expect(resolveAgainstCwd('invincible/docs', 'invincible/docs')).toBe(
      'invincible/docs',
    );
  });

  it('#466 `..` under cwd and at-root escape are unchanged', () => {
    // From depth, `..` climbs toward the workspace root (not re-rooted).
    expect(resolveAgainstCwd('invincible/docs', '..')).toBe('invincible');
    expect(resolveAgainstCwd('invincible/docs', '../x')).toBe('invincible/x');
    // At root, `..` still escapes (unchanged).
    expect(() => resolveAgainstCwd('.', '..')).toThrow(/escapes/);
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

  it('#403 cross-feed: realpath BYO jail root from exec pwd folds to the workspace-relative key', () => {
    // The repo is nested under a realpath'd BYO jail root, as `exec pwd` /
    // `find` / stack traces would show it. The host-absolute string is the SAME
    // file as the workspace-relative form the tools output, so either is
    // re-entrant on every FS tool — not just the underlying seam.
    const R = '/var/lib/invincible-sandbox/workspace';
    const hostAbs = `${R}/invincible/docs/sandbox.md`;
    expect(resolvePathForTool(R, '.', hostAbs)).toBe(
      'invincible/docs/sandbox.md',
    );
    expect(resolvePathForTool(R, '.', hostAbs)).toBe(
      resolvePathForTool(R, '.', 'invincible/docs/sandbox.md'),
    );
    expect(resolvePathForTool(R, '.', `${R}/invincible`)).toBe('invincible');
    // An absolute under a DIFFERENT realpath root still fails closed.
    expect(() =>
      resolvePathForTool(R, '.', '/other/workspace/invincible/docs'),
    ).toThrow(/escapes workspace root/);
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

describe('rewriteExecRootToRel', () => {
  it('rewrites under-R absolutes to workspace-relative; bare R maps to .', () => {
    const text = `pwd: ${ROOT}\nexec pwd`;
    expect(rewriteExecRootToRel(ROOT, `${ROOT}\n`)).toBe('.\n');
    expect(rewriteExecRootToRel(ROOT, `cwd ${ROOT}/src/foo.ts ok\n`)).toBe(
      'cwd src/foo.ts ok\n',
    );
    expect(
      rewriteExecRootToRel(ROOT, `${ROOT}/invincible/docs/sandbox.md\n`),
    ).toBe('invincible/docs/sandbox.md\n');
  });

  it('leaves out-of-jail / other-root / non-POSIX absolutes unchanged', () => {
    const text = '/etc/passwd and /var/log/syslog line\nC:\\Windows\\x\n';
    expect(rewriteExecRootToRel(ROOT, text)).toBe(text);
    const R2 = '/other/workspace';
    expect(rewriteExecRootToRel(ROOT, `${R2}/src/foo.ts\n`)).toBe(
      `${R2}/src/foo.ts\n`,
    );
  });

  it('byte-identical pass-through when R is null / undefined / empty', () => {
    const text = `${ROOT}/src/foo.ts\n`;
    expect(rewriteExecRootToRel(null, text)).toBe(text);
    expect(rewriteExecRootToRel(undefined, text)).toBe(text);
    expect(rewriteExecRootToRel('', text)).toBe(text);
    // non-string R also passes through; doesn't throw
    expect(rewriteExecRootToRel(ROOT, null as unknown as string)).toBe('');
  });

  it('does not treat a prefix-sharing token without a / boundary as in-jail', () => {
    // R=/vercel/workspace
    expect(rewriteExecRootToRel(ROOT, '/vercel/workspacebackup/setup.cfg\n')).toBe(
      '/vercel/workspacebackup/setup.cfg\n',
    );
    expect(rewriteExecRootToRel(ROOT, `${ROOT}.txt\n`)).toBe(`${ROOT}.txt\n`);
  });

  it('R=/a does not rewrite /ab/c (prefix boundary lock)', () => {
    expect(rewriteExecRootToRel('/a', '/ab/c\n')).toBe('/ab/c\n');
    // but a real token under /a rewrites
    expect(rewriteExecRootToRel('/a', '/a/b/c\n')).toBe('b/c\n');
  });

  it('leaves interior dots intact (single token) and handles path punctuation boundaries', () => {
    // `.git`, extensions, `.bin` are path chars — not token boundaries.
    expect(
      rewriteExecRootToRel(ROOT, `${ROOT}/invincible/.git/HEAD\n`),
    ).toBe('invincible/.git/HEAD\n');
    const inJson = `{"path": "${ROOT}/src/foo.ts", "n": 1}`;
    expect(rewriteExecRootToRel(ROOT, inJson)).toBe(
      '{"path": "src/foo.ts", "n": 1}',
    );
    const grep = `${ROOT}/src/foo.ts:5: content`;
    expect(rewriteExecRootToRel(ROOT, grep)).toBe('src/foo.ts:5: content');
  });

  it('colon-terminated under-R absolutes in structured data rewrite (PATH case)', () => {
    // `:` is a token boundary (kept for `file:line` grep), so a
    // colon-separated value whose absolute path is under R is rewritten too.
    // Not a jail escape, but it mutates non-path structured data — locked so it
    // can't silently bit-rot.
    expect(
      rewriteExecRootToRel(ROOT, 'PATH=/usr/bin:/vercel/workspace/node_modules/.bin\n'),
    ).toBe('PATH=/usr/bin:node_modules/.bin\n');
  });

  it('leaves relative-only output byte-identical (no leading / tokens)', () => {
    const text = 'src/a.ts\nlib/agent/tools.ts\n';
    expect(rewriteExecRootToRel(ROOT, text)).toBe(text);
  });

  it('leaves // runs and mid-word slashes alone', () => {
    expect(rewriteExecRootToRel(ROOT, `//${ROOT}/x\n`)).toBe(`//${ROOT}/x\n`);
    expect(rewriteExecRootToRel(ROOT, `/etc/${ROOT}\n`)).toBe(`/etc/${ROOT}\n`);
  });

  it('collapses escape/`..` tokens to pass-through (never throws)', () => {
    const text = `${ROOT}/../etc/passwd peek\n`;
    expect(rewriteExecRootToRel(ROOT, text)).toBe(`${ROOT}/../etc/passwd peek\n`);
  });

  it('never throws on pathological input and passes past-cap tokens through', () => {
    const many = Array.from({ length: 5000 }, () => `${ROOT}/f.ts`).join(' ');
    let out = '';
    expect(() => {
      out = rewriteExecRootToRel(ROOT, many);
    }).not.toThrow();
    // nothing is dropped — every token is still present (rewritten or passed through)
    expect((out as string).split('f.ts').length - 1).toBe(5000);
    // ...but the cap means not all were rewritten to the relative form
    const absRemaining = (out as string).split('/f.ts').length - 1;
    expect(absRemaining).toBeGreaterThan(0);
    expect(absRemaining).toBeLessThan(5000);
  });

  it('does not introduce control characters (pure text replacement; existing newlines preserved)', () => {
    const clean = `path is ${ROOT}/a/b.txt ok`;
    expect(rewriteExecRootToRel(ROOT, clean)).toBe('path is a/b.txt ok');
    expect(rewriteExecRootToRel(ROOT, clean)).not.toMatch(/[\u0000-\u001f\u007f]/);
    // existing newlines are preserved (not stripped / not doubled)
    const nl = `line1\n${ROOT}/a/b.txt\nline3\n`;
    expect(rewriteExecRootToRel(ROOT, nl)).toBe('line1\na/b.txt\nline3\n');
  });
});
