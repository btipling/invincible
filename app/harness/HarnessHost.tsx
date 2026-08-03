'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { DEFAULT_MODEL_LABEL } from '../../lib/chatApi';
import { HARNESS_SMOKE_PROMPT, runHarnessTurn } from '../../lib/harnessChat';
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
  type SessionMessage,
  type SessionSnapshot,
  type SessionStore,
} from '../../lib/sessionStore';
import AppNav from '../components/AppNav';
import HarnessLoading from './HarnessLoading';

type Phase = 'loading' | 'ready' | 'error';
type ChatUi = 'idle' | 'busy' | 'ok' | 'fail';

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

const focusRing = `0 0 0 2px ${teal.bg}, 0 0 0 4px ${teal.accent}`;

function bubbleColors(role: SessionMessage['role']): {
  border: string;
  bg: string;
  label: string;
  text: string;
} {
  switch (role) {
    case 'user':
      return { border: teal.accent, bg: teal.bg, label: teal.accent, text: teal.text };
    case 'assistant':
      return { border: teal.border, bg: teal.surface, label: warm.accent, text: teal.text };
    case 'error':
      return { border: ember.border, bg: ember.surface, label: ember.accent, text: ember.text };
    case 'system':
    default:
      return { border: teal.border, bg: teal.clear, label: teal.muted, text: teal.muted };
  }
}

function roleLabel(role: SessionMessage['role']): string {
  switch (role) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Assistant';
    case 'error':
      return 'Error';
    case 'system':
      return 'System';
  }
}

const btnBase: CSSProperties = {
  appearance: 'none',
  borderRadius: 6,
  fontWeight: 600,
  cursor: 'pointer',
  outline: 'none',
};

