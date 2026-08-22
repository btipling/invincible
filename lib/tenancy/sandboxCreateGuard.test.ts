import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Epic #298: Sandbox.create and getOrCreate only in the lifecycle domain module.
 * Agent, hop-B, resolve, Settings, and scripts must never call create.
 */
const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));

const ALLOW_CREATE_PATHS = new Set([
  'lib/tenancy/userSandboxInstance.ts',
]);

const CREATE_PATTERNS = [
  /Sandbox\.create\s*\(/,
  /Sandbox\.getOrCreate\s*\(/,
  /\.getOrCreate\s*\(/,
];

/** Product trees that must not introduce create/getOrCreate outside the allowlist. */
const SCAN_ROOTS = ['app', 'lib', 'scripts', 'sandbox'];

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // Skip dependency/version-control/build trees AND generated SDK scaffolding:
    // the `workflow` SDK (wired in app via withWorkflow) emits a fully-gitignored
    // `app/.well-known/workflow/` route tree at build/runtime whose vendored
    // server code mentions `.getOrCreate(` — that is generated output, not the
    // product source this invariant scans (same rationale as `dist`).
    if (
      name === 'node_modules' ||
      name === '.git' ||
      name === 'dist' ||
      name === '.well-known'
    ) {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
      continue;
    }
    // TS product + JS scripts that may import @vercel/sandbox
    if (!/\.(ts|tsx|mjs|js|cjs)$/.test(name)) continue;
    if (/\.test\.(ts|tsx|mjs|js)$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

function relFromRoot(file: string): string {
  return relative(ROOT, file).replace(/\\/g, '/');
}

describe('sandbox create/getOrCreate allowlist (#298)', () => {
  it('forbids Sandbox.create / getOrCreate outside userSandboxInstance', () => {
    const offenders: string[] = [];
    const missingRoots: string[] = [];
    for (const rootName of SCAN_ROOTS) {
      const root = join(ROOT, rootName);
      try {
        statSync(root);
      } catch {
        // Fail closed: a declared root that vanished would silently skip that tree.
        missingRoots.push(rootName);
        continue;
      }
      for (const file of walkSourceFiles(root)) {
        const rel = relFromRoot(file);
        const text = readFileSync(file, 'utf8');
        const hit = CREATE_PATTERNS.some((re) => re.test(text));
        if (!hit) continue;
        if (ALLOW_CREATE_PATHS.has(rel)) continue;
        offenders.push(rel);
      }
    }
    expect(
      missingRoots,
      `SCAN_ROOT missing on disk (would skip create scan): ${missingRoots.join(', ')}`,
    ).toEqual([]);
    expect(offenders, `create/getOrCreate outside allowlist: ${offenders.join(', ')}`).toEqual(
      [],
    );
  });

  it('lifecycle module is the only allowlisted create site and still creates', () => {
    const lifecycle = join(ROOT, 'lib/tenancy/userSandboxInstance.ts');
    const text = readFileSync(lifecycle, 'utf8');
    expect(text).toMatch(/Sandbox\.create\s*\(/);
    expect(text).not.toMatch(/Sandbox\.getOrCreate\s*\(/);
    expect(text).not.toMatch(/\.getOrCreate\s*\(/);
  });

  it('orphan cleanup script never creates or getOrCreates', () => {
    const script = join(ROOT, 'scripts/sandbox-orphan-cleanup.mjs');
    const text = readFileSync(script, 'utf8');
    expect(text).not.toMatch(/Sandbox\.create\s*\(/);
    expect(text).not.toMatch(/getOrCreate\s*\(/);
  });

  it('scans scripts/ and sandbox/ trees (not only app/lib)', () => {
    expect(SCAN_ROOTS).toEqual(expect.arrayContaining(['app', 'lib', 'scripts', 'sandbox']));
    for (const rootName of SCAN_ROOTS) {
      expect(
        () => statSync(join(ROOT, rootName)),
        `missing SCAN_ROOT on disk: ${rootName}`,
      ).not.toThrow();
    }
    // Prove walk actually visits the create-adjacent orphan script and sandbox tree.
    const scriptFiles = walkSourceFiles(join(ROOT, 'scripts')).map(relFromRoot);
    const sandboxFiles = walkSourceFiles(join(ROOT, 'sandbox')).map(relFromRoot);
    expect(scriptFiles).toContain('scripts/sandbox-orphan-cleanup.mjs');
    expect(sandboxFiles.length).toBeGreaterThan(0);
  });
});
