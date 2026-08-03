import { describe, expect, it } from 'vitest';
import { effectiveGrantPermissions, isUsableGrant } from './grants';

describe('effectiveGrantPermissions', () => {
  it('write implies read', () => {
    expect(effectiveGrantPermissions({ canRead: false, canWrite: true })).toEqual({
      canRead: true,
      canWrite: true,
    });
  });

  it('read-only stays read-only', () => {
    expect(effectiveGrantPermissions({ canRead: true, canWrite: false })).toEqual({
      canRead: true,
      canWrite: false,
    });
  });

  it('neither is no access', () => {
    expect(effectiveGrantPermissions({ canRead: false, canWrite: false })).toEqual({
      canRead: false,
      canWrite: false,
    });
  });
});

describe('isUsableGrant', () => {
  it('requires active sandbox and some capability', () => {
    expect(isUsableGrant('active', { canRead: true, canWrite: false })).toBe(true);
    expect(isUsableGrant('active', { canRead: false, canWrite: true })).toBe(true);
    expect(isUsableGrant('active', { canRead: false, canWrite: false })).toBe(false);
    expect(isUsableGrant('disabled', { canRead: true, canWrite: true })).toBe(false);
  });
});
