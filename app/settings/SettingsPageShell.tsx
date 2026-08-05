import type { ReactNode } from 'react';
import { ember, teal, warm } from '../../lib/palette';
import type { SettingsContext, SettingsGateResult } from './load';

export async function SettingsPageShell({
  title,
  gate,
  children,
}: {
  title: string;
  gate: SettingsGateResult;
  children: (ctx: SettingsContext) => ReactNode | Promise<ReactNode>;
}) {
  if (!gate.ok) {
    return (
      <main
        style={{
          padding: 24,
          maxWidth: 880,
          margin: '0 auto',
          width: '100%',
          boxSizing: 'border-box',
        }}
      >
        <h1 style={{ margin: '0 0 8px', fontSize: 22 }}>{title}</h1>
        {gate.kind === 'tenancy_off' ? (
          <p style={{ color: teal.muted, margin: 0 }}>
            Tenancy is not enabled. Set{' '}
            <code style={{ color: warm.accent }}>DATABASE_URL</code>,{' '}
            <code style={{ color: warm.accent }}>AUTH_SECRET</code>, and{' '}
            <code style={{ color: warm.accent }}>CREDENTIALS_ENCRYPTION_KEY</code> to
            use Settings.
          </p>
        ) : (
          <>
            <p role="alert" style={{ color: ember.accent, margin: 0 }}>
              {gate.message}
            </p>
            <p style={{ color: teal.muted, fontSize: 14, marginTop: 12 }}>
              {gate.hint}
            </p>
          </>
        )}
      </main>
    );
  }

  const body = await children(gate.value);

  return (
    <main
      style={{
        padding: 24,
        maxWidth: 960,
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <h1 style={{ margin: '0 0 16px', fontSize: 22 }}>{title}</h1>
      {body}
    </main>
  );
}
