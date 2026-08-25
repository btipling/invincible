import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Static import-closure checker (backend-agents B11, plan #805).
 *
 * Given a TS/TSX source file that is a `"use workflow"` entry, recursively
 * resolve its *static* ESM `import` / `require` closure and return the set of
 * every module it transports. The regression seed
 * (`lib/workflows/staticGraph.test.ts`) asserts that the closure of a clean
 * workflow fixture reaches **zero** of the banned Workflow-bundle surface
 * (`pg` / `postgres` / `node:crypto` / `node:dns` / `db/**` / `lib/mcp/**` /
 * the Blob-store modules), and that a deliberately-leaky fixture is caught.
 *
 * This is the "deploy-gate lock" from POST-MORTEM §2 (#710): a Workflow bundle
 * that pulls a DB driver / crypto / dns / MCP / Blob-store module into the
 * canvas must fail. Scope is the **workflow-entry closure only** — `'use step'`
 * bodies may import the world, and a naive repo-wide grep is forbidden (it
 * would false-positive on legit `node:crypto` / `node:dns` in tenancy/sandbox
 * and on allowlisted steps). The caller passes an *explicit root file*; the
 * walker never scans a directory.
 *
 * `node:fs`-only (`readFileSync` / `existsSync` / `statSync`), no module
 * loader, no `fetch`, no in-body I/O constructors → di-gate clean. It never
 * imports/executes the modules it walks; it only reads their source and
 * resolves the static specifiers.
 */

/** Test-only walk budget (not a runtime cap — plan #805 cap table stays empty). */
export const MAX_IMPORT_RESOLUTION_DEPTH = 32;

export interface StaticGraphOptions {
  /**
   * Repo root directory. `@/` aliases and relative-specifier normalization
   * resolve relative to this. Defaults to `process.cwd()`.
   */
  root?: string;
  /** Max recursion depth for the import closure walk. Defaults to {@link MAX_IMPORT_RESOLUTION_DEPTH}. */
  maxDepth?: number;
}

/** Source extensions the resolver understands, in priority order. */
const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];
/** Directory-index candidates when a specifier resolves to a folder. */
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Normalize a path to forward slashes (canonical value form / cycle key). */
function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Root-relative, extension-stripped canonical value for a resolved project
 * file (or a missing candidate). e.g. `/repo/lib/workflows/dep.ts` →
 * `lib/workflows/dep`. This is the shape the regression's ban set matches
 * against (`db/**`, `lib/mcp/**`, `lib/sessions/blobStore`, …).
 */
function rootRelValue(absPath: string, root: string): string {
  const rootNorm = root.endsWith(sep) ? root : root + sep;
  const rel = absPath.startsWith(rootNorm) ? absPath.slice(rootNorm.length) : toPosix(absPath);
  let trimmed = rel.replace(/^[\\/]+/, '');
  const e = extname(trimmed);
  if (TS_EXTS.includes(e)) trimmed = trimmed.slice(0, trimmed.length - e.length);
  return toPosix(trimmed);
}

/** Try to resolve a filesystem base path to a real file (extensions, `.js`→`.ts`, dir index). */
export function resolveFile(base: string): string | null {
  if (isFile(base)) return base;
  // `.js` / `.jsx` specifier → the underlying `.ts` / `.tsx` (matrix case 7).
  const jsStem = /\.(js|jsx)$/.exec(base);
  if (jsStem) {
    const stem = base.slice(0, base.length - jsStem[0].length);
    for (const ext of ['.ts', '.tsx']) {
      if (isFile(stem + ext)) return stem + ext;
    }
  }
  for (const ext of TS_EXTS) {
    if (isFile(base + ext)) return base + ext;
  }
  for (const idx of INDEX_FILES) {
    if (isFile(join(base, idx))) return join(base, idx);
  }
  return null;
}

/**
 * Resolve one import/require specifier to its canonical value:
 * - bare specifier (`pg`, `node:crypto`, `workflow`, `postgres`) → the bare name itself;
 * - `@/x` alias → root-relative path (e.g. `@/lib/mcp/urlPolicy` → `lib/mcp/urlPolicy`);
 * - relative `./x` / `../x` → root-relative path relative to the importing file.
 *
 * Never loads the module; it only emits a canonical destination string.
 */
export function resolveImport(spec: string, fromFile: string, root: string): string {
  const trimmed = spec.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === '..') return trimmed;
  const isBare = !(trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('@/'));
  if (isBare) return trimmed;
  if (trimmed.startsWith('@/')) {
    return rootRelValue(join(root, trimmed.slice(2)), root);
  }
  const base = resolve(dirname(fromFile), trimmed);
  return rootRelValue(resolveFile(base) ?? base, root);
}

function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/');
}

/** Absolute path of the local file a specifier transports, or null for bare modules. */
function localFile(spec: string, fromFile: string, root: string): string | null {
  const base = spec.startsWith('@/') ? join(root, spec.slice(2)) : resolve(dirname(fromFile), spec);
  return resolveFile(base);
}

