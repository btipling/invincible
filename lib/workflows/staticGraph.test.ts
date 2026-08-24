import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractImports,
  reachableImports,
  resolveFile,
  resolveImport,
} from './staticGraph';

/**
 * Static-graph regression (backend-agents B11, plan #805).
 *
 * A `"use workflow"` bundle must never reach the DB driver / crypto / dns /
 * MCP / Blob-store surface (`POST-MORTEM §2` deploy-gate lock, #710). The walk
 * is scoped to an **explicit root file's closure only** — `'use step'` bodies
 * may import the world and a repo-wide grep is forbidden (false-positives on
 * legit `node:crypto`/`node:dns` in tenancy/sandbox). This file pins the locked
 * testing matrix (13 cases).
 *
 * `node:fs` reads are di-gate-allowlisted (test files are).
 */

const REPO_ROOT = process.cwd();

/**
 * Banned surface, grounded on the actual repo (plan #805 lock + corrections).
 *
 * Adversarial L8 (2026-08-24): the ban set must **prefix-match** the crypto/dns
 * families, not exact-match single spellings. The walker records a bare specifier
 * verbatim (`crypto`, `dns`) or a `node:`-prefixed subpath (`node:crypto`,
 * `node:crypto/webcrypto`, `node:dns/promises`), so an exact-match filter can be
 * escaped by `import { createHash } from 'crypto'` (legal Node) or
 * `node:crypto/promises`. Matching the family root with a path/`startsWith` bound
 * keeps each of those spellings (and any sibling subpath) fail-closed.
 */
function bannedReach(reachable: Set<string>): string[] {
  return [...reachable].filter((v) => {
    // Bare DB-driver + builtin families: prefix-match family roots so unprefixed
    // `crypto`/`dns`, `node:` subpaths, and driver sibling subitems all fail closed.
    if (v === 'pg' || v === 'postgres') return true;
    if (v.startsWith('crypto') || v.startsWith('dns')) return true;
    // node: pseudo-module subpaths (e.g. `node:crypto/webcrypto`, `node:dns/promises`).
    if (v.startsWith('node:crypto') || v.startsWith('node:dns')) return true;
    if (v === 'lib/sessions/blobStore' || v === 'lib/sessions/blobStores') return true;
    return v.startsWith('db/') || v.startsWith('lib/db/') || v.startsWith('lib/mcp/');
  });
}

/**
 * Build a disposable temp import graph (under the OS temp dir) so the walk
 * mechanics (cycle, depth, require, missing target, ext mapping) run against
 * real source files without committing throwaway fixtures. The node runtime
 * writing to `os.tmpdir()` is standard test behavior; the files are removed in
 * `afterEach`.
 */
