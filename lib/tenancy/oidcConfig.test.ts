import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OIDC_LABEL,
  isEmailVerifiedClaim,
  isOidcConfigured,
  oidcButtonLabel,
  shouldIncludeOidcProvider,
} from './oidcConfig';

describe('isOidcConfigured', () => {
  const full = {
    AUTH_OIDC_ISSUER: 'https://idp.example',
    AUTH_OIDC_CLIENT_ID: 'cid',
    AUTH_OIDC_CLIENT_SECRET: 'sec',
  };

  it('true when all three set', () => {
    expect(isOidcConfigured(full)).toBe(true);
  });

  it('false when any missing or blank', () => {
    expect(isOidcConfigured({})).toBe(false);
    expect(isOidcConfigured({ ...full, AUTH_OIDC_ISSUER: '  ' })).toBe(false);
    expect(isOidcConfigured({ ...full, AUTH_OIDC_CLIENT_ID: '' })).toBe(false);
    expect(
      isOidcConfigured({
        AUTH_OIDC_ISSUER: full.AUTH_OIDC_ISSUER,
        AUTH_OIDC_CLIENT_ID: full.AUTH_OIDC_CLIENT_ID,
      }),
    ).toBe(false);
  });
});

describe('oidcButtonLabel', () => {
  it('defaults when unset', () => {
    expect(oidcButtonLabel({})).toBe(DEFAULT_OIDC_LABEL);
  });

  it('uses AUTH_OIDC_LABEL when set', () => {
    expect(oidcButtonLabel({ AUTH_OIDC_LABEL: '  Okta  ' })).toBe('Okta');
  });
});

describe('isEmailVerifiedClaim', () => {
  it('accepts boolean true and string true', () => {
    expect(isEmailVerifiedClaim(true)).toBe(true);
    expect(isEmailVerifiedClaim('true')).toBe(true);
    expect(isEmailVerifiedClaim('TRUE')).toBe(true);
  });

  it('rejects falsey and other values', () => {
    expect(isEmailVerifiedClaim(false)).toBe(false);
    expect(isEmailVerifiedClaim('false')).toBe(false);
    expect(isEmailVerifiedClaim(undefined)).toBe(false);
    expect(isEmailVerifiedClaim(1)).toBe(false);
  });
});

describe('shouldIncludeOidcProvider', () => {
  const tenancy = {
    DATABASE_URL: 'postgres://localhost/db',
    AUTH_SECRET: 'secret-secret-secret-secret-secret',
    CREDENTIALS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  };
  const oidc = {
    AUTH_OIDC_ISSUER: 'https://idp.example',
    AUTH_OIDC_CLIENT_ID: 'cid',
    AUTH_OIDC_CLIENT_SECRET: 'sec',
  };

  it('false when tenancy off even if OIDC set', () => {
    expect(shouldIncludeOidcProvider(oidc)).toBe(false);
  });

  it('false when tenancy on but OIDC incomplete', () => {
    expect(
      shouldIncludeOidcProvider({ ...tenancy, AUTH_OIDC_ISSUER: 'https://x' }),
    ).toBe(false);
  });

  it('true when both complete', () => {
    expect(shouldIncludeOidcProvider({ ...tenancy, ...oidc })).toBe(true);
  });
});