/**
 * Strip `//` and `/* *​/` comments (doc-bodies must not read as imports) while
 * keeping string literals intact. Mirrors the di-gate approximation.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      if (i > n) i = n;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * True when an import/export clause (the text between `import|export` and the
 * trailing `from`) is **type-only**, i.e. adds no runtime value to the bundle:
 * - `type Foo`, `type { A }`, `type * as ns` (leading `type` keyword);
 * - `{ type A, type B }` (every braced member is inline `type`-qualified).
 * A mixed clause (`{ a, type B }`) is a runtime dep — the bare `a` ships.
 */
function isTypeOnlyImportClause(clause: string): boolean {
  const c = clause.trim();
  if (/^type\b/.test(c)) return true;
  if (!c.startsWith('{')) return false;
  const inner = c.slice(c.indexOf('{') + 1, c.lastIndexOf('}'));
  const members = inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (members.length === 0) return false;
  return members.every((s) => /^type\b/.test(s));
}

/**
 * Extract the **runtime** static specifiers in a source file — the closure the
 * Workflows bundle actually transports: every `import … from 'x'` /
 * `export … from 'x'` that is NOT type-only, side-effect `import 'x'`, dynamic
 * `import('x')`, and CommonJS `require('x')`.
 *
 * Type-only imports (`import type { T } from 'x'`, inline `{ type T }`) are
 * erased at compile time and never appear in the canvas bundle, so the deploy
 * gate must NOT track them — following them false-flags any module that merely
 * type-imports a heavy barrel (plan #805 lock correctness; B12 entry closure).
 */
export function extractImports(src: string): string[] {
  const clean = stripComments(src);
  const out = new Set<string>();

  // Dynamic import('x') and CommonJS require('x') — always runtime deps.
  let m: RegExpExecArray | null;
  const dynamicRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynamicRe.exec(clean)) !== null) out.add(m[1]);

  // Side-effect `import 'x'` (no clause, no `from`) — runtime dep.
  const sideRe = /(?:^|[;\n])\s*import\s+['"]([^'"]+)['"]/g;
  while ((m = sideRe.exec(clean)) !== null) out.add(m[1]);

  // `import|export <clause> from 'x'` — runtime unless the clause is type-only.
  const fromRe = /\b(?:import|export)\s+([a-zA-Z0-9_$*{},\s:]+?)\s+from\s+['"]([^'"]+)['"]/g;
  while ((m = fromRe.exec(clean)) !== null) {
    if (!isTypeOnlyImportClause(m[1])) out.add(m[2]);
  }

  return [...out];
}

function absRoot(path: string, root: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * Return the set of every canonical destination reachable from `entry`'s
 * static import/require closure, including bare specifiers and the entry
 * itself. Cycle-safe (visited set on canon path) and depth-bounded.
 */
export function reachableImports(entry: string, options: StaticGraphOptions = {}): Set<string> {
  const root = options.root ?? (process.cwd() ?? '.');
  const maxDepth = options.maxDepth ?? MAX_IMPORT_RESOLUTION_DEPTH;
  const visited = new Set<string>();
  const reachable = new Set<string>();

  const entryAbs = absRoot(entry, root);

  const walk = (abs: string, depth: number): void => {
    const file = resolveFile(abs);
    if (!file) {
      reachable.add(rootRelValue(abs, root));
      return;
    }
    const key = rootRelValue(file, root);
    if (visited.has(key)) return; // cycle / repeat guard
    visited.add(key);
    reachable.add(key);
    if (depth >= maxDepth) return;
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    // 'use step' files are leaves — their bodies are a different bundle
    // (Vercel Workflows step VM). Record the file but do NOT follow its
    // imports, exactly as the B11 comment prescribes. Without this gate,
    // in-step re-resolve cannot import Blob/DI without breaking the
    // workflow-entry deploy-gate lock.
    //
    // Guard: only skip when depth > 0 (a dependency, not the entry itself).
    // A 'use workflow' entry may define its own local 'use step' function
    // (e.g. staticWorkflowFixture) — skipping the entry's own imports would
    // break reachability. The directive is only a leaf-gate for IMPORTED
    // step modules.
    //
    // STRIP COMMENTS FIRST: a `'use step'` / `"use step"` string inside a
    // comment (doc-body, line-comment) must NOT leaf-trim. Otherwise a helper
    // like `turnLoop.ts` whose doc-comment mentions `'use step'` gets treated
    // as a step leaf, and its banned imports are silently ignored (deploy-gate
    // fail-open). Comment-stripping mirrors extractImports.
    const stepLeafSrc = stripComments(src);
    const hasRealStepDirective =
      stepLeafSrc.includes("'use step'") || stepLeafSrc.includes('"use step"');
    if (depth > 0 && hasRealStepDirective) return;

    for (const spec of extractImports(src)) {
      const value = resolveImport(spec, file, root);
      reachable.add(value);
      if (isLocalSpecifier(spec)) {
        const next = localFile(spec, file, root);
        if (next) walk(next, depth + 1);
      }
    }
  };

  walk(entryAbs, 0);
  return reachable;
}
