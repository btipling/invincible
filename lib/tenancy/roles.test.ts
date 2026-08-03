import { describe, expect, it } from 'vitest';
import { canAccessAdmin, canRotateSandboxToken } from './roles';

describe('tenant roles', () => {
  it('canAccessAdmin allows owner and admin only', () => {
    expect(canAccessAdmin('owner')).toBe(true);
    expect(canAccessAdmin('admin')).toBe(true);
    expect(canAccessAdmin('member')).toBe(false);
    expect(canAccessAdmin(null)).toBe(false);
    expect(canAccessAdmin(undefined)).toBe(false);
  });

  it('canRotateSandboxToken is owner only', () => {
    expect(canRotateSandboxToken('owner')).toBe(true);
    expect(canRotateSandboxToken('admin')).toBe(false);
    expect(canRotateSandboxToken('member')).toBe(false);
  });
});
