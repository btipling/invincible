import type { ReactNode } from 'react';
import { ember, teal, warm } from '../../lib/palette';
import type { AdminContext } from '../../lib/tenancy/adminContext';
import type { AdminGateResult } from './load';

export async function AdminPageShell({
  title,
  gate,
  children,
}: {
  title: string;
  gate: AdminGateResult;
  children: (ctx: AdminContext) => ReactNode | Promise<ReactNode>;
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
        <p role="alert" style={{ color: ember.accent, margin: 0 }}>
          {gate.message}
        </p>
        <p style={{ color: teal.muted, fontSize: 14, marginTop: 12 }}>
          {gate.hint}
        </p>
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
      <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 650 }}>{title}</h1>
      <p style={{ margin: '0 0 20px', color: teal.muted, fontSize: 14 }}>
        {gate.value.tenant.name} ·{' '}
        <span style={{ color: teal.text }}>
          {gate.value.user.email ?? gate.value.user.id}
        </span>
        {' · '}
        <span style={{ color: warm.accent, fontWeight: 600 }}>{gate.value.role}</span>
      </p>
      {body}
    </main>
  );
}
