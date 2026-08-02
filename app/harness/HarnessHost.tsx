'use client';

import { useEffect, useRef, useState } from 'react';
import {
  HarnessBridge,
  HARNESS_PROTOCOL_VERSION,
  Lifecycle,
  MessageKind,
  lifecycleName,
} from '../../lib/harnessBridge';
import { ember, teal, warm } from '../../lib/palette';
import AppNav from '../components/AppNav';

type Phase = 'loading' | 'ready' | 'error';

/** Shape of dvui web.js module (static asset, not bundled). */
type DvuiModule = {
  dvui: (
    canvas: string | HTMLCanvasElement,
    wasmRef: string | WebAssembly.WebAssemblyInstantiatedSource,
  ) => Promise<DvuiHost> | DvuiHost;
  Dvui?: new () => DvuiHost;
};

type DvuiHost = {
  instance: WebAssembly.Instance;
  stop?: () => void;
};

async function loadDvuiGlue(): Promise<DvuiModule> {
  const href = '/harness/web.js';
  return import(/* webpackIgnore: true */ /* @vite-ignore */ href) as Promise<DvuiModule>;
}

export default function HarnessHost() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bridgeRef = useRef<HarnessBridge | null>(null);
  const pollRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);
  const [lastSubmit, setLastSubmit] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<string>('boot');

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

        const host = await Promise.resolve(mod.dvui(canvas, '/harness/harness.wasm'));
        if (cancelled) return;

        const created = HarnessBridge.fromInstance(host.instance);
        if (!created.ok) {
          throw new Error(created.error);
        }
        const bridge = created.bridge;
        bridgeRef.current = bridge;

        // JS → Wasm → JS round-trip (no network) — acceptance for 3.6.
        const rt = bridge.assertRoundTrip('hello-bridge');

        bridge.setLifecycle(Lifecycle.Ready);
        bridge.clearMessages();
        bridge.pushMessage(MessageKind.System, 'Bridge online (protocol v' + rt.protocol + ').');
        bridge.pushMessage(MessageKind.User, 'echo: hello-bridge');
        bridge.pushMessage(MessageKind.Assistant, 'echo ok · ping=0x' + rt.ping.toString(16));

        setLifecycle(lifecycleName(Lifecycle.Ready));
        setBridgeNote(
          `protocol v${rt.protocol} · echo ok · ping 0x${(rt.ping >>> 0).toString(16)}`,
        );

        // Poll Wasm → JS submit queue (button in canvas UI).
        const poll = () => {
          if (cancelled) return;
          const b = bridgeRef.current;
          if (b) {
            const pending = b.takePendingSubmit();
            if (pending != null) {
              setLastSubmit(pending);
              // Acknowledge path: host would call /api/chat in 3.7; for 3.6 just mirror.
              b.pushMessage(MessageKind.System, 'host received submit: ' + pending);
            }
          }
          pollRef.current = window.setTimeout(poll, 200);
        };
        pollRef.current = window.setTimeout(poll, 200);

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
      if (pollRef.current != null) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
      bridgeRef.current = null;
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
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.35rem',
              alignItems: 'center',
              justifyContent: 'flex-end',
            }}
          >
            {bridgeNote && phase === 'ready' && (
              <span
                style={{
                  fontSize: '0.7rem',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: teal.muted,
                  border: `1px solid ${teal.border}`,
                  background: teal.surface,
                  borderRadius: 4,
                  padding: '0.2rem 0.45rem',
                  maxWidth: 280,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={bridgeNote}
              >
                {bridgeNote}
              </span>
            )}
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
              {phase === 'ready' && `harness ready · ${lifecycle}`}
              {phase === 'error' && 'harness error'}
            </span>
          </span>
        }
      />

      {lastSubmit != null && phase === 'ready' && (
        <div
          role="status"
          style={{
            borderBottom: `1px solid ${teal.border}`,
            background: teal.surface,
            color: teal.text,
            fontSize: '0.8rem',
            padding: '0.4rem 1.25rem',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          Wasm → JS submit:{' '}
          <span style={{ color: warm.accent }}>{lastSubmit}</span>
          <span style={{ color: teal.muted }}>
            {' '}
            (stub — /api/chat wires in 3.7 · host protocol v{HARNESS_PROTOCOL_VERSION})
          </span>
        </div>
      )}

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
              <code style={{ color: teal.accent }}>harness-wasm</code>. Bridge needs protocol v
              {HARNESS_PROTOCOL_VERSION} exports (<code style={{ color: teal.accent }}>inv_*</code>
              ).
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
