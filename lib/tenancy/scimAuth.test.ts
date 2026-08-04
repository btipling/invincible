import { describe, expect, it } from 'vitest';
import {
  assertScimRequest,
  parseBearerToken,
  timingSafeEqualString,
} from './scimAuth';

const tenancyOn = {
  DATABASE_URL: 'postgres://localhost/db',
  AUTH_SECRET: 'secret-secret-secret-secret-secret',
  CREDENTIALS_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  SCIM_BEARER_TOKEN: 'super-secret-token',
};

function req(auth?: string) {
  return new Request('http://localhost/api/scim/v2/Users', {
    headers: auth ? { Authorization: auth } : {},
  });
}

describe('parseBearerToken', () => {
  it('parses Bearer', () => {
    expect(parseBearerToken('Bearer abc')).toBe('abc');
    expect(parseBearerToken('bearer abc')).toBe('abc');
    expect(parseBearerToken('Basic x')).toBeNull();
    expect(parseBearerToken(null)).toBeNull();
  });
});

describe('timingSafeEqualString', () => {
  it('equals', () => {
    expect(timingSafeEqualString('abc', 'abc')).toBe(true);
    expect(timingSafeEqualString('abc', 'abd')).toBe(false);
    expect(timingSafeEqualString('abc', 'ab')).toBe(false);
  });
});

describe('assertScimRequest', () => {
  it('404 when feature off', async () => {
    const r = assertScimRequest(req('Bearer x'), {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(404);
    }
  });

  it('401 when wrong or missing token', async () => {
    const missing = assertScimRequest(req(), tenancyOn);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.response.status).toBe(401);
      expect(missing.response.headers.get('WWW-Authenticate')).toBe('Bearer');
    }
    const wrong = assertScimRequest(req('Bearer nope'), tenancyOn);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.response.status).toBe(401);
  });

  it('ok when bearer matches', () => {
    const r = assertScimRequest(req('Bearer super-secret-token'), tenancyOn);
    expect(r.ok).toBe(true);
  });
});
