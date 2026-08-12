import { eq } from 'drizzle-orm';
import { users, type Db } from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import { verifyPassword } from './password';

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string;
};

export type AuthenticateDeps = {
  /** Injected DB (tests). */
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
};

/**
 * Credentials check against `users`: lowercased email, active status, bcrypt hash.
 * Returns null for any failure (no user enumeration message).
 */
export async function authenticateCredentials(
  emailRaw: string,
  password: string,
  deps: AuthenticateDeps = {},
): Promise<AuthenticatedUser | null> {
  const email = emailRaw.trim().toLowerCase();
  if (!email || !password) {
    return null;
  }

  try {
    return await withConnection(deps, (db) =>
      lookupActiveUser(db, email, password),
    );
  } catch (err) {
    // Fail closed (null → bad password) only for a genuine wiring gap where no
    // connection source is configured at all. DB query / lookup outages must
    // propagate so NextAuth surfaces a real error (500) instead of mislabelling
    // an infrastructure failure as a bad password — mirrors pre-DI behavior.
    if (isMissingDependency(err)) {
      return null;
    }
    throw err;
  }
}

function isMissingDependency(err: unknown): boolean {
  return (
    err instanceof Error &&
    /missing dependency: provide db or connect/.test(err.message)
  );
}

/** Factory (DI): binds a fixed deps closure for composition-root wiring. */
export function createAuthenticate(deps: AuthenticateDeps = {}) {
  return {
    authenticateCredentials: (email: string, password: string) =>
      authenticateCredentials(email, password, deps),
  };
}

async function lookupActiveUser(
  db: Db,
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      status: users.status,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== 'active' || !row.passwordHash) {
    return null;
  }
  const ok = await verifyPassword(password, row.passwordHash);
  if (!ok) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? undefined,
  };
}
