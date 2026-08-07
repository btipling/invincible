import { describe, expect, it } from 'vitest';
import {
  acceptInlineTex,
  extractCandidateMath,
  harnessMathPutOkSize,
  harnessMathSessionGeneration,
  isCurrencyLike,
  MAX_MATH_CACHE_ENTRIES,
  MAX_TEX_LEN,
  resetHarnessMathSession,
} from './harnessMath';

describe('isCurrencyLike / acceptInlineTex', () => {
  it('rejects money', () => {
    expect(isCurrencyLike('5')).toBe(true);
    expect(isCurrencyLike('10')).toBe(true);
    expect(isCurrencyLike('1,234.56')).toBe(true);
    expect(acceptInlineTex('5')).toBe(false);
    expect(acceptInlineTex('10')).toBe(false);
  });

  it('accepts formulas', () => {
    expect(acceptInlineTex('E=mc^2')).toBe(true);
    expect(acceptInlineTex('\\frac{a}{b}')).toBe(true);
    expect(acceptInlineTex('x_i')).toBe(true);
  });

  it('rejects oversize', () => {
    expect(acceptInlineTex('x'.repeat(MAX_TEX_LEN + 1))).toBe(false);
  });
});

describe('extractCandidateMath', () => {
  it('extracts inline and display', () => {
    const md = `
energy $E=mc^2$ free
$$
\\int_0^1 x
$$
same $$\\sum n$$ end
`;
    const got = extractCandidateMath(md);
    expect(got.some((c) => c.tex === 'E=mc^2' && !c.display)).toBe(true);
    expect(got.some((c) => c.display && c.tex.includes('\\int'))).toBe(true);
    expect(got.some((c) => c.display && c.tex.includes('\\sum'))).toBe(true);
  });

  it('trims interior whitespace (host/Wasm key parity)', () => {
    const got = extractCandidateMath('see $ E=mc^2 $ here');
    expect(got).toEqual([{ tex: 'E=mc^2', display: false }]);
  });

  it('skips currency and code/fences', () => {
    const md = `
costs $5 and $10 today
code \`$E=mc^2$\`
\`\`\`
$x$
\`\`\`
`;
    const got = extractCandidateMath(md);
    expect(got).toEqual([]);
  });

  it('dedupes', () => {
    const md = '$E=mc^2$ and again $E=mc^2$';
    const got = extractCandidateMath(md);
    expect(got.filter((c) => c.tex === 'E=mc^2')).toHaveLength(1);
  });
});

describe('resetHarnessMathSession', () => {
  it('bumps generation and clears putOk', () => {
    const before = harnessMathSessionGeneration();
    resetHarnessMathSession();
    expect(harnessMathSessionGeneration()).toBe(before + 1);
    expect(harnessMathPutOkSize()).toBe(0);
    expect(MAX_MATH_CACHE_ENTRIES).toBe(48);
  });
});
