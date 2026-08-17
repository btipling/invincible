import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('SessionPicker', () => {
  it('has no <select> / Switch session leftover', () => {
    const src = readFileSync(join(here, 'SessionPicker.tsx'), 'utf8');
    expect(src).not.toMatch(/<select\b/);
    expect(src).not.toContain('Switch session');
    expect(src).toContain('New session');
  });
});
