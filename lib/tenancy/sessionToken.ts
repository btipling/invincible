/**
 * Pure JWT/session mapping used by Auth.js callbacks — unit-tested without NextAuth.
 */

export type JwtUserSlice = {
  id?: string | null;
  email?: string | null;
  name?: string | null;
};

export type JwtTokenSlice = {
  sub?: string;
  email?: string | null;
  name?: string | null;
};

export type SessionUserSlice = {
  id?: string;
  email?: string | null;
  name?: string | null;
};

/** On sign-in, copy user id/email/name onto the JWT. */
export function applyUserToJwtToken<T extends JwtTokenSlice>(
  token: T,
  user: JwtUserSlice | undefined,
): T {
  if (user?.id) {
    token.sub = user.id;
    if (user.email) token.email = user.email;
    if (user.name) token.name = user.name;
  }
  return token;
}

/** Map JWT claims onto session.user (requires token.sub → session.user.id). */
export function applyJwtToSessionUser(
  sessionUser: SessionUserSlice,
  token: JwtTokenSlice,
): SessionUserSlice {
  if (token.sub) {
    sessionUser.id = token.sub;
    if (typeof token.email === 'string') {
      sessionUser.email = token.email;
    }
    if (typeof token.name === 'string') {
      sessionUser.name = token.name;
    }
  }
  return sessionUser;
}
