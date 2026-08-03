import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/** Current app KEK version written into new ciphertexts. */
export const CURRENT_KEK_VERSION = 1;

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PREFIX = 'v1';

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsError';
  }
}

/**
 * Decode CREDENTIALS_ENCRYPTION_KEY: base64 → exactly 32 raw bytes (AES-256).
 */
export function resolveCredentialsKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  const raw = env.CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new CredentialsError('CREDENTIALS_ENCRYPTION_KEY is required');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new CredentialsError(
      `CREDENTIALS_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (got ${key.length})`,
    );
  }
  return key;
}

/**
 * AES-256-GCM encrypt. Output: `v1:<b64 iv>:<b64 ciphertext>:<b64 tag>`
 * Never log plaintext or key.
 */
export function encryptSecret(
  plaintext: string,
  key: Buffer = resolveCredentialsKey(),
): string {
  if (key.length !== KEY_LENGTH) {
    throw new CredentialsError(`encryption key must be ${KEY_LENGTH} bytes`);
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString('base64'),
    ciphertext.toString('base64'),
    tag.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a payload from {@link encryptSecret}. Throws on wrong key or tamper.
 */
export function decryptSecret(
  payload: string,
  key: Buffer = resolveCredentialsKey(),
): string {
  if (key.length !== KEY_LENGTH) {
    throw new CredentialsError(`decryption key must be ${KEY_LENGTH} bytes`);
  }
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new CredentialsError('invalid ciphertext format');
  }
  const [, ivB64, ctB64, tagB64] = parts;
  let iv: Buffer;
  let ciphertext: Buffer;
  let tag: Buffer;
  try {
    iv = Buffer.from(ivB64, 'base64');
    ciphertext = Buffer.from(ctB64, 'base64');
    tag = Buffer.from(tagB64, 'base64');
  } catch {
    throw new CredentialsError('invalid ciphertext encoding');
  }
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new CredentialsError('invalid ciphertext component length');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    throw new CredentialsError('decryption failed');
  }
}

/** Constant-time string compare for tests / optional callers. */
export function safeEqualString(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
