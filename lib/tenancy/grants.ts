/**
 * Parent #54 / phase 3 — effective tool permissions from sandbox_grants.
 * Write implies read for the agent loop.
 */
export type GrantFlags = {
  canRead: boolean;
  canWrite: boolean;
};

export type EffectivePermissions = {
  canRead: boolean;
  canWrite: boolean;
};

export function effectiveGrantPermissions(grant: GrantFlags): EffectivePermissions {
  const canWrite = Boolean(grant.canWrite);
  const canRead = Boolean(grant.canRead) || canWrite;
  return { canRead, canWrite };
}

/** Usable workspace: active sandbox and at least one effective capability. */
export function isUsableGrant(
  sandboxStatus: string,
  grant: GrantFlags,
): boolean {
  if (sandboxStatus !== 'active') return false;
  const effective = effectiveGrantPermissions(grant);
  return effective.canRead || effective.canWrite;
}
