import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parent #298 / phase 5: Sandbox.create and getOrCreate only in the lifecycle
 * domain module. Agent, hop-B, resolve, and Settings must never call create.
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

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.(ts|tsx)$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

describe('sandbox create/getOrCreate allowlist (#298 phase 5)', () => {
  it('forbids Sandbox.create / getOrCreate outside userSandboxInstance', () => {
    const roots = [join(ROOT, 'app'), join(ROOT, 'lib')];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walkTsFiles(root)) {
        const rel = relative(ROOT, file).replace(/\\/g, '/');
        const text = readFileSync(file, 'utf8');
        const hit = CREATE_PATTERNS.some((re) => re.test(text));
        if (!hit) continue;
        if (ALLOW_CREATE_PATHS.has(rel)) continue;
        offenders.push(rel);
      }
    }
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
});
