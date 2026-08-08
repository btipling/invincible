import { describe, expect, it } from 'vitest';
import {
  assertSandboxCredentials,
  DEFAULT_VERCEL_SANDBOX_IMAGE,
  isSandboxBackend,
  isValidByoBaseUrl,
  normalizeSandboxFieldsForBackend,
  parseVercelSandboxImageInput,
  resolveVercelSandboxImage,
  VERCEL_SANDBOX_IMAGE_MAX_LENGTH,
} from './sandboxBackend';

describe('isSandboxBackend', () => {
  it('narrows byo and vercel only', () => {
    expect(isSandboxBackend('byo')).toBe(true);
    expect(isSandboxBackend('vercel')).toBe(true);
    expect(isSandboxBackend('other')).toBe(false);
    expect(isSandboxBackend(null)).toBe(false);
  });
});

describe('normalizeSandboxFieldsForBackend', () => {
  it('vercel forces credentials null and keeps image', () => {
    expect(
      normalizeSandboxFieldsForBackend({
        backend: 'vercel',
        baseUrl: 'https://byo.example',
        tokenCiphertext: 'v1:x:y:z',
        image: 'vercel/sandbox/node:24',
      }),
    ).toEqual({
      backend: 'vercel',
      baseUrl: null,
      tokenCiphertext: null,
      image: 'vercel/sandbox/node:24',
    });
  });

  it('byo forces image null and keeps credentials', () => {
    expect(
      normalizeSandboxFieldsForBackend({
        backend: 'byo',
        baseUrl: 'https://byo.example',
        tokenCiphertext: 'v1:x:y:z',
        image: 'vercel/sandbox/node:24',
      }),
    ).toEqual({
      backend: 'byo',
      baseUrl: 'https://byo.example',
      tokenCiphertext: 'v1:x:y:z',
      image: null,
    });
  });

  it('empty strings become null', () => {
    expect(
      normalizeSandboxFieldsForBackend({
        backend: 'byo',
        baseUrl: '  ',
        tokenCiphertext: '',
        image: '  ',
      }),
    ).toEqual({
      backend: 'byo',
      baseUrl: null,
      tokenCiphertext: null,
      image: null,
    });
  });
});

describe('assertSandboxCredentials', () => {
  it('byo requires both url and token', () => {
    expect(
      assertSandboxCredentials({
        backend: 'byo',
        baseUrl: 'https://x',
        tokenCiphertext: 'ct',
      }).ok,
    ).toBe(true);
    const missingUrl = assertSandboxCredentials({
      backend: 'byo',
      baseUrl: null,
      tokenCiphertext: 'ct',
    });
    expect(missingUrl.ok).toBe(false);
    if (missingUrl.ok) throw new Error('expected fail');
    expect(missingUrl.error).toMatch(/base URL and token/i);
    expect(missingUrl.error).not.toMatch(/tokenCiphertext/);
    expect(
      assertSandboxCredentials({
        backend: 'byo',
        baseUrl: 'https://x',
        tokenCiphertext: null,
      }).ok,
    ).toBe(false);
  });

  it('vercel requires null/empty credentials', () => {
    expect(
      assertSandboxCredentials({
        backend: 'vercel',
        baseUrl: null,
        tokenCiphertext: null,
      }).ok,
    ).toBe(true);
    expect(
      assertSandboxCredentials({
        backend: 'vercel',
        baseUrl: 'https://leak',
        tokenCiphertext: null,
      }).ok,
    ).toBe(false);
  });
});

describe('resolveVercelSandboxImage', () => {
  it('empty/null → default', () => {
    expect(resolveVercelSandboxImage(null)).toEqual({
      ok: true,
      image: DEFAULT_VERCEL_SANDBOX_IMAGE,
    });
    expect(resolveVercelSandboxImage('')).toEqual({
      ok: true,
      image: DEFAULT_VERCEL_SANDBOX_IMAGE,
    });
    expect(resolveVercelSandboxImage('   ')).toEqual({
      ok: true,
      image: DEFAULT_VERCEL_SANDBOX_IMAGE,
    });
  });

  it('accepts VMI and short/team VCR forms', () => {
    for (const image of [
      'vercel/sandbox/universal:latest',
      'vercel/sandbox/node:24',
      'my-repo:tag',
      'team/project/repo:tag',
      `team/project/repo@sha256:${'a'.repeat(64)}`,
    ]) {
      expect(resolveVercelSandboxImage(image)).toEqual({ ok: true, image });
    }
  });

  it('rejects whitespace, control chars, bad shape, overlong', () => {
    expect(resolveVercelSandboxImage('bad image').ok).toBe(false);
    expect(resolveVercelSandboxImage('has\nnewline').ok).toBe(false);
    expect(resolveVercelSandboxImage('///').ok).toBe(false);
    expect(
      resolveVercelSandboxImage('x'.repeat(VERCEL_SANDBOX_IMAGE_MAX_LENGTH + 1))
        .ok,
    ).toBe(false);
  });
});

describe('parseVercelSandboxImageInput', () => {
  it('empty → null store', () => {
    expect(parseVercelSandboxImageInput(null)).toEqual({
      ok: true,
      image: null,
    });
    expect(parseVercelSandboxImageInput('')).toEqual({
      ok: true,
      image: null,
    });
  });

  it('valid non-empty → trimmed', () => {
    expect(parseVercelSandboxImageInput('  my-repo:1  ')).toEqual({
      ok: true,
      image: 'my-repo:1',
    });
  });

  it('invalid non-empty → error', () => {
    expect(parseVercelSandboxImageInput('not a ref').ok).toBe(false);
  });
});

describe('isValidByoBaseUrl', () => {
  it('accepts http(s) absolute URLs', () => {
    expect(isValidByoBaseUrl('https://sandbox.example')).toBe(true);
    expect(isValidByoBaseUrl('http://127.0.0.1:8787/')).toBe(true);
  });

  it('rejects empty, relative, and non-http schemes', () => {
    expect(isValidByoBaseUrl('')).toBe(false);
    expect(isValidByoBaseUrl('not-a-url')).toBe(false);
    expect(isValidByoBaseUrl('ftp://x')).toBe(false);
    expect(isValidByoBaseUrl('/relative')).toBe(false);
  });
});
