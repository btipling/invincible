'use client';

/**
 * Phase 4 host shell — DOM loads Wasm, owns network/session, does NOT host chat UI.
 * Product transcript + composer live in Zig/dvui (see docs/feature-divide.md).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { runHarnessTurn, pushSessionToBridge } from '../../lib/harnessChat';
import { resetHarnessImageSession } from '../../lib/harnessImages';
import { resetHarnessMathSession } from '../../lib/harnessMath';
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
import {
  canLoadEarlier as sessionCanLoadEarlier,
  earlierRingStart,
  latestRingStart,
} from '../../lib/sessionWindow';
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

async function loadDvuiGlue(cacheBust: string): Promise<DvuiModule> {
  const q = cacheBust ? `?v=${encodeURIComponent(cacheBust)}` : '';
  const href = `/harness/web.js${q}`;
  return import(/* webpackIgnore: true */ /* @vite-ignore */ href) as Promise<DvuiModule>;
}

/** Read baked build id written by native/harness/build.sh into the artifact. */
async function fetchHarnessBuildId(): Promise<string> {
  try {
    const res = await fetch(`/harness/build-id.txt?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return '';
    return (await res.text()).trim().split(/\s+/)[0] || '';
  } catch {
    return '';
  }
}

function shortModelChip(id: string | null, max = 28): string {
  if (!id) return 'no model';
  return id.length <= max ? id : `${id.slice(0, max - 1)}…`;
}

type ModelCatalogResult =
  | { ok: true; models: string[] }
  | { ok: false; status: number; message: string };

async function fetchModelCatalogOnce(): Promise<ModelCatalogResult> {
  try {
    const res = await fetch('/api/models', { credentials: 'same-origin' });
    if (!res.ok) {
      if (res.status === 401) {
        return {
          ok: false,
          status: 401,
          message: 'Session expired — sign in again to load models.',
        };
      }
      if (res.status === 503) {
        return {
          ok: false,
          status: 503,
          message: 'Model catalog temporarily unavailable.',
        };
      }
      return {
        ok: false,
        status: res.status,
        message: `Model catalog unavailable (${res.status}).`,
      };
    }
    const data = (await res.json()) as { models?: { id?: string }[] };
    if (!Array.isArray(data.models)) {
      return {
        ok: false,
        status: res.status,
        message: 'Model catalog response invalid.',
      };
    }
    const models = data.models
      .map((m) => (typeof m?.id === 'string' ? m.id.trim() : ''))
      .filter(Boolean);
    return { ok: true, models };
  } catch {
    return {
      ok: false,
      status: 0,
      message: 'Network error loading model catalog.',
    };
  }
}

/** Retry transport failures; do not retry 401 (session is gone). */
async function fetchModelCatalog(
  attempts = 3,
  baseDelayMs = 400,
): Promise<ModelCatalogResult> {
  let last: ModelCatalogResult = {
    ok: false,
    status: 0,
    message: 'Model catalog unavailable.',
  };
  for (let i = 0; i < attempts; i++) {
    last = await fetchModelCatalogOnce();
    if (last.ok) return last;
    if (last.status === 401) return last;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  return last;
}

export default function HarnessHost({ authNav }: { authNav?: ReactNode } = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bridgeRef = useRef<HarnessBridge | null>(null);
  const storeRef = useRef<SessionStore | null>(null);
  const pollRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef(false);
  const sessionRef = useRef<SessionSnapshot>(createEmptySession());
  /** Oldest session.messages index currently hydrated into the Wasm ring. */
  const ringWindowStartRef = useRef(0);
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
  const [modelChip, setModelChip] = useState<string>('…');
  /** Wasm build id from public/harness/build-id.txt — stale-cache detector. */
  const [harnessBuildId, setHarnessBuildId] = useState<string>('');

  const persist = useCallback((next: SessionSnapshot) => {
    sessionRef.current = next;
    storeRef.current?.save(next);
    // Incremental pushMessage turns keep the ring on the latest window.
    const latest = latestRingStart(next.messages.length);
    ringWindowStartRef.current = latest;
    try {
      bridgeRef.current?.setCanLoadEarlier(sessionCanLoadEarlier(latest));
    } catch {
      /* ignore */
    }
  }, []);

  const hydrateRingWindow = useCallback(
    (bridge: HarnessBridge, session: SessionSnapshot, windowStart: number) => {
      const start = pushSessionToBridge(bridge, session, {
        clear: true,
        windowStart,
      });
      ringWindowStartRef.current = start;
      return start;
    },
    [],
  );

  const runPrompt = useCallback(
    async (prompt: string, opts?: { pushUser?: boolean }) => {
      const bridge = bridgeRef.current;
      if (!bridge || inflightRef.current) return;

      const modelId = bridge.getSelectedModel();
      if (!modelId) {
        setHostNote('No model selected — catalog empty, failed to load, or not granted.');
        try {
          bridge.pushMessage(
            MessageKind.Error,
            'No model available. Reload if the catalog failed to load; otherwise ask an admin for an inference grant.',
          );
          bridge.setLifecycle(Lifecycle.Ready);
        } catch {
          /* ignore */
        }
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      inflightRef.current = true;
      setBusy(true);
      setHostNote(null);
      setLifecycle(lifecycleName(Lifecycle.Busy));
      setModelChip(shortModelChip(modelId));

      try {
        const { result, session: next } = await runHarnessTurn(
          bridge,
          sessionRef.current,
          prompt,
          {
            signal: controller.signal,
            // Default false: Wasm already painted the user line in queueSubmitFromUi.
            // true when host snapped from a historical ring window before the turn.
            pushUser: opts?.pushUser ?? false,
            modelId,
          },
        );
        // Always persist — including user Stop/cancel (and late abort after a finished
        // stream). Dropping session on signal.aborted left SessionStore behind Wasm:
        // Load earlier / refresh could wipe the cancelled turn from the ring.
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

        const buildId = await fetchHarnessBuildId();
        if (cancelled) return;
        if (buildId) setHarnessBuildId(buildId);
        const bust = buildId || String(Date.now());
        const wasmUrl = `/harness/harness.wasm?v=${encodeURIComponent(bust)}`;

        const head = await fetch(wasmUrl, { method: 'HEAD', cache: 'no-store' });
        if (!head.ok) {
          throw new Error(
            `harness.wasm missing (${head.status}). Ensure build-harness CI produced harness-wasm and Vercel has HARNESS_ARTIFACT_TOKEN.`,
          );
        }

        const mod = await loadDvuiGlue(bust);
        if (cancelled) return;

        const host = await Promise.resolve(mod.dvui(canvas, wasmUrl));
        if (cancelled) return;

        const created = HarnessBridge.fromInstance(host.instance);
        if (!created.ok) {
          throw new Error(created.error);
        }
        const bridge = created.bridge;
        bridgeRef.current = bridge;

        bridge.assertRoundTrip('hello-bridge');

        // Catalog before Ready so first paint has models (protocol v3).
        // Distinguish transport/auth failure from an empty grant list.
        const catalog = await fetchModelCatalog();
        if (cancelled) return;
        if (catalog.ok) {
          bridge.setModelCatalog(catalog.models);
          setModelChip(shortModelChip(bridge.getSelectedModel()));
          if (catalog.models.length === 0) {
            setHostNote('No models granted — ask a tenant admin for inference access.');
          }
        } else {
          bridge.setModelCatalog([]);
          setModelChip('no model');
          setHostNote(catalog.message);
        }

        bridge.setLifecycle(Lifecycle.Ready);

        const restored = store.load();
        if (restored && restored.messages.some((m) => m.role === 'user' || m.role === 'assistant')) {
          sessionRef.current = restored;
          hydrateRingWindow(bridge, restored, latestRingStart(restored.messages.length));
        } else {
          const empty = createEmptySession();
          sessionRef.current = empty;
          ringWindowStartRef.current = 0;
          bridge.setCanLoadEarlier(false);
          bridge.clearMessages();
          const sel = bridge.getSelectedModel();
          let systemLine: string;
          if (!catalog.ok) {
            systemLine = `Invincible harness · ${catalog.message} Reload the page to retry.`;
          } else if (sel) {
            systemLine = `Invincible harness · ${sel} · type below, Enter to send · use Next in the canvas header to cycle`;
          } else {
            systemLine =
              'Invincible harness · no models granted — ask a tenant admin for inference access';
          }
          bridge.pushMessage(MessageKind.System, systemLine);
        }

        setLoadMs(Math.round(performance.now() - loadStarted.current));
        setLifecycle(lifecycleName(Lifecycle.Ready));

        const poll = () => {
          if (cancelled) return;
          const b = bridgeRef.current;
          if (b) {
            // Reflect Wasm lifecycle + selected model on host chips.
            try {
              setLifecycle(lifecycleName(b.getLifecycle()));
              setModelChip(shortModelChip(b.getSelectedModel()));
            } catch {
              /* ignore */
            }
            // Protocol v9: Stop first — abort inflight and skip starting a turn this tick.
            if (b.takePendingCancel()) {
              abortRef.current?.abort();
            } else if (!inflightRef.current) {
              if (b.takePendingLoadEarlier()) {
                const session = sessionRef.current;
                const nextStart = earlierRingStart(ringWindowStartRef.current);
                hydrateRingWindow(b, session, nextStart);
              } else {
                const pending = b.takePendingSubmit();
                if (pending != null && pending.length > 0) {
                  const latest = latestRingStart(sessionRef.current.messages.length);
                  const needSnap = ringWindowStartRef.current !== latest;
                  if (needSnap) {
                    hydrateRingWindow(b, sessionRef.current, latest);
                    void runPrompt(pending, { pushUser: true });
                  } else {
                    void runPrompt(pending);
                  }
                }
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
  }, [runPrompt, hydrateRingWindow]);

  const onClear = useCallback(() => {
    if (inflightRef.current) return;
    abortRef.current?.abort();
    const empty = createEmptySession();
    persist(empty);
    storeRef.current?.clear();
    storeRef.current?.save(empty);
    const bridge = bridgeRef.current;
    if (bridge) {
      resetHarnessImageSession();
      resetHarnessMathSession();
      ringWindowStartRef.current = 0;
      bridge.setCanLoadEarlier(false);
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
                  maxWidth: 160,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title="Selected model (change in canvas header)"
              >
                {modelChip}
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
                title={`Harness Wasm build id (native/harness). Mismatch with canvas h:… means stale wasm cache.`}
              >
                h:{harnessBuildId || '…'}
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
            Rebuild harness Wasm (build-harness), redeploy Vercel. Protocol v
            {HARNESS_PROTOCOL_VERSION}. See docs/feature-divide.md · docs/runner.md.
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
