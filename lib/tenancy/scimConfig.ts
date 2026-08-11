/**
 * Pure SCIM env helpers (parent #64 / phase 3 #77).
 */

export type ScimEnv = {
  SCIM_BEARER_TOKEN?: string | undefined;
};

export function scimBearerToken(
  env: NodeJS.ProcessEnv | ScimEnv | Record<string, string | undefined> = process.env,
): string {
  return env.SCIM_BEARER_TOKEN?.trim() ?? '';
}

/** Configured when a non-empty SCIM_BEARER_TOKEN is present. */
export function isScimConfigured(
  env: NodeJS.ProcessEnv | ScimEnv | Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(scimBearerToken(env));
}
