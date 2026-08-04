/**
 * Pure SCIM env helpers (parent #64 / phase 3 #77).
 */
import { tenancyEnabled } from './enabled';

export type ScimEnv = {
  SCIM_BEARER_TOKEN?: string | undefined;
  DATABASE_URL?: string | undefined;
  AUTH_SECRET?: string | undefined;
  CREDENTIALS_ENCRYPTION_KEY?: string | undefined;
};

export function scimBearerToken(
  env: NodeJS.ProcessEnv | ScimEnv | Record<string, string | undefined> = process.env,
): string {
  return env.SCIM_BEARER_TOKEN?.trim() ?? '';
}

/** Tenancy triple-gate AND non-empty SCIM_BEARER_TOKEN. */
export function isScimConfigured(
  env: NodeJS.ProcessEnv | ScimEnv | Record<string, string | undefined> = process.env,
): boolean {
  return tenancyEnabled(env) && Boolean(scimBearerToken(env));
}
