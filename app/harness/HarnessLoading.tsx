import { teal, warm } from '../../lib/palette';

/** Shared loading chrome for route segment + dynamic import fallback. */
export default function HarnessLoading({ label = 'Loading agent harness…' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.75rem',
        background: teal.bg,
        color: teal.muted,
        padding: '1.5rem',
        boxSizing: 'border-box',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          border: `3px solid ${teal.border}`,
          borderTopColor: teal.accent,
          animation: 'inv-spin 0.8s linear infinite',
        }}
        aria-hidden
      />
      <p style={{ margin: 0, fontSize: '0.95rem', color: teal.text }}>{label}</p>
      <p style={{ margin: 0, fontSize: '0.8rem', maxWidth: 320, lineHeight: 1.45 }}>
        Fetching Wasm runtime and bridge. First load may take a few seconds.
      </p>
      <p
        style={{
          margin: 0,
          fontSize: '0.72rem',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: warm.muted,
        }}
      >
        /harness · Zig + dvui
      </p>
      <style>{`@keyframes inv-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
