import bcrypt from 'bcryptjs';

/** Locked: bcrypt cost 12 (phase 1 / parent #54). */
export const PASSWORD_BCRYPT_COST = 12;

/**
 * Locked minimum for user-set credentials (first-run sign-up, plane #459 /
 * parent #473 phase 1): at least 8 characters with no whitespace. One shared
 * definition so the sign-up form and any future password surface agree.
 */
export const PASSWORD_MIN_LENGTH = 8;

export async function hashPassword(plain: string): Promise<string> {
  if (!plain) {
    throw new Error('password must be non-empty');
  }
  return bcrypt.hash(plain, PASSWORD_BCRYPT_COST);
}

export async function verifyPassword(
  plain: string,
  passwordHash: string,
): Promise<boolean> {
  if (!plain || !passwordHash) return false;
  return bcrypt.compare(plain, passwordHash);
}
