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
  const complete = {
    AUTH_OIDC_ISSUER: 'https://idp.example',
    AUTH_OIDC_CLIENT_ID: 'cid',
    AUTH_OIDC_CLIENT_SECRET: 'sec',
  };

  it('false when OIDC incomplete', () => {
    expect(shouldIncludeOidcProvider({})).toBe(false);
    expect(
      shouldIncludeOidcProvider({ AUTH_OIDC_ISSUER: 'https://x' }),
    ).toBe(false);
  });

  it('true when OIDC complete (no triple gate)', () => {
    expect(shouldIncludeOidcProvider(complete)).toBe(true);
  });
});
