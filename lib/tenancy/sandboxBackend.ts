/**
 * Per-sandbox backend + image validation (#281 / parent #280).
 * Server-only domain helpers — no product host env switch.
 */

export type SandboxBackend = 'byo' | 'vercel';

export const DEFAULT_VERCEL_SANDBOX_IMAGE = 'vercel/sandbox/universal:latest';

/** Max stored / resolved image ref length (chars). */
export const VERCEL_SANDBOX_IMAGE_MAX_LENGTH = 512;

/**
 * VMI / short / team VCR refs + optional tag and @sha256 digest.
 * No whitespace or control characters (checked separately).
 */
const IMAGE_REF_RE =
  /^(?:[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+){0,3})(?::[a-zA-Z0-9._-]+)?(?:@sha256:[a-f0-9]{64})?$/;

export function isSandboxBackend(value: unknown): value is SandboxBackend {
  return value === 'byo' || value === 'vercel';
}

function hasDisallowedImageChars(s: string): boolean {
  // whitespace + C0 controls + DEL
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

export type ImageResolveResult =
  | { ok: true; image: string }
  | { ok: false; error: string };

/**
 * Resolve the image used at Sandbox.create time.
 * empty/null → product default; invalid non-empty → error.
 */
export function resolveVercelSandboxImage(
  raw: string | null | undefined,
): ImageResolveResult {
  if (raw == null) {
    return { ok: true, image: DEFAULT_VERCEL_SANDBOX_IMAGE };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, image: DEFAULT_VERCEL_SANDBOX_IMAGE };
  }
  const shape = validateVercelSandboxImageShape(trimmed);
  if (!shape.ok) return shape;
  return { ok: true, image: trimmed };
}

/**
 * Parse operator/seed image input for storage.
 * empty → null (store null; runtime uses default).
 * non-empty must pass shape → trimmed ref.
 */
export function parseVercelSandboxImageInput(
  raw: string | null | undefined,
): ImageResolveResult | { ok: true; image: null } {
  if (raw == null) {
    return { ok: true, image: null };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: true, image: null };
  }
  const shape = validateVercelSandboxImageShape(trimmed);
  if (!shape.ok) return shape;
  return { ok: true, image: trimmed };
}

function validateVercelSandboxImageShape(trimmed: string): ImageResolveResult {
  if (trimmed.length > VERCEL_SANDBOX_IMAGE_MAX_LENGTH) {
    return {
      ok: false,
      error: `image must be at most ${VERCEL_SANDBOX_IMAGE_MAX_LENGTH} characters`,
    };
  }
  if (hasDisallowedImageChars(trimmed)) {
    return {
      ok: false,
      error: 'image must not contain whitespace or control characters',
    };
  }
  if (!IMAGE_REF_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        'image must be a VMI or VCR ref (e.g. vercel/sandbox/universal:latest, repo:tag, team/project/repo:tag, optional @sha256:…)',
    };
  }
  return { ok: true, image: trimmed };
}

export type SandboxCredentialFields = {
  backend: SandboxBackend;
  baseUrl: string | null;
  tokenCiphertext: string | null;
  image: string | null;
};

function emptyToNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * Backend switch hygiene: clear fields that do not apply.
 * vercel → null credentials; byo → null image.
 */
export function normalizeSandboxFieldsForBackend(input: {
  backend: SandboxBackend;
  baseUrl?: string | null;
  tokenCiphertext?: string | null;
  image?: string | null;
}): SandboxCredentialFields {
  if (input.backend === 'vercel') {
    return {
      backend: 'vercel',
      baseUrl: null,
      tokenCiphertext: null,
      image: emptyToNull(input.image ?? null),
    };
  }
  return {
    backend: 'byo',
    baseUrl: emptyToNull(input.baseUrl ?? null),
    tokenCiphertext: emptyToNull(input.tokenCiphertext ?? null),
    image: null,
  };
}

export type AssertCredentialsResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * After normalize: byo requires URL+token ciphertext; vercel requires neither.
 */
export function assertSandboxCredentials(row: {
  backend: SandboxBackend;
  baseUrl?: string | null;
  tokenCiphertext?: string | null;
}): AssertCredentialsResult {
  if (row.backend === 'byo') {
    const url = row.baseUrl?.trim() ?? '';
    const token = row.tokenCiphertext?.trim() ?? '';
    if (!url || !token) {
      return {
        ok: false,
        error: 'byo sandbox requires baseUrl and tokenCiphertext',
      };
    }
    return { ok: true };
  }
  // vercel
  const url = row.baseUrl?.trim() ?? '';
  const token = row.tokenCiphertext?.trim() ?? '';
  if (url || token) {
    return {
      ok: false,
      error: 'vercel sandbox must not store baseUrl or tokenCiphertext',
    };
  }
  return { ok: true };
}
