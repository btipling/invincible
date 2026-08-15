import { describe, expect, it } from 'vitest';
import {
  buildSignedInNavItems,
  navMenuKeyAction,
  nextFocusIndex,
  type NavItem,
} from './navMenu';

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

describe('navMenuKeyAction (keyboard machine)', () => {
  it('maps roving menu keys', () => {
    expect(navMenuKeyAction('ArrowDown')).toBe('next');
    expect(navMenuKeyAction('ArrowUp')).toBe('prev');
    expect(navMenuKeyAction('Home')).toBe('home');
    expect(navMenuKeyAction('End')).toBe('end');
    expect(navMenuKeyAction('Escape')).toBe('escape');
  });

  it('Tab and Shift+Tab are NOT hijacked (footer Logout stays reachable)', () => {
    expect(navMenuKeyAction('Tab')).toBe('none');
    // Focus must be able to leave the menu down into the footer: keyboard log
    // out works when Tab travels the natural order into the LogoutButton.
    expect(navMenuKeyAction('Enter')).toBe('none');
  });

  it('unmapped keys pass through untouched', () => {
    expect(navMenuKeyAction('a')).toBe('none');
    expect(navMenuKeyAction(' ')).toBe('none');
  });
});

describe('nextFocusIndex (roving focus)', () => {
  it('next/prev wrap around the item list', () => {
    expect(nextFocusIndex(3, 0, 'next')).toBe(1);
    expect(nextFocusIndex(3, 2, 'next')).toBe(0);
    expect(nextFocusIndex(3, 0, 'prev')).toBe(2);
  });

  it('home/end clamp to bounds', () => {
    expect(nextFocusIndex(3, 2, 'home')).toBe(0);
    expect(nextFocusIndex(3, 0, 'end')).toBe(2);
  });

  it('escape/none leave index unchanged', () => {
    expect(nextFocusIndex(3, 1, 'escape')).toBe(1);
    expect(nextFocusIndex(3, 1, 'none')).toBe(1);
  });

  it('empty / zero-count list is a no-op', () => {
    expect(nextFocusIndex(0, 0, 'next')).toBe(0);
  });
});
