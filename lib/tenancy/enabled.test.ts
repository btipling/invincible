import { describe, expect, it } from 'vitest';
import { tenancyEnabled } from './enabled';

describe('tenancyEnabled', () => {
  it('is false when all missing', () => {
    expect(tenancyEnabled({})).toBe(false);
  });

  it('is false when any of the three is missing', () => {
    expect(
      tenancyEnabled({
        DATABASE_URL: 'postgres://x',
        AUTH_SECRET: 's',
      }),
    ).toBe(false);
    expect(
      tenancyEnabled({
        DATABASE_URL: 'postgres://x',
        CREDENTIALS_ENCRYPTION_KEY: 'k',
      }),
    ).toBe(false);
    expect(
      tenancyEnabled({
        AUTH_SECRET: 's',
        CREDENTIALS_ENCRYPTION_KEY: 'k',
      }),
    ).toBe(false);
  });

  it('is false for whitespace-only values', () => {
    expect(
      tenancyEnabled({
        DATABASE_URL: '  ',
        AUTH_SECRET: 's',
        CREDENTIALS_ENCRYPTION_KEY: 'k',
      }),
    ).toBe(false);
  });

  it('is true when all three are non-empty', () => {
    expect(
      tenancyEnabled({
        DATABASE_URL: 'postgres://x',
        AUTH_SECRET: 'secret',
        CREDENTIALS_ENCRYPTION_KEY: 'key',
      }),
    ).toBe(true);
  });
});
