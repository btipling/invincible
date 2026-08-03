'use client';

import { useEffect } from 'react';
import { ember, teal } from '../../lib/palette';

export default function HarnessError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[harness]', error.message);
  }, [error]);

  return (
    <main
      role="alert"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: teal.bg,
        color: teal.text,
        padding: '1.25rem',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          maxWidth: 440,
          width: '100%',
          border: `1px solid ${ember.border}`,
          background: ember.surface,
          color: ember.text,
          borderRadius: 10,
          padding: '1.15rem 1.2rem',
        }}
      >
        <h1
          style={{
            margin: '0 0 0.4rem',
            fontSize: '1.05rem',
            color: ember.accent,
          }}
        >
          Harness failed to load
        </h1>
        <p style={{ margin: '0 0 0.85rem', fontSize: '0.9rem', lineHeight: 1.45 }}>
          {error.message || 'Unexpected error.'}
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            appearance: 'none',
            border: 'none',
            borderRadius: 6,
            padding: '0.5rem 0.9rem',
            fontWeight: 600,
            fontSize: '0.85rem',
            cursor: 'pointer',
            background: teal.accent,
            color: teal.bg,
          }}
        >
          Try again
        </button>
      </div>
    </main>
  );
}
