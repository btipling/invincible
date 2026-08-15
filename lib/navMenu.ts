/**
 * Client-safe signed-in nav item projection (DOM site chrome).
 *
 * Pure — imports nothing from the tenancy/DB layer, so it is safe for the DOM
 * bundle and unit-testable without a DOM. It turns the server-computed
 * `showAdmin` boolean (resolved by the single source of truth: the server-side
 * `soleMembership.loadSoleMembership` + `canAccessAdmin` lookup) into the
 * ordered set of inert `{ href, label }` descriptors the client `NavMenu`
 * renders. The client holds ZERO gate logic — it renders only what the server
 * hands it. Item count is bounded at 4 by this fixed list.
 */
export type NavItem = {
  href: string;
  label: string;
};

/**
 * Ordered signed-in item list, stable: Admin (only when `showAdmin`), Settings,
 * Harness. Harmless self-link to `/harness` retained (same as today).
 */
export function buildSignedInNavItems({ showAdmin }: { showAdmin: boolean }): NavItem[] {
  const items: NavItem[] = [];
  if (showAdmin) items.push({ href: '/admin', label: 'Admin' });
  items.push({ href: '/settings', label: 'Settings' });
  items.push({ href: '/harness', label: 'Harness' });
  return items;
}
