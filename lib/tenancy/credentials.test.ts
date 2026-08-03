import { describe, expect, it } from 'vitest';
import {
  CredentialsError,
  decryptSecret,
  encryptSecret,
  resolveCredentialsKey,
} from './credentials';

function testKey(): Buffer {
  // 32 zero bytes, base64
  return Buffer.alloc(32, 7);
}

function envWithKey(key: Buffer = testKey()) {
  return { CREDENTIALS_ENCRYPTION_KEY: key.toString('base64') };
}

describe('resolveCredentialsKey', () => {
  it('accepts base64 32-byte key', () => {
    const key = testKey();
    const resolved = resolveCredentialsKey(envWithKey(key));
    expect(resolved.equals(key)).toBe(true);
  });

  it('rejects missing key', () => {
    expect(() => resolveCredentialsKey({})).toThrow(CredentialsError);
  });

  it('rejects wrong length', () => {
    expect(() =>
      resolveCredentialsKey({
        CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
      }),
    ).toThrow(/32 bytes/);
  });
});

describe('encryptSecret / decryptSecret', () => {
  const key = testKey();

  it('round-trips plaintext', () => {
    const secret = 'sandbox-token-abc-123';
    const enc = encryptSecret(secret, key);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(decryptSecret(enc, key)).toBe(secret);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const a = encryptSecret('same', key);
    const b = encryptSecret('same', key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('same');
    expect(decryptSecret(b, key)).toBe('same');
  });

  it('fails with wrong key', () => {
    const enc = encryptSecret('tok', key);
    const wrong = Buffer.alloc(32, 9);
    expect(() => decryptSecret(enc, wrong)).toThrow(CredentialsError);
  });

  it('fails when ciphertext is tampered', () => {
    const enc = encryptSecret('tok', key);
    const parts = enc.split(':');
    const ct = Buffer.from(parts[2], 'base64');
    ct[0] ^= 0xff;
    parts[2] = ct.toString('base64');
    expect(() => decryptSecret(parts.join(':'), key)).toThrow(CredentialsError);
  });

  it('fails when tag is tampered', () => {
    const enc = encryptSecret('tok', key);
    const parts = enc.split(':');
    const tag = Buffer.from(parts[3], 'base64');
    tag[0] ^= 0xff;
    parts[3] = tag.toString('base64');
    expect(() => decryptSecret(parts.join(':'), key)).toThrow(CredentialsError);
  });

  it('fails on invalid format', () => {
    expect(() => decryptSecret('not-a-payload', key)).toThrow(CredentialsError);
    expect(() => decryptSecret('v2:a:b:c', key)).toThrow(CredentialsError);
  });

  it('resolves key from env when omitted', () => {
    const prev = process.env.CREDENTIALS_ENCRYPTION_KEY;
    process.env.CREDENTIALS_ENCRYPTION_KEY = key.toString('base64');
    try {
      const enc = encryptSecret('from-env');
      expect(decryptSecret(enc)).toBe('from-env');
    } finally {
      if (prev === undefined) delete process.env.CREDENTIALS_ENCRYPTION_KEY;
      else process.env.CREDENTIALS_ENCRYPTION_KEY = prev;
    }
  });
});
