import { eq } from 'drizzle-orm';
import { createDbConnection, users, type Db } from '../../db';
import { verifyPassword } from './password';

export type AuthenticatedUser = {
  id: string;
  email: string;
  name?: string;
};

export type AuthenticateDeps = {
  /** Injected DB (tests). When omitted, opens/closes a short-lived connection. */
  db?: Db;
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

  if (deps.db) {
    return lookupActiveUser(deps.db, email, password);
  }

  if (!process.env.DATABASE_URL?.trim()) {
    return null;
  }

  const { db, client } = createDbConnection();
  try {
    return await lookupActiveUser(db, email, password);
  } finally {
    await client.end({ timeout: 5 });
  }
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
