#!/usr/bin/env node
/**
 * di-gate — static enforcement that module bodies never construct I/O directly.
 *
 * Phase 3 (parent #438 / #441) + Phase 2 (#439). Scans the app/lib/scripts
 * source trees (plus `auth.ts` / `middleware.ts`) for **external-I/O constructors**
 * that belong only in the composition root / factory-owner modules / grant-boundary
 * lifecycle modules / test factories:
 *
 *   DB seam (phase 3):
 *     - `createDbConnection(` — the real Postgres opener (defined in `db/index.ts`)
 *     - `new PGlite(`         — the in-memory test engine (owned by
 *                               `lib/tenancy/test/shared.ts` only)
 *   Sandbox / HTTP / Redis seam (phase 2, #439):
 *     - `Sandbox.get(`            — `@vercel/sandbox` attach (factory owners +
 *                                   userSandboxInstance lifecycle + orphan GHA)
 *     - `createClient(`           — node-redis RESP client (redisSessionStore) —
 *                                   MCP's own client is a separate, deferred owner
 *     - `new RedisSessionStore(`  — the session store (root binds the factory)
 *     - `createSandboxClient(`    — BYO sandbox client (factory owner + root)
 *     - `createVercelSandboxClient(`  — Vercel-FS sandbox client (factory owner + root)
 *     - `createVercelSandboxHttpRunner(` — hop-B HTTP runner (factory owner + root)
 *
 * Any occurrence of those symbols in a module body (i.e. NOT in a comment, NOT in
 * an allowlisted root/owner/helper, NOT in a test file) is a phase failure.
 *
 * Allowlisted roots/helpers:
 *   - `db/index.ts`                    — owns `createDbConnection(`
 *   - `lib/di/index.ts`                — composition root (constructs everything)
 *   - `lib/tenancy/test/shared.ts`     — owns the single `new PGlite(` test engine
 *   - `lib/sandbox/client.ts`          — owns `createSandboxClient(`
 *   - `lib/sandbox/vercelClient.ts`    — owns `createVercelSandboxClient(` + `Sandbox.get(`
 *   - `lib/agent/vercelSandboxHttpRunner.ts` — owns `createVercelSandboxHttpRunner(` + `Sandbox.get(`
 *   - `lib/sessions/redisSessionStore.ts`    — owns the RESP `createClient(` adapter
 *   - `lib/tenancy/userSandboxInstance.ts`   — durable-instance attach boundary (`Sandbox.get(`)
 *   - `scripts/sandbox-orphan-cleanup.mjs`   — orphan GHA attach helper (`Sandbox.get(`)
 *   - `lib/mcp/client.ts`              — MCP client owner (deferred to MCP phase)
 *   - `scripts/di-gate.mjs`            — the gate defines the rule strings itself
 *   - `*.test.*` / `*.spec.*`          — test factories (inject / construct freely)
 *
 * This is a pure static grep (no vitest wrapper). It exits 0 when the scan is
 * clean and 1 (with offenders) otherwise.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const ROOTS = ['app', 'lib', 'scripts', 'auth.ts', 'middleware.ts'];
const EXTS = new Set(['.ts', '.mts', '.js', '.mjs', '.cjs']);
const TEST_RE = /\.(test|spec)\.(ts|mts|js|mjs|cjs)$/;

/** Paths (forward-slash, repo-relative) that are allowed to contain the symbols. */
const ALLOWLIST = new Set([
  'db/index.ts',
  'lib/di/index.ts',
  'lib/tenancy/test/shared.ts',
  // Sandbox / HTTP / Redis factory owners + lifecycle boundaries (phase 2).
  'lib/sandbox/client.ts',
  'lib/sandbox/vercelClient.ts',
  'lib/agent/vercelSandboxHttpRunner.ts',
  'lib/sessions/redisSessionStore.ts',
  'lib/tenancy/userSandboxInstance.ts',
  'scripts/sandbox-orphan-cleanup.mjs',
  // MCP client construction is deferred to the MCP-owner phase (separate owner).
  'lib/mcp/client.ts',
  // The gate itself defines the rule strings (symbol + regex), so it must not
  // flag its own definitions.
  'scripts/di-gate.mjs',
]);

const PATTERNS = [
  // DB seam (phase 3).
  { symbol: 'createDbConnection(', regex: /createDbConnection\s*\(/g },
  { symbol: 'new PGlite(', regex: /new\s+PGlite\s*\(/g },
  // Sandbox / HTTP / Redis seam (phase 2, #439).
  // eslint-disable-next-line no-useless-escape
  { symbol: 'Sandbox.get(', regex: /Sandbox\s*\.\s*get\s*\(/g },
  { symbol: 'createClient(', regex: /createClient\s*\(/g },
  { symbol: 'new RedisSessionStore(', regex: /new\s+RedisSessionStore\s*\(/g },
  { symbol: 'createSandboxClient(', regex: /createSandboxClient\s*\(/g },
  { symbol: 'createVercelSandboxClient(', regex: /createVercelSandboxClient\s*\(/g },
  { symbol: 'createVercelSandboxHttpRunner(', regex: /createVercelSandboxHttpRunner\s*\(/g },
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
      // Test factories construct / inject freely (phase-2 scoped allowlist).
      if (TEST_RE.test(rel)) continue;
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
      '\nAllowed only in: db/index.ts, lib/di/index.ts, factory-owner modules, ' +
        'lib/tenancy/userSandboxInstance.ts, scripts/sandbox-orphan-cleanup.mjs, ' +
        'lib/mcp/client.ts, lib/tenancy/test/shared.ts, and test files (*.test.* / *.spec.*).',
    );
    process.exit(1);
  }
  console.log(
    'di-gate OK — no in-body I/O construction (DB / sandbox / HTTP / Redis) outside allowlisted roots.',
  );
}

main();
