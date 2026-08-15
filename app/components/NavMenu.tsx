'use client';

/**
 * NavMenu — DOM site chrome dropdown in the AppNav right slot.
 *
 * A client hamburger trigger that opens an ARIA `menu` holding pre-gated,
 * inert `items` (from the server `AuthNavLinks`; the client holds ZERO role
 * gate logic — it renders descriptors only) plus a ReactNode `footer` slot
 * (the existing `LogoutButton`). Pure site chrome — never a product surface;
 * never a second chat panel.
 *
 * SSR/no-JS is NOT a supported baseline for this control (the product requires
 * JS: Wasm canvas + JS logout action). Keyboard/touch rules:
 * toggle on click/tap; Arrow keys + Home/End rove items (wrap); Tab / Shift+Tab
 * follow the natural document order so tab can reach the footer `LogoutButton`
 * (never hijacked — the keyboard sign-out path stays reachable); Escape closes
 * and returns focus to the trigger; a single document-level `pointerdown`
 * closes on any outside click. Touch targets are ≥ ~44px; items never overflow
 * the header on narrow view (the dropdown is the only overflow-safe surface).
 * The trigger is only focused when the menu closes after being opened — never
 * on first mount — so mounting this control on /harness won't steal the caret
 * from the composer.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { teal } from '../../lib/palette';
import { navMenuKeyAction, nextFocusIndex } from '../../lib/navMenu';
import type { NavItem } from '../../lib/navMenu';

type NavMenuProps = {
  items: NavItem[];
  footer?: ReactNode;
  ariaLabel?: string;
};

const TRIGGER_SIZE = 44;
const MENU_ID = 'nav-account-menu';

const triggerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: TRIGGER_SIZE,
  height: TRIGGER_SIZE,
  padding: 0,
  cursor: 'pointer',
  fontFamily: 'inherit',
  color: teal.accent,
  background: 'transparent',
  border: `1px solid ${teal.border}`,
  borderRadius: 6,
};

const menuStyle: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 'calc(100% + 4px)',
  minWidth: 180,
  padding: '0.35rem',
  borderRadius: 8,
  background: teal.surface,
  border: `1px solid ${teal.border}`,
  boxShadow: `0 6px 18px ${teal.bg}`,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.15rem',
  zIndex: 50,
};

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minHeight: TRIGGER_SIZE,
  padding: '0 0.75rem',
  fontSize: '0.85rem',
  fontWeight: 600,
  color: teal.text,
  textDecoration: 'none',
  borderRadius: 6,
};

const hamburgerBarStyle: CSSProperties = {
  height: 2,
  background: teal.accent,
  borderRadius: 1,
};

export default function NavMenu({ items, footer, ariaLabel = 'Account menu' }: NavMenuProps) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  // Distinguishes a real open→closed transition from a first mount, so the
  // close handler never steals focus back to the trigger on mount.
  const wasOpenRef = useRef(false);

  const close = () => setOpen(false);
  const toggle = () => setOpen((v) => !v);

  // Close on any outside pointerdown while open (single document listener).
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const el = e.target as Node;
      if (rootRef.current && !rootRef.current.contains(el)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // While open, focus the menu container so Arrow/Home/End/Escape are caught
  // here. On a real close (open → false after being open), return focus to the
  // trigger. Crucially the initial mount (open: false, wasOpenRef: false) never
  // focuses the trigger — otherwise AuthNavLinks mounting on /harness would
  // steal the caret from the composer.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      setFocusIndex(0);
      menuRef.current?.focus();
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // Keep the focused item in sync with focusIndex.
  useEffect(() => {
    itemRefs.current[focusIndex]?.focus();
  }, [focusIndex, open]);

  function onMenuKeyDown(e: KeyboardEvent) {
    const action = navMenuKeyAction(e.key);
    if (action === 'none') return; // Tab/Shift+Tab → natural order reaches footer
    if (action === 'escape') {
      close();
      return;
    }
    e.preventDefault();
    setFocusIndex((i) => nextFocusIndex(items.length, i, action));
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? MENU_ID : undefined}
        aria-label={ariaLabel}
        onClick={toggle}
        style={triggerStyle}
      >
        <span
          aria-hidden="true"
          style={{ display: 'flex', flexDirection: 'column', gap: 3, width: 18 }}
        >
          <span style={hamburgerBarStyle} />
          <span style={hamburgerBarStyle} />
          <span style={hamburgerBarStyle} />
        </span>
      </button>

      {open ? (
        <div
          ref={menuRef}
          id={MENU_ID}
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={onMenuKeyDown}
          tabIndex={-1}
          style={{ ...menuStyle, outline: 'none' }}
        >
          {items.map((item, idx) => (
            <Link
              key={item.href + item.label}
              href={item.href}
              role="menuitem"
              ref={(el) => {
                itemRefs.current[idx] = el;
              }}
              onClick={close}
              onMouseEnter={() => setFocusIndex(idx)}
              style={{
                ...itemStyle,
                background: idx === focusIndex ? teal.bg : 'transparent',
                color: idx === focusIndex ? teal.accent : teal.text,
                boxShadow:
                  idx === focusIndex ? `inset 0 0 0 1px ${teal.accent}` : 'none',
                borderBottom: `1px solid ${teal.border}`,
              }}
            >
              {item.label}
            </Link>
          ))}
          {footer ? (
            <div
              onKeyDown={(e) => {
                if (e.key === 'Escape') close();
              }}
              style={{
                borderTop: `1px solid ${teal.border}`,
                marginTop: '0.15rem',
                paddingTop: '0.15rem',
              }}
            >
              {footer}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
