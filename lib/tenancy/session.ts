/**
 * Shared auth gate helpers for route handlers (Node runtime).
 */
import { AUTH_REQUIRED_ERROR } from './errors';

export type SessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

/**
 * Always require a session user id (fail closed). Tenancy is hard-on.
 *
 * Dynamic-import auth so vitest route suites never load next-auth.
 */
export async function requireSessionUser(): Promise<
  | { ok: true; user: SessionUser }
  | { ok: false; response: Response }
> {
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
