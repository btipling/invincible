/**
 * Phase 4 — tenant membership roles for admin UI / rotate.
 */

export type TenantRole = 'owner' | 'admin' | 'member' | string;

/** Admin page: owner or admin. */
export function canAccessAdmin(role: TenantRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** Rotate sandbox token: owner only. */
export function canRotateSandboxToken(role: TenantRole | null | undefined): boolean {
  return role === 'owner';
}
