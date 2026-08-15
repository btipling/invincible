import { describe, expect, it } from 'vitest';
import { buildSignedInNavItems, type NavItem } from './navMenu';

describe('buildSignedInNavItems', () => {
  it('owner|admin → [Admin, Settings, Harness] in stable order', () => {
    expect(buildSignedInNavItems({ showAdmin: true })).toEqual([
      { href: '/admin', label: 'Admin' },
      { href: '/settings', label: 'Settings' },
      { href: '/harness', label: 'Harness' },
    ]);
  });

  it('member (showAdmin:false) → [Settings, Harness]; Admin hidden', () => {
    expect(buildSignedInNavItems({ showAdmin: false })).toEqual([
      { href: '/settings', label: 'Settings' },
      { href: '/harness', label: 'Harness' },
    ]);
  });

  it('harness self-link is retained (behavior-preserving from today)', () => {
    const items = buildSignedInNavItems({ showAdmin: false });
    expect(items.map((i) => i.href)).toContain('/harness');
  });

  it('items carry exactly the inert descriptor shape (no role/gate data)', () => {
    const items = buildSignedInNavItems({ showAdmin: true });
    for (const i of items) {
      const keys = Object.keys(i);
      expect(keys.sort()).toEqual(['href', 'label']);
    }
  });

  it('every location is absolute (client-initial "/")', () => {
    const items = buildSignedInNavItems({ showAdmin: true }) as NavItem[];
    for (const i of items) expect(i.href.startsWith('/')).toBe(true);
  });
});