export default function HarnessHost() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
  const [chatUi, setChatUi] = useState<ChatUi>('idle');
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [domPrompt, setDomPrompt] = useState('');
  const [session, setSession] = useState<SessionSnapshot>(() => createEmptySession());
  const [storeKind, setStoreKind] = useState<string>('memory');
  const [showCanvas, setShowCanvas] = useState(false);
  const [loadMs, setLoadMs] = useState<number | null>(null);

  const persist = useCallback((next: SessionSnapshot) => {
    sessionRef.current = next;
    setSession(next);
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
      setChatUi('busy');
      setStatusLine('Waiting for model…');
      setLifecycle(lifecycleName(Lifecycle.Busy));

      try {
        const { result, session: next } = await runHarnessTurn(
          bridge,
          sessionRef.current,
          prompt,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        persist(next);
        if (result.ok) {
          setChatUi('ok');
          setStatusLine(null);
          setLifecycle(lifecycleName(Lifecycle.Ready));
          setDomPrompt('');
        } else {
          setChatUi('fail');
          setStatusLine(result.error);
          setLifecycle(lifecycleName(Lifecycle.Ready));
        }
      } finally {
        inflightRef.current = false;
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

        bridge.assertRoundTrip('hello-bridge');
        bridge.setLifecycle(Lifecycle.Ready);

        const restored = store.load();
        if (restored && restored.messages.some((m) => m.role === 'user' || m.role === 'assistant')) {
          sessionRef.current = restored;
          setSession(restored);
          bridge.clearMessages();
          for (const m of restored.messages) {
            const kind =
              m.role === 'user'
                ? MessageKind.User
                : m.role === 'assistant'
                  ? MessageKind.Assistant
                  : m.role === 'error'
                    ? MessageKind.Error
                    : MessageKind.System;
            bridge.pushMessage(kind, m.text);
          }
        } else {
          const empty = createEmptySession();
          sessionRef.current = empty;
          setSession(empty);
          bridge.clearMessages();
          bridge.pushMessage(
            MessageKind.System,
            `Invincible harness ready · ${DEFAULT_MODEL_LABEL} · ⌘/Ctrl+Enter to send`,
          );
        }

        setLoadMs(Math.round(performance.now() - loadStarted.current));
        setLifecycle(lifecycleName(Lifecycle.Ready));

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
          requestAnimationFrame(() => textareaRef.current?.focus());
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

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session.messages, chatUi]);

  const busy = chatUi === 'busy' || phase === 'loading';

  const onDomSend = useCallback(() => {
    if (phase !== 'ready' || inflightRef.current) return;
    void runPrompt(domPrompt);
  }, [domPrompt, phase, runPrompt]);

  const onSmoke = useCallback(() => {
    if (phase !== 'ready' || inflightRef.current) return;
    setDomPrompt(HARNESS_SMOKE_PROMPT);
    void runPrompt(HARNESS_SMOKE_PROMPT);
  }, [phase, runPrompt]);

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
    setChatUi('idle');
    setStatusLine(null);
    setDomPrompt('');
    setLifecycle(lifecycleName(Lifecycle.Ready));
    textareaRef.current?.focus();
  }, [persist]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (phase === 'ready' && chatUi !== 'busy') onDomSend();
      }
    },
    [onDomSend, phase, chatUi],
  );

  const turns = session.messages.filter((m) => m.role !== 'system');
  const isEmpty = turns.length === 0;
  const canvasExpanded = showCanvas || phase === 'error';

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
      {phase === 'loading' && <HarnessLoading label="Loading Wasm runtime…" />}

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
                    phase === 'error' || chatUi === 'fail'
                      ? ember.accent
                      : chatUi === 'busy'
                        ? warm.accent
                        : warm.muted,
                  border: `1px solid ${
                    phase === 'error' || chatUi === 'fail' ? ember.border : warm.border
                  }`,
                  background:
                    phase === 'error' || chatUi === 'fail' ? ember.surface : warm.surface,
                  borderRadius: 4,
                  padding: '0.2rem 0.5rem',
                }}
              >
                {phase === 'ready' && (chatUi === 'busy' ? 'thinking…' : `ready · ${lifecycle}`)}
                {phase === 'error' && 'error'}
              </span>
            </span>
          }
        />
      )}

      {phase === 'ready' && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            maxWidth: 820,
            width: '100%',
            margin: '0 auto',
            boxSizing: 'border-box',
            padding: '0.75rem 0.85rem 0.85rem',
            gap: '0.65rem',
          }}
        >
          <section
            aria-label="Conversation"
            style={{
              flex: 1,
              minHeight: 160,
              display: 'flex',
              flexDirection: 'column',
              border: `1px solid ${teal.border}`,
              background: teal.surface,
              borderRadius: 10,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.55rem 0.85rem',
                borderBottom: `1px solid ${teal.border}`,
                flexWrap: 'wrap',
              }}
            >
              <h1
                style={{
                  margin: 0,
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: teal.muted,
                }}
              >
                Agent
              </h1>
              <span style={{ fontSize: '0.75rem', color: teal.muted }}>
                multi-turn · host Gateway
              </span>
              <div
                style={{ marginLeft: 'auto', display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}
              >
                <button
                  type="button"
                  onClick={() => setShowCanvas((v) => !v)}
                  style={{
                    ...btnBase,
                    background: 'transparent',
                    border: `1px solid ${teal.border}`,
                    color: teal.muted,
                    borderRadius: 4,
                    padding: '0.2rem 0.5rem',
                    fontSize: '0.72rem',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.boxShadow = focusRing;
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  {showCanvas ? 'Hide Wasm' : 'Show Wasm'}
                </button>
                <button
                  type="button"
                  onClick={onClear}
                  disabled={busy}
                  style={{
                    ...btnBase,
                    background: 'transparent',
                    border: `1px solid ${teal.border}`,
                    color: teal.muted,
                    borderRadius: 4,
                    padding: '0.2rem 0.5rem',
                    fontSize: '0.72rem',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    opacity: busy ? 0.5 : 1,
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.boxShadow = focusRing;
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            <div
              ref={transcriptRef}
              aria-live="polite"
              aria-relevant="additions"
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '0.85rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.65rem',
                WebkitOverflowScrolling: 'touch',
              }}
            >
              {isEmpty && (
                <div
                  style={{
                    margin: 'auto',
                    textAlign: 'center',
                    maxWidth: 340,
                    padding: '1.5rem 0.5rem',
                    color: teal.muted,
                  }}
                >
                  <div
                    style={{
                      fontSize: '1.05rem',
                      fontWeight: 600,
                      color: teal.text,
                      marginBottom: '0.4rem',
                    }}
                  >
                    Start a conversation
                  </div>
                  <p style={{ margin: 0, fontSize: '0.88rem', lineHeight: 1.5 }}>
                    Type a prompt below and press{' '}
                    <strong style={{ color: teal.accent }}>⌘/Ctrl+Enter</strong>, or try{' '}
                    <strong style={{ color: warm.accent }}>Smoke: PONG</strong>.
                  </p>
                </div>
              )}

              {turns.map((m) => {
                const c = bubbleColors(m.role);
                return (
                  <article
                    key={m.id}
                    style={{
                      border: `1px solid ${c.border}`,
                      background: c.bg,
                      borderRadius: 8,
                      padding: '0.65rem 0.8rem',
                      maxWidth: m.role === 'user' ? '92%' : '100%',
                      alignSelf: m.role === 'user' ? 'flex-end' : 'stretch',
                      boxSizing: 'border-box',
                    }}
                  >
                    <div
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 600,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                        color: c.label,
                        marginBottom: '0.3rem',
                      }}
                    >
                      {roleLabel(m.role)}
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        fontFamily:
                          m.role === 'assistant' || m.role === 'error'
                            ? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
                            : 'inherit',
                        fontSize: '0.9rem',
                        lineHeight: 1.55,
                        color: c.text,
                      }}
                    >
                      {m.text}
                    </pre>
                  </article>
                );
              })}

              {chatUi === 'busy' && (
                <div
                  role="status"
                  style={{
                    border: `1px solid ${warm.border}`,
                    background: warm.surface,
                    color: warm.accent,
                    borderRadius: 8,
                    padding: '0.55rem 0.8rem',
                    fontSize: '0.85rem',
                  }}
                >
                  Waiting for model…
                </div>
              )}
            </div>
          </section>

          {chatUi === 'fail' && statusLine && (
            <div
              role="alert"
              aria-live="assertive"
              style={{
                border: `1px solid ${ember.border}`,
                background: ember.surface,
                color: ember.text,
                borderRadius: 8,
                padding: '0.65rem 0.85rem',
                fontSize: '0.88rem',
                lineHeight: 1.4,
              }}
            >
              <strong style={{ color: ember.accent }}>Error · </strong>
              {statusLine}
            </div>
          )}

          <section
            aria-label="Composer"
            style={{
              border: `1px solid ${teal.border}`,
              background: teal.surface,
              borderRadius: 10,
              padding: '0.75rem 0.85rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.55rem',
              flexShrink: 0,
            }}
          >
            <textarea
              ref={textareaRef}
              value={domPrompt}
              onChange={(e) => setDomPrompt(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
              rows={3}
              placeholder="Message the model… (⌘/Ctrl + Enter to send)"
              aria-label="Prompt"
              aria-keyshortcuts="Control+Enter Meta+Enter"
              style={{
                width: '100%',
                resize: 'vertical',
                minHeight: 72,
                maxHeight: 180,
                boxSizing: 'border-box',
                border: `1px solid ${teal.border}`,
                borderRadius: 6,
                background: teal.bg,
                color: teal.text,
                padding: '0.65rem 0.75rem',
                fontSize: '0.95rem',
                lineHeight: 1.45,
                fontFamily: 'inherit',
                outline: 'none',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = teal.accent;
                e.currentTarget.style.boxShadow = focusRing;
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = teal.border;
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <button
                type="button"
                onClick={onDomSend}
                disabled={busy}
                style={{
                  ...btnBase,
                  border: 'none',
                  padding: '0.5rem 1rem',
                  fontSize: '0.9rem',
                  cursor: busy ? 'not-allowed' : 'pointer',
                  background: busy ? teal.border : teal.accent,
                  color: teal.bg,
                  opacity: busy ? 0.75 : 1,
                }}
                onFocus={(e) => {
                  e.currentTarget.style.boxShadow = focusRing;
                }}
                onBlur={(e) => {
                  e.currentTarget.style.boxShadow = 'none';
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
                  ...btnBase,
                  background: warm.surface,
                  color: warm.accent,
                  border: `1px solid ${warm.border}`,
                  padding: '0.5rem 0.75rem',
                  fontSize: '0.8rem',
                  cursor: busy ? 'not-allowed' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                }}
                onFocus={(e) => {
                  e.currentTarget.style.boxShadow = `0 0 0 2px ${teal.bg}, 0 0 0 4px ${warm.accent}`;
                }}
                onBlur={(e) => {
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                Smoke: PONG
              </button>
              <span style={{ fontSize: '0.75rem', color: teal.muted }}>⌘/Ctrl + Enter</span>
              {domPrompt.trim().length > 0 && (
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: '0.72rem',
                    color: teal.muted,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  }}
                >
                  {domPrompt.trim().length.toLocaleString()} chars
                </span>
              )}
            </div>
          </section>
        </div>
      )}

      {/* Stable canvas host — always mounted so Wasm is never rebound to a new node. */}
      <div
        style={
          canvasExpanded && phase !== 'loading'
            ? {
                position: 'fixed',
                left: '50%',
                bottom: 16,
                transform: 'translateX(-50%)',
                width: 'min(820px, calc(100% - 1.7rem))',
                height: phase === 'error' ? 220 : 200,
                borderRadius: 10,
                overflow: 'hidden',
                border: `1px solid ${teal.border}`,
                background: teal.clear,
                zIndex: 20,
                boxShadow: `0 8px 32px ${teal.bg}`,
              }
            : {
                position: 'fixed',
                width: 4,
                height: 4,
                left: 0,
                top: 0,
                overflow: 'hidden',
                opacity: 0.01,
                pointerEvents: 'none',
                zIndex: -1,
              }
        }
      >
        <canvas
          id="harness-canvas"
          ref={canvasRef}
          tabIndex={showCanvas ? 1 : -1}
          aria-label={showCanvas ? 'Wasm harness surface' : undefined}
          aria-hidden={!showCanvas}
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            outline: 'none',
            caretColor: 'transparent',
            touchAction: 'none',
          }}
        />
        {phase === 'error' && (
          <div
            role="alert"
            style={{
              position: 'absolute',
              inset: 8,
              border: `1px solid ${ember.border}`,
              background: ember.surface,
              color: ember.text,
              borderRadius: 8,
              padding: '0.85rem 1rem',
              overflow: 'auto',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.35rem', color: ember.accent }}>
              Could not start harness
            </div>
            <div style={{ fontSize: '0.88rem', lineHeight: 1.45 }}>{error}</div>
            <div
              style={{
                marginTop: '0.65rem',
                fontSize: '0.78rem',
                color: teal.muted,
                lineHeight: 1.4,
              }}
            >
              Rebuild on <code style={{ color: teal.accent }}>invincible-do-1</code> (
              <code style={{ color: teal.accent }}>build-harness</code>), redeploy Vercel. Bridge
              needs protocol v{HARNESS_PROTOCOL_VERSION}. See{' '}
              <code style={{ color: teal.accent }}>docs/harness-limits.md</code>.
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
