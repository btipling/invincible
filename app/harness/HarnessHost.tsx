'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_MODEL_LABEL } from '../../lib/chatApi';
import { HARNESS_SMOKE_PROMPT, runHarnessChat } from '../../lib/harnessChat';
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
type ChatUi = 'idle' | 'busy' | 'ok' | 'fail';

/** Shape of dvui web.js module (static asset, not bundled). */
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

export default function HarnessHost() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bridgeRef = useRef<HarnessBridge | null>(null);
  const pollRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef(false);

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<string>('boot');
  const [chatUi, setChatUi] = useState<ChatUi>('idle');
  const [chatHint, setChatHint] = useState<string | null>(null);
  const [domPrompt, setDomPrompt] = useState('');

  const runPrompt = useCallback(async (prompt: string) => {
    const bridge = bridgeRef.current;
    if (!bridge || inflightRef.current) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    inflightRef.current = true;
    setChatUi('busy');
    setChatHint('Calling /api/chat…');
    setLifecycle(lifecycleName(Lifecycle.Busy));

    try {
      const result = await runHarnessChat(bridge, prompt, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) {
        setChatUi('ok');
        setChatHint(result.text.length > 120 ? result.text.slice(0, 117) + '…' : result.text);
        setLifecycle(lifecycleName(Lifecycle.Ready));
      } else {
        setChatUi('fail');
        setChatHint(result.error);
        setLifecycle(lifecycleName(Lifecycle.Ready));
      }
    } finally {
      inflightRef.current = false;
    }
  }, []);

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

        const rt = bridge.assertRoundTrip('hello-bridge');

        bridge.setLifecycle(Lifecycle.Ready);
        bridge.clearMessages();
        bridge.pushMessage(
          MessageKind.System,
          `Bridge online (v${rt.protocol}). Inference via host /api/chat · model ${DEFAULT_MODEL_LABEL}.`,
        );

        setLifecycle(lifecycleName(Lifecycle.Ready));
        setBridgeNote(
          `protocol v${rt.protocol} · echo ok · ${DEFAULT_MODEL_LABEL}`,
        );

        // Poll Wasm → JS submit queue (Send / Smoke in canvas).
        const poll = () => {
          if (cancelled) return;
          const b = bridgeRef.current;
          if (b && !inflightRef.current) {
            const pending = b.takePendingSubmit();
            if (pending != null && pending.length > 0) {
              void runPrompt(pending);
            }
          }
          pollRef.current = window.setTimeout(poll, 150);
        };
        pollRef.current = window.setTimeout(poll, 150);

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
      abortRef.current?.abort();
      if (pollRef.current != null) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
      bridgeRef.current = null;
    };
  }, [runPrompt]);

  const onDomSend = useCallback(() => {
    if (phase !== 'ready' || inflightRef.current) return;
    void runPrompt(domPrompt);
  }, [domPrompt, phase, runPrompt]);

  const onSmoke = useCallback(() => {
    if (phase !== 'ready' || inflightRef.current) return;
    setDomPrompt(HARNESS_SMOKE_PROMPT);
    void runPrompt(HARNESS_SMOKE_PROMPT);
  }, [phase, runPrompt]);

  const busy = chatUi === 'busy' || phase === 'loading';

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
                color:
                  phase === 'error' || chatUi === 'fail'
                    ? ember.accent
                    : chatUi === 'busy'
                      ? warm.accent
                      : warm.muted,
                border: `1px solid ${
                  phase === 'error' || chatUi === 'fail'
                    ? ember.border
                    : chatUi === 'busy'
                      ? warm.border
                      : warm.border
                }`,
                background:
                  phase === 'error' || chatUi === 'fail'
                    ? ember.surface
                    : chatUi === 'busy'
                      ? warm.surface
                      : warm.surface,
                borderRadius: 4,
                padding: '0.2rem 0.5rem',
              }}
            >
              {phase === 'loading' && 'loading wasm…'}
              {phase === 'ready' && `harness · ${lifecycle}`}
              {phase === 'error' && 'harness error'}
            </span>
          </span>
        }
      />

      {phase === 'ready' && (
        <div
          style={{
            borderBottom: `1px solid ${teal.border}`,
            background: teal.surface,
            padding: '0.55rem 1rem',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'center',
          }}
        >
          <input
            type="text"
            value={domPrompt}
            onChange={(e) => setDomPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onDomSend();
              }
            }}
            placeholder="Prompt (host → /api/chat)…"
            disabled={busy}
            aria-label="Harness prompt"
            style={{
              flex: '1 1 200px',
              minWidth: 0,
              background: teal.bg,
              color: teal.text,
              border: `1px solid ${teal.border}`,
              borderRadius: 6,
              padding: '0.45rem 0.65rem',
              fontSize: '0.9rem',
            }}
          />
          <button
            type="button"
            onClick={onDomSend}
            disabled={busy}
            style={{
              background: teal.accent,
              color: teal.bg,
              border: 'none',
              borderRadius: 6,
              padding: '0.45rem 0.85rem',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
          <button
            type="button"
            onClick={onSmoke}
            disabled={busy}
            title={HARNESS_SMOKE_PROMPT}
            style={{
              background: warm.surface,
              color: warm.accent,
              border: `1px solid ${warm.border}`,
              borderRadius: 6,
              padding: '0.45rem 0.75rem',
              fontWeight: 600,
              fontSize: '0.8rem',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
            }}
          >
            Smoke: PONG
          </button>
          {chatHint && (
            <span
              role="status"
              style={{
                flex: '1 1 100%',
                fontSize: '0.78rem',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: chatUi === 'fail' ? ember.accent : teal.muted,
                lineHeight: 1.35,
              }}
            >
              {chatUi === 'fail' ? 'Error: ' : chatUi === 'busy' ? '' : 'Last: '}
              {chatHint}
            </span>
          )}
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
