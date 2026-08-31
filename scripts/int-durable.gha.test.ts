import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Locks `.github/workflows/int-durable.yml` against:
 * - CI miss on PR #861: `GITHUB_TOKEN` is not a default runner env var, so
 *   fetch-harness must be given `${{ github.token }}` explicitly.
 * - Protocol-bump miss on PR #902: wait off + latest main Wasm meant
 *   REQUIRED_FNS fail-closed on missing new exports. Must wait for the PR
 *   head SHA and download `harness-wasm-pr-N` (never the production name).
 */
const WORKFLOW = readFileSync(
  new URL('../.github/workflows/int-durable.yml', import.meta.url),
  'utf8',
);
const PKG = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

describe('int-durable.yml — fetch-harness token + runner lock', () => {
  it('wires GITHUB_TOKEN from github.token (not a default runner env var)', () => {
    expect(WORKFLOW).toMatch(/GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  });

  it('grants actions: read so the token can list/download harness-wasm', () => {
    expect(WORKFLOW).toMatch(/permissions:[\s\S]*actions:\s*read/);
  });

  it('waits for commit-matched harness (PR head SHA + pr artifact; require on)', () => {
    expect(WORKFLOW).toMatch(/HARNESS_WAIT_MS:\s*"720000"/);
    expect(WORKFLOW).toMatch(/HARNESS_REQUIRE:\s*"1"/);
    expect(WORKFLOW).toMatch(
      /HARNESS_COMMIT_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.sha\s*\}\}/,
    );
    expect(WORKFLOW).toMatch(
      /HARNESS_PR_NUMBER:\s*\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/,
    );
    expect(WORKFLOW).not.toMatch(/^\s*HARNESS_ARTIFACT_TOKEN:/m);
  });

  it('runs on ubuntu-latest, never self-hosted, never continue-on-error', () => {
    expect(WORKFLOW).toMatch(/runs-on:\s*ubuntu-latest/);
    expect(WORKFLOW).not.toMatch(/self-hosted/);
    expect(WORKFLOW).not.toMatch(/continue-on-error/);
  });

  it('skips fork PRs (same-repo head only)', () => {
    expect(WORKFLOW).toMatch(
      /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/,
    );
  });
});

describe('package.json — int project is not in the default/changed gates', () => {
  it('npm test and test:changed pass --project default --project tenancy', () => {
    expect(PKG.scripts.test).toMatch(/vitest run --project default --project tenancy/);
    expect(PKG.scripts['test:changed']).toMatch(
      /vitest run --changed --project default --project tenancy/,
    );
  });

  it('test:int is vitest --project int (no wrapper)', () => {
    expect(PKG.scripts['test:int']).toBe('vitest run --project int');
  });
});
