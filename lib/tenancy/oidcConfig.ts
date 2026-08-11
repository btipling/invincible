/**
 * Pure OIDC env helpers (parent #64 / phase 2 #76).
 * No Auth.js imports — unit-tested without Next.
 */
export type OidcEnv = {
  AUTH_OIDC_ISSUER?: string | undefined;
  AUTH_OIDC_CLIENT_ID?: string | undefined;
  AUTH_OIDC_CLIENT_SECRET?: string | undefined;
  AUTH_OIDC_LABEL?: string | undefined;
};

export const DEFAULT_OIDC_LABEL = 'Sign in with SSO';

/** True when issuer + client id + client secret are all non-empty. */
export function isOidcConfigured(
  env: NodeJS.ProcessEnv | OidcEnv | Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(
    env.AUTH_OIDC_ISSUER?.trim() &&
      env.AUTH_OIDC_CLIENT_ID?.trim() &&
      env.AUTH_OIDC_CLIENT_SECRET?.trim(),
  );
}

export function oidcButtonLabel(
  env: NodeJS.ProcessEnv | OidcEnv | Record<string, string | undefined> = process.env,
): string {
  const label = env.AUTH_OIDC_LABEL?.trim();
  return label || DEFAULT_OIDC_LABEL;
}

export function oidcIssuer(
  env: NodeJS.ProcessEnv | OidcEnv | Record<string, string | undefined> = process.env,
): string {
  return env.AUTH_OIDC_ISSUER?.trim() ?? '';
}

export function oidcClientId(
  env: NodeJS.ProcessEnv | OidcEnv | Record<string, string | undefined> = process.env,
): string {
  return env.AUTH_OIDC_CLIENT_ID?.trim() ?? '';
}

export function oidcClientSecret(
  env: NodeJS.ProcessEnv | OidcEnv | Record<string, string | undefined> = process.env,
): string {
  return env.AUTH_OIDC_CLIENT_SECRET?.trim() ?? '';
}

/**
 * Normalize IdP email_verified claim (boolean or string "true"/"false").
 */
export function isEmailVerifiedClaim(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'true') {
    return true;
  }
  return false;
}

/**
 * OIDC button + Auth.js provider when OIDC env is complete.
 * Multi-tenant only — no triple gate.
 */
export function shouldIncludeOidcProvider(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return isOidcConfigured(env);
}
