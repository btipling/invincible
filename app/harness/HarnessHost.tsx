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
  createHttpSessionRepository,
  type IdSessionRepository,
  type SessionSummary,
} from '../../lib/sessionRepository';
import { bootCloudSession, readUrlSessionId } from '../../lib/sessionBoot';
import {
  canLoadEarlier as sessionCanLoadEarlier,
  earlierRingStart,
  latestRingStart,
} from '../../lib/sessionWindow';
import AppNav from '../components/AppNav';
import SessionPicker from '../components/SessionPicker';
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
  /** Cloud multi-session repo (phase 3, #415); disabled on 401 / Redis-off. */
  const repoRef = useRef<IdSessionRepository | null>(null);
  const pollRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inflightRef = useRef(false);
  /** Server id to bind once the in-flight turn finishes (boot mint mid-turn), #430. */
  const pendingMintBindRef = useRef<string | null>(null);
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
  /** Cloud session summaries for the picker (no transcripts). */
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** Canonical active session id (= `SessionSnapshot.id`, server-minted when cloud). */
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  /** False once the cloud repo reports disabled (401 / Redis-off) → picker hides. */
  const [cloudEnabled, setCloudEnabled] = useState(true);

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

  const writeLocalSession = useCallback((next: SessionSnapshot) => {
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

  /** Apply server snapshot to local store + latest Wasm ring window. */
  const adoptCloudSession = useCallback(
    (next: SessionSnapshot) => {
      writeLocalSession(next);
      const bridge = bridgeRef.current;
      if (bridge) {
        hydrateRingWindow(bridge, next, latestRingStart(next.messages.length));
      }
    },
    [writeLocalSession, hydrateRingWindow],
  );

  /** Persist the active session id into the URL `?s=` (no new history entry). */
  const setUrlSessionId = useCallback((id: string | null) => {
    try {
      const url = new URL(window.location.href);
      if (id && id.length > 0) url.searchParams.set('s', id);
      else url.searchParams.delete('s');
      window.history.replaceState(null, '', url.toString());
    } catch {
      /* SSR/tests may lack full URL support — ignore */
    }
  }, []);

  /** Refresh the picker's session summary list from the cloud repo. */
  const refreshSessions = useCallback(async () => {
    const repo = repoRef.current;
    if (!repo) return;
    const res = await repo.list();
    if (res.action === 'ok') setSessions(res.sessions);
    else if (res.action === 'disabled') setCloudEnabled(false);
  }, []);

  /** Activate a session (canonical id) on local state + Wasm ring + URL + picker. */
  const activateSession = useCallback(
    (next: SessionSnapshot) => {
      adoptCloudSession(next);
      setActiveSessionId(next.id);
      void refreshSessions();
    },
    [adoptCloudSession, refreshSessions],
  );

  const persist = useCallback(
    (next: SessionSnapshot) => {
      writeLocalSession(next);
      // Hybrid cloud push — never blocks the turn; coalesced per session in repo.
      repoRef.current?.put(next.id, next);
    },
    [writeLocalSession],
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
        // Boot mint landed mid-turn (#430): the bridge was streaming so we did NOT
        // re-hydrate the ring. Restore the transcript the turn just persisted, rebind
        // the server UUID and URL/active id only now that the turn is done, then push
        // the carried-over history to the real resource.
        const pendingId = pendingMintBindRef.current;
        if (pendingId) {
          pendingMintBindRef.current = null;
          const bound = { ...sessionRef.current, id: pendingId };
          sessionRef.current = bound;
          setActiveSessionId(pendingId);
          setUrlSessionId(pendingId);
          repoRef.current?.put(pendingId, bound);
        }
      }
    },
    [persist, setUrlSessionId],
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
        // Cloud repo for multi-device sync — pull is async after first paint path.
        const repo = createHttpSessionRepository({
          getLocal: () => sessionRef.current,
          onAdopt: (snap) => {
            if (cancelled) return;
            // Never clobber an in-flight turn's session/ring mid-stream.
            if (inflightRef.current) return;
            // Identity guard (#430): a put-409 body is the server snapshot of the session
            // that PUT targeted; if the user switched to a different active session while
            // the network round-trip was in flight, do NOT adopt it into the UI. The repo
            // re-checks getLocal, but this host guard is authoritative for the active id.
            if (snap.id !== sessionRef.current.id) return;
            adoptCloudSession(snap);
          },
        });
        repoRef.current = repo;

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

        // Cloud multi-session boot (phase 3, #415): mint the first session / pin
        // `?s=` / adopt a bound local id — async AFTER local first paint so nothing
        // blocks. A gone `?s=` falls back to local/empty first paint, never blank.
        // Repo disabled (401 / Redis-off / tenancy-off) → local-only.
        void (async () => {
          const r = repoRef.current;
          if (!r) return;
          const result = await bootCloudSession({
            repo: r,
            urlId: readUrlSessionId(window.location.href),
            localId: sessionRef.current.id,
            onAdopt: (serverSnap, id) => {
              if (cancelled) return;
              if (inflightRef.current) return;
              activateSession({ ...serverSnap, id });
            },
            onMint: (createdSnap, id) => {
              if (cancelled) return;
              const existing = sessionRef.current;
              const hasDialogue = existing.messages.some(
                (m) => m.role === 'user' || m.role === 'assistant',
              );
              // First paint won: preserve any local transcript on this initial bind;
              // otherwise the empty minted session. Always bind the server UUID.
              const merged = hasDialogue ? { ...existing, id } : { ...createdSnap, id };
              if (inflightRef.current) {
                // Mid-turn (#430): do NOT hydrate the Wasm ring now — that would wipe
                // partial assistant/thinking that only lives on the bridge. Defer the id
                // bind until the turn finishes; runPrompt applies it in finally.
                pendingMintBindRef.current = id;
                return;
              }
              activateSession(merged);
              r.put(id, merged); // persist any carried-over local history
            },
            onUrlUpdate: (id) => setUrlSessionId(id),
          });
          // Only hide the picker when the repo is actually disabled (401 / Redis-off);
          // a transient 5xx/network error during boot keeps the cloud UI live so a reload
          // or refresh can recover — don't permanently strand local-only this page load.
          if (result.kind === 'local') setCloudEnabled(r.enabled);
          void refreshSessions();
        })();

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
      repoRef.current = null;
    };
  }, [
    runPrompt,
    hydrateRingWindow,
    adoptCloudSession,
    activateSession,
    refreshSessions,
    setUrlSessionId,
  ]);

  const onClear = useCallback(() => {
    if (inflightRef.current) return;
    abortRef.current?.abort();
    const repo = repoRef.current;
    const bridge = bridgeRef.current;
    const clearedId = sessionRef.current.id;

    const resetBridge = (id: string) => {
      // Local only — never PUT empty. Cloud clear = DELETE this session + mint new.
      const empty = createEmptySession(id);
      writeLocalSession(empty);
      setActiveSessionId(id);
      storeRef.current?.clear();
      storeRef.current?.save(empty);
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
    };

    if (!repo || !repo.enabled) {
      // Disable-safe: plain local Clear (today's behavior), no cloud DELETE.
      resetBridge(createEmptySession().id);
      setUrlSessionId(null);
      return;
    }

    void (async () => {
      // Clear = clear THIS session only (DELETE one); other sessions survive.
      await repo.remove(clearedId);
      // Post-Clear active session is server-minted (parent #415 lock): the next
      // turn PUTs against a real resource, never a throwaway local sess_ id.
      const created = await repo.create();
      if (created.action === 'ok') {
        resetBridge(created.snapshot.id);
        setUrlSessionId(created.snapshot.id);
      } else {
        resetBridge(createEmptySession().id);
        setUrlSessionId(null);
      }
      void refreshSessions();
    })();
  }, [writeLocalSession, refreshSessions, setUrlSessionId]);

  const onNewSession = useCallback(() => {
    const repo = repoRef.current;
    if (!repo || !repo.enabled || inflightRef.current) return;
    abortRef.current?.abort();
    void (async () => {
      const created = await repo.create();
      if (created.action !== 'ok') return; // stay on the current session
      const empty = createEmptySession(created.snapshot.id);
      activateSession(empty);
      setUrlSessionId(created.snapshot.id);
      repo.put(created.snapshot.id, empty);
    })();
  }, [activateSession, setUrlSessionId]);

  const onSwitchSession = useCallback(
    (id: string) => {
      const repo = repoRef.current;
      const bridge = bridgeRef.current;
      if (!repo || !repo.enabled || !bridge || inflightRef.current) return;
      if (id === sessionRef.current.id) return;
      abortRef.current?.abort();
      void (async () => {
        const got = await repo.get(id);
        if (got.action !== 'ok') return; // 404/gone stays on current local session (never blank)
        // Adopt the server transcript; canonical id = fetched id.
        activateSession(got.snapshot);
        setUrlSessionId(id);
      })();
    },
    [activateSession, setUrlSessionId],
  );

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
                <SessionPicker
                  sessions={sessions}
                  currentId={activeSessionId}
                  hidden={!cloudEnabled}
                  disabled={busy}
                  onNew={onNewSession}
                  onSwitch={onSwitchSession}
                />
              )}
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
