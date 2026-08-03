/**
 * Same-origin path only for post-login redirects.
 * Blocks protocol-relative (`//evil`) and absolute URLs.
 */
export function safeCallbackUrl(
  raw: string | null | undefined,
  fallback = '/harness',
): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  // Block backslash tricks some browsers treat as special
  if (value.includes('\\')) return fallback;
  return value;
}
