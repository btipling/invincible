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

/**
 * Pure keyboard-navigation model for the NavMenu roving list (DOM site chrome).
 *
 * Kept here (the pure module the unit tests target) because this repo runs
 * vitest in a node environment with no jsdom/testing-library — the DOM
 * component applies these decisions but the machine itself is testable without
 * a browser. The client holds zero role-gate logic; this is key mapping only.
 */
export type NavKeyAction = 'next' | 'prev' | 'home' | 'end' | 'escape' | 'none';

/**
 * Map a Menu keydown to a roving action. Arrow / Home / End are handled (the
 * component calls preventDefault when the action is not 'none'/'escape').
 * Escape closes. Tab and Shift+Tab intentionally return 'none' so the
 * browser's natural tab order can leave the menu and reach the footer
 * `LogoutButton` — the keyboard sign-out path is never hijacked.
 */
export function navMenuKeyAction(key: string): NavKeyAction {
  if (key === 'ArrowDown') return 'next';
  if (key === 'ArrowUp') return 'prev';
  if (key === 'Home') return 'home';
  if (key === 'End') return 'end';
  if (key === 'Escape') return 'escape';
  // Tab / Shift+Tab / any other key → 'none' (natural focus order, not trapped).
  return 'none';
}

/**
 * Next roving focus index for `count` items. next/prev wrap; home/end clamp;
 * escape/none leave the index unchanged (caller closes / lets Tab through).
 */
export function nextFocusIndex(
  count: number,
  current: number,
  action: NavKeyAction,
): number {
  if (count <= 0) return current;
  switch (action) {
    case 'next':
      return (current + 1) % count;
    case 'prev':
      return (current - 1 + count) % count;
    case 'home':
      return 0;
    case 'end':
      return count - 1;
    default:
      return current;
  }
}
