import { describe, expect, it } from 'vitest';
import { AUTH_REQUIRED_ERROR, SANDBOX_FORBIDDEN_ERROR } from './errors';

describe('tenancy error constants', () => {
  it('locks parent AUTH_REQUIRED_ERROR string', () => {
    expect(AUTH_REQUIRED_ERROR).toBe('Authentication required.');
  });

  it('locks parent SANDBOX_FORBIDDEN_ERROR string', () => {
    expect(SANDBOX_FORBIDDEN_ERROR).toBe('Sandbox access denied.');
  });
});
