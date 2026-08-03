import { describe, expect, it } from 'vitest';
import { applyJwtToSessionUser, applyUserToJwtToken } from './sessionToken';

describe('session JWT mapping', () => {
  it('applyUserToJwtToken copies id/email/name onto token', () => {
    const token = applyUserToJwtToken(
      {},
      { id: 'user-uuid-1', email: 'a@example.com', name: 'Ada' },
    );
    expect(token).toEqual({
      sub: 'user-uuid-1',
      email: 'a@example.com',
      name: 'Ada',
    });
  });

  it('applyUserToJwtToken no-ops without user id', () => {
    const token = applyUserToJwtToken({ sub: 'keep' }, { email: 'x@y.z' });
    expect(token).toEqual({ sub: 'keep' });
  });

  it('applyJwtToSessionUser exposes token.sub as session.user.id', () => {
    const user = applyJwtToSessionUser(
      { email: 'old@example.com' },
      { sub: 'user-uuid-2', email: 'new@example.com', name: 'Bea' },
    );
    expect(user).toEqual({
      id: 'user-uuid-2',
      email: 'new@example.com',
      name: 'Bea',
    });
  });

  it('applyJwtToSessionUser leaves user without id when sub missing', () => {
    const user = applyJwtToSessionUser({ email: 'a@b.c' }, {});
    expect(user).toEqual({ email: 'a@b.c' });
    expect(user.id).toBeUndefined();
  });
});
