import { describe, expect, it } from 'vitest';
import {
  applyScimPatchOperations,
  parseScimFilter,
  parseScimPagination,
  SCIM_MAX_COUNT,
  SCIM_MAX_EMAIL_LEN,
  userToScimResource,
  validateScimStringFields,
} from './scimProtocol';
import type { User } from '../../db';

const sampleUser = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'a@example.com',
  name: 'Ada',
  status: 'active',
  image: null,
  emailVerified: null,
  passwordHash: null,
  idpSubject: null,
  provisionSource: 'scim',
  scimExternalId: 'ext-1',
  createdAt: new Date(),
  updatedAt: new Date(),
} as User;

describe('parseScimFilter', () => {
  it('parses userName and externalId', () => {
    expect(parseScimFilter('userName eq "a@x.com"')).toEqual({
      ok: true,
      filter: { kind: 'userName', value: 'a@x.com' },
    });
    expect(parseScimFilter("externalId eq 'e1'")).toEqual({
      ok: true,
      filter: { kind: 'externalId', value: 'e1' },
    });
    expect(parseScimFilter('')).toEqual({ ok: true, filter: null });
  });

  it('rejects unsupported', () => {
    expect(parseScimFilter('title eq "x"').ok).toBe(false);
  });
});

describe('parseScimPagination', () => {
  it('defaults and max', () => {
    expect(parseScimPagination(null, null)).toEqual({
      ok: true,
      startIndex: 1,
      count: 50,
    });
    expect(parseScimPagination('0', '10')).toEqual({
      ok: true,
      startIndex: 1,
      count: 10,
    });
    const over = parseScimPagination('1', String(SCIM_MAX_COUNT + 1));
    expect(over.ok).toBe(false);
  });
});

describe('userToScimResource', () => {
  it('maps fields', () => {
    const r = userToScimResource(sampleUser, 'https://app.example/api/scim/v2');
    expect(r.id).toBe(sampleUser.id);
    expect(r.userName).toBe('a@example.com');
    expect(r.externalId).toBe('ext-1');
    expect(r.active).toBe(true);
    expect(r.meta.location).toContain(sampleUser.id);
  });
});

describe('applyScimPatchOperations', () => {
  it('replace active', () => {
    const r = applyScimPatchOperations([
      { op: 'replace', path: 'active', value: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.active).toBe(false);
  });
});

describe('applyScimPatchOperations pathless value', () => {
  it('prefers userName over emails when both present', () => {
    const r = applyScimPatchOperations([
      {
        op: 'replace',
        value: {
          userName: 'a@x.com',
          emails: [{ value: 'b@x.com', primary: true }],
        },
      },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.email).toBe('a@x.com');
  });
});

describe('validateScimStringFields', () => {
  it('rejects oversized email', () => {
    const r = validateScimStringFields({ email: 'x'.repeat(SCIM_MAX_EMAIL_LEN + 1) });
    expect(r.ok).toBe(false);
  });
});
