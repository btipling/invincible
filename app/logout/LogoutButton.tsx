'use client';

import type { CSSProperties } from 'react';
import { createDefaultSessionStore } from '../../lib/sessionStore';
import { logoutAction } from './actions';

const btnBase: CSSProperties = {
  cursor: 'pointer',
  fontFamily: 'inherit',
};

/**
 * Log out: clear local harness session blob, then Auth.js signOut → /login.
 */
export function LogoutButton({ style }: { style?: CSSProperties }) {
  async function onLogout() {
    try {
      createDefaultSessionStore().clear();
    } catch {
      // ignore storage failures
    }
    await logoutAction();
  }

  return (
    <form action={onLogout} style={{ margin: 0, display: 'inline' }}>
      <button type="submit" style={{ ...style, ...btnBase }}>
        Log out
      </button>
    </form>
  );
}
