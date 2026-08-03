/**
 * Phase 4 — display-only mask for secrets (admin UI).
 * Never log or return the full secret to the client.
 */

/** Mask a secret: bullets + last 4 chars, or ******** if too short. */
export function maskSecret(secret: string): string {
  const s = secret ?? '';
  if (s.length < 4) {
    return '********';
  }
  return `••••••••${s.slice(-4)}`;
}
