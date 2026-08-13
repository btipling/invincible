import { describe, expect, it } from 'vitest';
import {
  PASSWORD_BCRYPT_COST,
  hashPassword,
  verifyPassword,
} from './password';

describe('hashPassword / verifyPassword', () => {
  it('hashes with bcrypt and verifies', async () => {
    const plain = 'P8ss_min8_example!';
    const hash = await hashPassword(plain);
    expect(hash).toMatch(/^\$2[aby]?\$/);
    expect(await verifyPassword(plain, hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('uses cost 12', async () => {
    const hash = await hashPassword('x');
    // bcrypt format: $2a$12$...
    const cost = hash.split('$')[2];
    expect(Number(cost)).toBe(PASSWORD_BCRYPT_COST);
  });

  it('rejects empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow(/non-empty/);
  });
});
