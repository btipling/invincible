#!/usr/bin/env node
/**
 * di-gate — static enforcement that module bodies never construct I/O directly.
 *
 * Phase 3 (parent #438 / #441). Scans the app/lib/scripts source trees (plus
 * `auth.ts` / `middleware.ts`) for the **DB seam** constructors Phase 3 can
 * guarantee:
 *
 *   - `createDbConnection(`   — the real Postgres opener (defined in `db/index.ts`)
 *   - `new PGlite(`           — the in-memory test engine (self-hosted in
 *                               `lib/tenancy/test/shared.ts` only)
 *
 * Any occurrence of those symbols in a module body (i.e. NOT in a comment, NOT
 * in an allowlisted root/helper) is a phase failure.
 *
 * Scope decision (locked in the phase-3 plan): this phase's gate bans only the
 * **DB seam**. The Phase-2 surface (`Sandbox.get(`, `createClient(` in
 * sandbox/http/redis/mcp) is still legitimate until Phase 2 (#439) lands, so
 * those rules are deferred. See `AGENTS.md` "where to change" + the di-gate
 * entry in `package.json`.
 *
 * Allowlisted roots/helpers:
 *   - `db/index.ts`            — owns `createDbConnection(` (the real opener)
 *   - `lib/di/index.ts`        — composition root: the only call site of
 *                                 `createDbConnection(` in production code
 *   - `lib/tenancy/test/shared.ts` — owns the single `new PGlite(` test engine
 *
 * This is a pure static grep (no vitest wrapper). It exits 0 when the scan is
 * clean and 1 (with offenders) otherwise.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const ROOTS = ['app', 'lib', 'scripts', 'auth.ts', 'middleware.ts'];
const EXTS = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs']);

/** Paths (forward-slash, repo-relative) that are allowed to contain the symbols. */
const ALLOWLIST = new Set([
  'db/index.ts',
  'lib/di/index.ts',
  'lib/tenancy/test/shared.ts',
  // The gate itself defines the rule strings (symbol + regex), so it must not
  // flag its own definitions.
  'scripts/di-gate.mjs',
]);

const PATTERNS = [
  { symbol: 'createDbConnection(', regex: /createDbConnection\s*\(/g },
  { symbol: 'new PGlite(', regex: /new\s+PGlite\s*\(/g },
];

function isSourceFile(name) {
  return EXTS.has(name.slice(name.lastIndexOf('.')));
}

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else if (isSourceFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip line (`//`) and block (`/block` + `block/`) comments enough that doc
 * text mentioning a constructor is not treated as a body occurrence, while any
 * real call-site is preserved. Strings are left intact; the anomalies we care
 * about are code, not strings, so this is a safe approximation for a gate.
 */
function stripComments(src) {
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
      i += 2; // skip closing */
      if (i > n) i = n;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function main() {
  const offenders = [];
  for (const root of ROOTS) {
    let files = [];
    if (statSync(root).isFile()) {
      files = [root];
    } else {
      files = collectFiles(root);
    }
    for (const file of files) {
      const rel = file.split(sep).join('/');
      if (ALLOWLIST.has(rel)) continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const { symbol, regex } of PATTERNS) {
        if (regex.test(src)) {
          regex.lastIndex = 0;
          let lineNo = 1;
          for (const line of src.split('\n')) {
            if (line.includes(symbol)) {
              offenders.push(
                `${rel}:${lineNo} — ${symbol.trim()} (module body must not construct I/O directly)`,
              );
            }
            lineNo++;
          }
        }
      }
    }
  }

  const unique = [...new Set(offenders)];
  if (unique.length > 0) {
    console.error('di-gate FAILED — direct I/O construction found in module bodies:');
    for (const o of unique) console.error(`  ${o}`);
    console.error(
      '\nAllowed only in: db/index.ts, lib/di/index.ts, lib/tenancy/test/shared.ts.',
    );
    process.exit(1);
  }
  console.log(
    'di-gate OK — no in-body createDbConnection(/new PGlite( outside allowlisted roots.',
  );
}

main();
