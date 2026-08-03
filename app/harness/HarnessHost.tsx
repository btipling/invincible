'use client';

/**
 * Phase 4 host shell — DOM loads Wasm, owns network/session, does NOT host chat UI.
 * Product transcript + composer live in Zig/dvui (see docs/feature-divide.md).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_MODEL_LABEL } from '../../lib/chatApi';
import { runHarnessTurn, pushSessionToBridge } from '../../lib/harnessChat';
import {
  HarnessBridge,
  HARNESS_PROTOCOL_VERSION,
  Lifecycle,
  MessageKind,
  lifecycleName,
} from '../../lib/harnessBridge';
import { ember, teal, warm } from '../../lib/palette';
import {
  createDefaultSessionStore,
  createEmptySession,
  type SessionSnapshot,
  type SessionStore,
} from '../../lib/sessionStore';
import AppNav from '../components/AppNav';
import HarnessLoading from './HarnessLoading';

type Phase = 'loading' | 'ready' | 'error';

type DvuiModule = {
  dvui: (
    canvas: string | HTMLCanvasElement,
    wasmRef: string | WebAssembly.WebAssemblyInstantiatedSource,
  ) => Promise<DvuiHost> | DvuiHost;
};

type DvuiHost = {
  instance: WebAssembly.Instance;
  stop?: () => void;
};

async function loadDvuiGlue(): Promise<DvuiModule> {
  const href = '/harness/web.js';
  return import(/* webpackIgnore: true */ /* @vite-ignore */ href) as Promise<DvuiModule>;
}

