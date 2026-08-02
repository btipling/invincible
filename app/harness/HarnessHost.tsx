'use client';

import { useEffect, useRef, useState } from 'react';
import { ember, teal, warm } from '../../lib/palette';
import AppNav from '../components/AppNav';

type Phase = 'loading' | 'ready' | 'error';

type DvuiModule = {
  dvui: (
    canvas: string | HTMLCanvasElement,
    wasmRef: string,
  ) => Promise<unknown> | unknown;
};

async function loadDvuiGlue(): Promise<DvuiModule> {
  // Dynamic URL import of static public asset (not resolved by tsc/webpack).
  const href = '/harness/web.js';
  return import(/* webpackIgnore: true */ /* @vite-ignore */ href) as Promise<DvuiModule>;
}

export default function HarnessHost() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    (async () => {
      try {
        const head = await fetch('/harness/harness.wasm', { method: 'HEAD' });
        if (!head.ok) {
          throw new Error(
            `harness.wasm missing (${head.status}). Ensure build-harness CI produced harness-wasm and Vercel has HARNESS_ARTIFACT_TOKEN (Actions: Read).`,
          );
        }

        const mod = await loadDvuiGlue();
        if (cancelled) return;

        await Promise.resolve(mod.dvui(canvas, '/harness/harness.wasm'));
        if (!cancelled) {
          setPhase('ready');
          canvas.focus();
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        minHeight: '100vh',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: teal.bg,
        color: teal.text,
        boxSizing: 'border-box',
      }}
    >
      <AppNav
        right={
          <span
            style={{
              fontSize: '0.75rem',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: phase === 'error' ? ember.accent : warm.muted,
              border: `1px solid ${phase === 'error' ? ember.border : warm.border}`,
              background: phase === 'error' ? ember.surface : warm.surface,
              borderRadius: 4,
              padding: '0.2rem 0.5rem',
            }}
          >
            {phase === 'loading' && 'loading wasm…'}
            {phase === 'ready' && 'harness ready'}
            {phase === 'error' && 'harness error'}
          </span>
        }
      />

      <div
        style={{
          flex: 1,
          position: 'relative',
          minHeight: 0,
          background: teal.clear,
        }}
      >
        <canvas
          id="harness-canvas"
          ref={canvasRef}
          tabIndex={1}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            outline: 'none',
            caretColor: 'transparent',
            touchAction: 'none',
          }}
        />

        {phase === 'loading' && (
          <div
            role="status"
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              background: 'rgba(5, 10, 12, 0.55)',
              color: teal.muted,
              fontSize: '0.95rem',
            }}
          >
            Loading harness…
          </div>
        )}

        {phase === 'error' && (
          <div
            role="alert"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              maxWidth: 420,
              width: 'calc(100% - 2rem)',
              border: `1px solid ${ember.border}`,
              background: ember.surface,
              color: ember.text,
              borderRadius: 8,
              padding: '1rem 1.1rem',
              boxSizing: 'border-box',
            }}
          >
            <div
              style={{
                fontWeight: 600,
                marginBottom: '0.4rem',
                color: ember.accent,
              }}
            >
              Could not start harness
            </div>
            <div style={{ fontSize: '0.9rem', lineHeight: 1.45 }}>{error}</div>
            <div
              style={{
                marginTop: '0.75rem',
                fontSize: '0.8rem',
                color: teal.muted,
                lineHeight: 1.4,
              }}
            >
              Rebuild on <code style={{ color: teal.accent }}>invincible-do-1</code> (workflow{' '}
              <code style={{ color: teal.accent }}>build-harness</code>), then redeploy Vercel so{' '}
              <code style={{ color: teal.accent }}>npm run prebuild</code> fetches artifact{' '}
              <code style={{ color: teal.accent }}>harness-wasm</code>.
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
