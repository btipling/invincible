import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Locks `.github/workflows/int-durable.yml` against the CI miss on PR #861:
 * `GITHUB_TOKEN` is not a default runner env var, so fetch-harness must be
 * given `${{ github.token }}` (or `secrets.GITHUB_TOKEN`) explicitly.
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

  it('fetches latest main artifact (wait off, require on, no commit pin)', () => {
    expect(WORKFLOW).toMatch(/HARNESS_WAIT_MS:\s*"0"/);
    expect(WORKFLOW).toMatch(/HARNESS_REQUIRE:\s*"1"/);
    expect(WORKFLOW).not.toMatch(/HARNESS_COMMIT_SHA/);
    expect(WORKFLOW).not.toMatch(/^\s*HARNESS_ARTIFACT_TOKEN:/m);
  });

  it('runs on ubuntu-latest, never self-hosted, never continue-on-error', () => {
    expect(WORKFLOW).toMatch(/runs-on:\s*ubuntu-latest/);
    expect(WORKFLOW).not.toMatch(/self-hosted/);
    expect(WORKFLOW).not.toMatch(/continue-on-error/);
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
