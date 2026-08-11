import { describe, expect, it } from 'vitest';
import { isScimConfigured, scimBearerToken } from './scimConfig';

describe('isScimConfigured', () => {
  it('false when token missing', () => {
    expect(isScimConfigured({})).toBe(false);
    expect(isScimConfigured({ SCIM_BEARER_TOKEN: '  ' })).toBe(false);
  });

  it('true when token set', () => {
    expect(isScimConfigured({ SCIM_BEARER_TOKEN: 'tok' })).toBe(true);
  });
});

describe('scimBearerToken', () => {
  it('trims', () => {
    expect(scimBearerToken({ SCIM_BEARER_TOKEN: '  abc  ' })).toBe('abc');
  });
});