export default function HarnessHost({ authNav }: { authNav?: ReactNode } = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bridgeRef = useRef<HarnessBridge | null>(null);
  const storeRef = useRef<SessionStore | null>(null);
  const pollRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef(false);
  const sessionRef = useRef<SessionSnapshot>(createEmptySession());
  const loadStarted = useRef(
    typeof performance !== 'undefined' ? performance.now() : 0,
  );

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<string>('boot');
  const [busy, setBusy] = useState(false);
  const [storeKind, setStoreKind] = useState<string>('memory');
  const [loadMs, setLoadMs] = useState<number | null>(null);
  const [hostNote, setHostNote] = useState<string | null>(null);

  const persist = useCallback((next: SessionSnapshot) => {
    sessionRef.current = next;
    storeRef.current?.save(next);
  }, []);

  const runPrompt = useCallback(
    async (prompt: string) => {
      const bridge = bridgeRef.current;
      if (!bridge || inflightRef.current) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      inflightRef.current = true;
      setBusy(true);
      setHostNote(null);
      setLifecycle(lifecycleName(Lifecycle.Busy));

      try {
        const { result, session: next } = await runHarnessTurn(
          bridge,
          sessionRef.current,
          prompt,
          {
            signal: controller.signal,
            // Wasm already painted the user line in queueSubmitFromUi.
            pushUser: false,
          },
        );
        if (controller.signal.aborted) return;
        persist(next);
        if (!result.ok) {
          setHostNote(result.error);
        }
        setLifecycle(lifecycleName(Lifecycle.Ready));
      } finally {
        inflightRef.current = false;
        setBusy(false);
      }
    },
    [persist],
  );

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;

    (async () => {
      try {
        const store = createDefaultSessionStore();
        storeRef.current = store;
        setStoreKind(store.kind);

        const head = await fetch('/harness/harness.wasm', { method: 'HEAD' });
        if (!head.ok) {
          throw new Error(
            `harness.wasm missing (${head.status}). Ensure build-harness CI produced harness-wasm and Vercel has HARNESS_ARTIFACT_TOKEN.`,
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

        bridge.assertRoundTrip('hello-bridge');
        bridge.setLifecycle(Lifecycle.Ready);

        const restored = store.load();
        if (restored && restored.messages.some((m) => m.role === 'user' || m.role === 'assistant')) {
          sessionRef.current = restored;
          pushSessionToBridge(bridge, restored, { clear: true });
        } else {
          const empty = createEmptySession();
          sessionRef.current = empty;
          bridge.clearMessages();
          bridge.pushMessage(
            MessageKind.System,
            `Invincible harness · ${DEFAULT_MODEL_LABEL} · type below, Enter to send`,
          );
        }

        setLoadMs(Math.round(performance.now() - loadStarted.current));
        setLifecycle(lifecycleName(Lifecycle.Ready));

        const poll = () => {
          if (cancelled) return;
          const b = bridgeRef.current;
          if (b) {
            // Reflect Wasm lifecycle on host chip (busy set by canvas submit).
            try {
              setLifecycle(lifecycleName(b.getLifecycle()));
            } catch {
              /* ignore */
            }
            if (!inflightRef.current) {
              const pending = b.takePendingSubmit();
              if (pending != null && pending.length > 0) {
                void runPrompt(pending);
              }
            }
          }
          pollRef.current = window.setTimeout(poll, 150);
        };
        pollRef.current = window.setTimeout(poll, 150);

        if (!cancelled) {
          setPhase('ready');
          requestAnimationFrame(() => canvasRef.current?.focus());
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
      abortRef.current?.abort();
      if (pollRef.current != null) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
      bridgeRef.current = null;
    };
  }, [runPrompt]);

  const onClear = useCallback(() => {
    if (inflightRef.current) return;
    abortRef.current?.abort();
    const empty = createEmptySession();
    persist(empty);
    storeRef.current?.clear();
    storeRef.current?.save(empty);
    const bridge = bridgeRef.current;
    if (bridge) {
      bridge.clearMessages();
      bridge.pushMessage(MessageKind.System, 'Session cleared.');
      bridge.setLifecycle(Lifecycle.Ready);
    }
    setHostNote(null);
    setLifecycle(lifecycleName(Lifecycle.Ready));
    canvasRef.current?.focus();
  }, [persist]);

  // Single always-mounted canvas — never unmount across phase changes.
  const canvasNode = (
    <canvas
      id="harness-canvas"
      ref={canvasRef}
      tabIndex={phase === 'ready' ? 0 : -1}
      aria-label={phase === 'ready' ? 'Invincible agent harness' : undefined}
      aria-hidden={phase !== 'ready'}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        outline: 'none',
        caretColor: 'transparent',
        touchAction: 'none',
        background: teal.clear,
      }}
    />
  );

  return (
    <main
      style={{
        height: '100vh',
        maxHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: teal.bg,
        color: teal.text,
        boxSizing: 'border-box',
        overflow: 'hidden',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {phase === 'loading' && <HarnessLoading label="Loading harness runtime…" />}

      {phase !== 'loading' && (
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
              <span
                style={{
                  fontSize: '0.7rem',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: warm.muted,
                  border: `1px solid ${warm.border}`,
                  background: warm.surface,
                  borderRadius: 4,
                  padding: '0.2rem 0.45rem',
                }}
                title="Server routes this model via AI Gateway"
              >
                {DEFAULT_MODEL_LABEL}
              </span>
              <span
                style={{
                  fontSize: '0.7rem',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color: teal.muted,
                  border: `1px solid ${teal.border}`,
                  background: teal.surface,
                  borderRadius: 4,
                  padding: '0.2rem 0.45rem',
                }}
                title={`Session store: ${storeKind}${loadMs != null ? ` · ready in ${loadMs}ms` : ''}`}
              >
                {storeKind}
                {loadMs != null ? ` · ${loadMs}ms` : ''}
              </span>
              <span
                role="status"
                aria-live="polite"
                style={{
                  fontSize: '0.75rem',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  color:
                    phase === 'error' ? ember.accent : busy ? warm.accent : warm.muted,
                  border: `1px solid ${phase === 'error' ? ember.border : warm.border}`,
                  background: phase === 'error' ? ember.surface : warm.surface,
                  borderRadius: 4,
                  padding: '0.2rem 0.5rem',
                }}
              >
                {phase === 'ready' && (busy ? 'thinking…' : `ready · ${lifecycle}`)}
                {phase === 'error' && 'error'}
              </span>
              {phase === 'ready' && (
                <button
                  type="button"
                  onClick={onClear}
                  disabled={busy}
                  style={{
                    appearance: 'none',
                    borderRadius: 4,
                    fontWeight: 600,
                    fontSize: '0.72rem',
                    padding: '0.2rem 0.5rem',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    background: 'transparent',
                    border: `1px solid ${teal.border}`,
                    color: teal.muted,
                    opacity: busy ? 0.5 : 1,
                  }}
                >
                  Clear
                </button>
              )}
              {authNav}
            </span>
          }
        />
      )}

      {phase === 'error' && (
        <div
          role="alert"
          style={{
            margin: '0.75rem 1rem 0',
            border: `1px solid ${ember.border}`,
            background: ember.surface,
            color: ember.text,
            borderRadius: 8,
            padding: '0.85rem 1rem',
            fontSize: '0.9rem',
            lineHeight: 1.45,
            flexShrink: 0,
          }}
        >
          <div style={{ fontWeight: 600, color: ember.accent, marginBottom: '0.35rem' }}>
            Could not start harness
          </div>
          <div>{error}</div>
          <div style={{ marginTop: '0.5rem', fontSize: '0.78rem', color: teal.muted }}>
            Rebuild on invincible-do-1 (build-harness), redeploy Vercel. Protocol v
            {HARNESS_PROTOCOL_VERSION}. See docs/phase-4-plan.md.
          </div>
        </div>
      )}

      {hostNote && phase === 'ready' && (
        <div
          role="status"
          style={{
            margin: '0.5rem 1rem 0',
            fontSize: '0.75rem',
            color: ember.muted,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            flexShrink: 0,
          }}
        >
          host: {hostNote}
        </div>
      )}

      <div
        style={
          phase === 'loading'
            ? {
                position: 'fixed',
                width: 4,
                height: 4,
                left: 0,
                top: 0,
                opacity: 0.01,
                pointerEvents: 'none',
                zIndex: -1,
              }
            : {
                flex: 1,
                minHeight: 200,
                position: 'relative',
                background: teal.clear,
                borderTop: phase === 'ready' ? `1px solid ${teal.border}` : undefined,
              }
        }
      >
        {canvasNode}
      </div>
    </main>
  );
}
