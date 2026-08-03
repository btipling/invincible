/**
 * Parent #54 / phase 2 — triple env gate for multi-tenant auth.
 * No separate AUTH_ENABLED flag.
 */
export function tenancyEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(
    env.DATABASE_URL?.trim() &&
      env.AUTH_SECRET?.trim() &&
      env.CREDENTIALS_ENCRYPTION_KEY?.trim(),
  );
}
