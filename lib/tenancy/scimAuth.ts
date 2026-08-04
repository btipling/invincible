/**
 * SCIM bearer gate (parent #64 / phase 3 #77).
 * Timing-safe compare; feature-off → 404; bad token → 401.
 */
import { timingSafeEqual } from 'node:crypto';
import { isScimConfigured, scimBearerToken } from './scimConfig';
import { scimErrorResponse } from './scimProtocol';

export type ScimAuthResult =
  | { ok: true }
  | { ok: false; response: Response };

/** Extract Bearer token from Authorization header (case-insensitive scheme). */
export function parseBearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const m = authorization.match(/^\s*Bearer\s+(\S+)\s*$/i);
  return m?.[1] ?? null;
}

/**
 * Constant-time string compare. Different lengths → false (no throw).
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still touch a dummy compare to avoid trivial timing on length-only paths
    // when both non-empty; length mismatch is always false.
    if (bufA.length > 0 && bufB.length > 0) {
      timingSafeEqual(bufA, bufA);
    }
    return false;
  }
  if (bufA.length === 0) return true;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Gate SCIM routes: feature must be on; bearer must match SCIM_BEARER_TOKEN.
 */
export function assertScimRequest(
  req: Request,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ScimAuthResult {
  if (!isScimConfigured(env)) {
    return { ok: false, response: scimErrorResponse(404, 'Not Found') };
  }
  const expected = scimBearerToken(env);
  const got = parseBearerToken(req.headers.get('authorization'));
  if (!got || !timingSafeEqualString(got, expected)) {
    return {
      ok: false,
      response: scimErrorResponse(401, 'Unauthorized', {
        headers: { 'WWW-Authenticate': 'Bearer' },
      }),
    };
  }
  return { ok: true };
}
