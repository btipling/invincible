import { describe, expect, it } from 'vitest';
import { isScimConfigured, scimBearerToken } from './scimConfig';

describe('isScimConfigured', () => {
  const tenancy = {
    DATABASE_URL: 'postgres://localhost/db',
    AUTH_SECRET: 'secret-secret-secret-secret-secret',
    CREDENTIALS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  };

  it('false when tenancy off', () => {
    expect(isScimConfigured({ SCIM_BEARER_TOKEN: 'tok' })).toBe(false);
  });

  it('false when token missing', () => {
    expect(isScimConfigured(tenancy)).toBe(false);
    expect(isScimConfigured({ ...tenancy, SCIM_BEARER_TOKEN: '  ' })).toBe(false);
  });

  it('true when tenancy + token', () => {
    expect(isScimConfigured({ ...tenancy, SCIM_BEARER_TOKEN: 'tok' })).toBe(true);
  });
});

describe('scimBearerToken', () => {
  it('trims', () => {
    expect(scimBearerToken({ SCIM_BEARER_TOKEN: '  abc  ' })).toBe('abc');
  });
});
