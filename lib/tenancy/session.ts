/**
 * Shared auth gate helpers for route handlers (Node runtime).
 */
import { tenancyEnabled } from './enabled';
import { AUTH_REQUIRED_ERROR } from './errors';

export type SessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

/**
 * When tenancy is on, require a session with users.id.
 * When tenancy is off, allows the request (legacy open mode).
 *
 * Dynamic-import auth so vitest route suites (tenancy off) never load next-auth.
 */
export async function requireSessionUser(): Promise<
  | { ok: true; user: SessionUser | null }
  | { ok: false; response: Response }
> {
  if (!tenancyEnabled()) {
    return { ok: true, user: null };
  }
  const { auth } = await import('../../auth');
  const session = await auth();
  const id = session?.user?.id;
  if (!id) {
    return {
      ok: false,
      response: Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 }),
    };
  }
  return {
    ok: true,
    user: {
      id,
      email: session?.user?.email,
      name: session?.user?.name,
    },
  };
}
