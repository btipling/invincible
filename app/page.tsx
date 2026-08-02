import { teal, warm } from '../lib/palette';

/**
 * Phase 1.2 scaffold shell.
 * Phase 1.3 will replace this with the prompt UI.
 */
export default function Page() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        background: teal.bg,
        color: teal.text,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 720,
          border: `1px solid ${teal.border}`,
          background: teal.surface,
          borderRadius: 8,
          padding: '1.5rem 1.75rem',
        }}
      >
        <h1
          style={{
            margin: '0 0 0.5rem',
            fontSize: '1.5rem',
            fontWeight: 600,
            color: teal.text,
            letterSpacing: '0.02em',
          }}
        >
          Invincible
        </h1>
        <p style={{ margin: '0 0 1rem', color: teal.muted, fontSize: '0.95rem' }}>
          Phase 1.2 scaffold — Next.js 15 + AI SDK + Asteronica palette.
        </p>
        <p style={{ margin: 0, fontSize: '0.85rem', color: warm.muted }}>
          Next: Phase 1.3 prompt UI · 1.4 AI Gateway route · 1.5 Vercel deploy
        </p>
      </div>
    </main>
  );
}
