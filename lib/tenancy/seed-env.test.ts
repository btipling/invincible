import { describe, expect, it } from 'vitest';
import { encryptSecret, resolveCredentialsKey } from './credentials';
import { hashPassword, verifyPassword } from './password';

/**
 * Seed contract smoke without a live DB:
 * - env key + encrypt path used by seed
 * - admin password hash verifies (same as seed write)
 */
describe('seed contract (no DB)', () => {
  it('encrypts sandbox token with seed key material', () => {
    const key = resolveCredentialsKey({
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
    });
    const token = 'seed-sandbox-token';
    const ct = encryptSecret(token, key);
    expect(ct.startsWith('v1:')).toBe(true);
  });

  it('owner password hash from SEED_ADMIN_PASSWORD verifies', async () => {
    const password = 'operator-seed-pass-1';
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });
});
