import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Enforces the adversarial review PR #786 Minor L2 rule on
 * `.github/workflows/workflows-smoke.yml`: GitHub expression substitution
 * (`${{ inputs.* }}`) is NOT shell-escaped, so no dispatch input may be
 * interpolated into a `run:` script body (expression→shell injection).
 *
 * `${{ }}` IS allowed in `if:`/`name:`/`env:` positions (expression context,
 * not shell). This test scans every `run:` step's script body and fails if any
 * body line references a dispatch input directly.
 */
const WORKFLOW = readFileSync(
  new URL('../.github/workflows/workflows-smoke.yml', import.meta.url),
  'utf8',
);

function runBlockLineRanges(lines: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*run:\s*(|>|\||\|-\|\||\|\+)$/.test(line)) {
      const baseIndent = line.match(/^\s*/)?.[0].length ?? 0;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next.trim() === '') {
          j++;
          continue;
        }
        const indent = next.match(/^\s*/)?.[0].length ?? 0;
        if (indent <= baseIndent) break;
        j++;
      }
      ranges.push({ start: i, end: j });
      i = j - 1;
    }
  }
  return ranges;
}

describe('workflows-smoke.yml — no expression→shell injection', () => {
  it('never interpolates `${{ inputs.* }}` into any `run:` script body', () => {
    const lines = WORKFLOW.split('\n');
    const runs = runBlockLineRanges(lines);
    expect(runs.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const { start, end } of runs) {
      for (let k = start + 1; k < end; k++) {
        if (/\$\{\{\s*inputs\./.test(lines[k])) {
          offenders.push(`L${k + 1}: ${lines[k].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still passes dispatch inputs through env (expression context), not the shell', () => {
    // The three dispatch inputs must be surfaced via an `env:` mapping so the
    // `run:` scripts can reference quoted env vars instead of interpolating.
    expect(WORKFLOW).toContain('SMOKE_CONFIRM: ${{ inputs.confirm }}');
    expect(WORKFLOW).toContain('SMOKE_ENV: ${{ inputs.environment }}');
    expect(WORKFLOW).toContain('SMOKE_URL: ${{ inputs.url }}');
  });

  it('confirms the shell guard/probe/summary reference the env vars, not the inputs', () => {
    expect(WORKFLOW).toMatch(/"\$SMOKE_CONFIRM"/);
    expect(WORKFLOW).toMatch(/"\$SMOKE_ENV"/);
    expect(WORKFLOW).toMatch(/"\$SMOKE_URL"/);
  });
});
