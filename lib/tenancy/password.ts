import bcrypt from 'bcryptjs';

/** Locked: bcrypt cost 12 (phase 1 / parent #54). */
export const PASSWORD_BCRYPT_COST = 12;

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
