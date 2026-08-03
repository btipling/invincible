'use client';
import type { ReactNode } from 'react';

import { teal } from '../../lib/palette';

const focusRing = `0 0 0 2px ${teal.bg}, 0 0 0 4px ${teal.accent}`;

/** Site header: brand + optional right slot (status chips). No Playground/Harness tabs. */
export default function AppNav({ right }: { right?: ReactNode }) {
  return (
    <header
      style={{
        borderBottom: `1px solid ${teal.border}`,
        background: teal.surface,
        padding: '0.85rem 1.25rem',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.75rem 1rem',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          margin: 0,
          fontSize: '1.15rem',
          fontWeight: 600,
          letterSpacing: '0.04em',
          color: teal.text,
          borderRadius: 4,
          outline: 'none',
        }}
      >
        Invincible
      </span>
      {right ? (
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}
        >
          {right}
        </div>
      ) : null}
    </header>
  );
}

// re-export focus helper style for consumers if needed later
export { focusRing };