function tmpGraph(named: Record<string, string>): { root: string; close: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ivc-staticgraph-'));
  for (const [name, src] of Object.entries(named)) {
    writeFileSync(join(root, name), src);
  }
  return {
    root,
    close: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

describe('staticGraph — resolveImport / resolveFile mechanics (matrix 3,4,5,6,7)', () => {
  it('bare `node:crypto` maps to the bare name (case 3)', () => {
    expect(resolveImport('node:crypto', '/repo/lib/x.ts', '/repo')).toBe('node:crypto');
  });

  it('bare `pg` maps to the bare name (case 4)', () => {
    expect(resolveImport('pg', '/repo/lib/x.ts', '/repo')).toBe('pg');
    expect(resolveImport('postgres', '/repo/lib/x.ts', '/repo')).toBe('postgres');
  });

  it('`@/` alias resolves to a root-relative path under lib/ (case 5)', () => {
    // `@/lib/sessions/blobStore` → the real Blob-store module → banned.
    const v = resolveImport('@/lib/sessions/blobStore', join(REPO_ROOT, 'lib/x.ts'), REPO_ROOT);
    expect(bannedReach(new Set([v]))).toEqual(['lib/sessions/blobStore']);
    // `@/lib/mcp/urlPolicy` reaches forbidden MCP surface.
    const mcp = resolveImport('@/lib/mcp/urlPolicy', join(REPO_ROOT, 'lib/x.ts'), REPO_ROOT);
    expect(bannedReach(new Set([mcp]))).toContain('lib/mcp/urlPolicy');
  });

  it('relative import with and without `.ts` resolves to the same deduped value (case 6)', () => {
    const g = tmpGraph({
      'dep.ts': 'export const D = 1;',
      'a.ts': "import { D } from './dep';\nimport { D as D2 } from './dep.ts';\nexport const v = D + D2;",
    });
    try {
      const reachable = reachableImports('a.ts', { root: g.root });
      const hits = [...reachable].filter((v) => v === 'dep');
      expect(hits).toHaveLength(1); // deduped — both specifiers collapse to `dep`
    } finally {
      g.close();
    }
  });

  it('`.js` specifier resolves to the underlying `.ts` file (case 7)', () => {
    const g = tmpGraph({ 'util.ts': 'export const U = 1;' });
    try {
      expect(resolveFile(join(g.root, 'util.js'))).toBe(join(g.root, 'util.ts'));
    } finally {
      g.close();
    }
  });
});

describe('staticGraph — closure walk (matrix 1,2,8,9,10,11,12,13)', () => {
  it('clean fixture closure reaches zero banned modules (case 1)', () => {
    const reachable = reachableImports('lib/workflows/staticWorkflowFixture.ts', {
      root: REPO_ROOT,
    });
    expect(reachable.has('lib/workflows/staticWorkflowFixture')).toBe(true);
    expect(bannedReach(reachable)).toEqual([]);
  });

  it('positive control (dangerousGraphFixture) reaches a banned module → checker flags it (case 2)', () => {
    const reachable = reachableImports('lib/workflows/dangerousGraphFixture.ts', {
      root: REPO_ROOT,
    });
    expect(reachable.has('lib/workflows/dangerousGraphFixture')).toBe(true);
    expect(bannedReach(reachable)).toContain('node:crypto');
  });

  it('ban set prefix-matches the crypto/dns families: unprefixed and node: subpaths all fail closed (case 2b, adversarial L8)', () => {
    const g = tmpGraph({
      'crypto.ts': "import { createHash } from 'crypto';\nexport const h = createHash('sha256').update('x').digest('hex');",
      'webcrypto.ts': "import { webcrypto } from 'node:crypto/webcrypto';\nexport const w = webcrypto;",
      'dnspromises.ts': "import { promises as dns } from 'node:dns/promises';\nexport const r = dns;",
    });
    try {
      // Unprefixed `crypto` (legal Node builtin) must be a banned reach.
      const unprefixed = reachableImports('crypto.ts', { root: g.root });
      expect(unprefixed.has('crypto')).toBe(true);
      expect(bannedReach(unprefixed)).toContain('crypto');
      // `node:crypto/webcrypto` and `node:dns/promises` subpaths must be banned.
      const subpathCrypto = reachableImports('webcrypto.ts', { root: g.root });
      expect(subpathCrypto.has('node:crypto/webcrypto')).toBe(true);
      expect(bannedReach(subpathCrypto)).toContain('node:crypto/webcrypto');
      const subpathDns = reachableImports('dnspromises.ts', { root: g.root });
      expect(subpathDns.has('node:dns/promises')).toBe(true);
      expect(bannedReach(subpathDns)).toContain('node:dns/promises');
    } finally {
      g.close();
    }
  });

  it('type-only imports are NOT runtime deps of the bundle: `import type` from a banned module is not a banned reach, but a mixed import is (case 2c, B12 lock correctness)', () => {
    const g = tmpGraph({
      'typeonly.ts':
        "import type { T } from 'db/index';\nexport let t: T | undefined;",
      // Inline `{ a, type T }`: the bare `a` is a runtime value → the module ships.
      'mixed.ts':
        "import { a, type T } from 'db/index';\nexport const x = a;",
    });
    try {
      const typeOnly = reachableImports('typeonly.ts', { root: g.root });
      expect(typeOnly.has('typeonly')).toBe(true);
      // The type-only `db/index` specifier must NOT enter the closure.
      expect(bannedReach(typeOnly)).toEqual([]);
      const mixed = reachableImports('mixed.ts', { root: g.root });
      expect(mixed.has('db/index')).toBe(true);
      expect(bannedReach(mixed)).toContain('db/index');
    } finally {
      g.close();
    }
  });

  it('mutual cycle across two files terminates the walk (case 8)', () => {
    const g = tmpGraph({
      'a.ts': "import { b } from './b';\nexport const a = b;",
      'b.ts': "import { a } from './a';\nexport const b = a;",
    });
    try {
      const reachable = reachableImports('a.ts', { root: g.root });
      expect(reachable.has('a')).toBe(true);
      expect(reachable.has('b')).toBe(true);
    } finally {
      g.close();
    }
  });

  it('depth budget stops the walk even if more files exist (case 9)', () => {
    const g = tmpGraph({
      'a.ts': "import { b } from './b';\nexport const a = b;",
      'b.ts': "import { c } from './c';\nexport const b = c;",
      'c.ts': "import { d } from './d';\nexport const c = d;",
      'd.ts': 'export const d = 4;',
    });
    try {
      const shallow = reachableImports('a.ts', { root: g.root, maxDepth: 1 });
      expect(shallow.has('a')).toBe(true);
      // Direct import `b` is a reached value (1 hop) even at budget 1…
      expect(shallow.has('b')).toBe(true);
      // …but the walk does NOT expand into `b`, so `c` stays beyond the budget.
      expect(shallow.has('c')).toBe(false);
      const deeper = reachableImports('a.ts', { root: g.root, maxDepth: 4 });
      expect(deeper.has('a')).toBe(true);
      expect(deeper.has('d')).toBe(true);
    } finally {
      g.close();
    }
  });

  it('`require("pg")` is detected as a bare-specifier reach (case 10)', () => {
    const g = tmpGraph({
      'cjs.ts': "export const x = require('pg');",
    });
    try {
      const reachable = reachableImports('cjs.ts', { root: g.root });
      expect(reachable.has('pg')).toBe(true);
      expect(bannedReach(reachable)).toContain('pg');
    } finally {
      g.close();
    }
  });

  it('missing relative target continues the walk without throwing (case 11)', () => {
    const g = tmpGraph({
      'a.ts': "import { x } from './does-not-exist';\nexport const a = x;",
    });
    try {
      const reachable = reachableImports('a.ts', { root: g.root });
      expect(reachable.has('does-not-exist')).toBe(true);
      expect(reachable.has('a')).toBe(true);
    } finally {
      g.close();
    }
  });

  it("`'use step'` sibling that imports the world is NOT reached when the walk root is the workflow entry (case 12)", () => {
    const g = tmpGraph({
      'entry.ts': "import { sleep } from 'workflow';\nexport function entry() { 'use workflow'; return sleep('2s'); }",
      // A `'use step'` neighbor that imports a banned module. The entry's
      // closure does NOT reference it → scoped walk must not pull it in.
      'step.ts': "import { createHash } from 'node:crypto';\nexport function step() { 'use step'; void createHash('x'); }",
    });
    try {
      const reachable = reachableImports('entry.ts', { root: g.root });
      expect(reachable.has('workflow')).toBe(true);
      expect(reachable.has('step')).toBe(false);
      expect(bannedReach(reachable)).toEqual([]);
    } finally {
      g.close();
    }
  });

  it('`sleep` from `workflow` in the fixture is a bare, non-banned reach (case 13)', () => {
    const reachable = reachableImports('lib/workflows/staticWorkflowFixture.ts', {
      root: REPO_ROOT,
    });
    expect(reachable.has('workflow')).toBe(true);
    expect(bannedReach(reachable)).toEqual([]);
  });
});

describe('staticGraph — extractImports', () => {
  it('extracts named, side-effect, dynamic import and require specifiers', () => {
    const src = [
      "import { a } from 'pg';",
      "import * as crypto from 'node:crypto';",
      "import 'side-effect';",
      "const d = import('node:dns');",
      "const r = require('@/lib/mcp/urlPolicy');",
    ].join('\n');
    const specs = extractImports(src);
    expect(specs).toContain('pg');
    expect(specs).toContain('node:crypto');
    expect(specs).toContain('side-effect');
    expect(specs).toContain('node:dns');
    expect(specs).toContain('@/lib/mcp/urlPolicy');
  });

  it('ignores doc-comment mentions (must not read as imports)', () => {
    const src = "// A comment saying `from 'pg'` must not count.\nimport { x } from 'workflow';";
    const specs = extractImports(src);
    expect(specs).not.toContain('pg');
    expect(specs).toContain('workflow');
  });
});

// Satisfy the `afterEach` import / keep the graph close helper reachable even
// though most graphs close in their own `finally`.
afterEach(() => {
  /* graphs clean themselves via their `close()` inside each test */
});
