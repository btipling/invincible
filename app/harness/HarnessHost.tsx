'use client';

/**
 * Phase 4 host shell — DOM loads Wasm, owns network/session, does NOT host chat UI.
 * Product transcript + composer live in Zig/dvui (see docs/feature-divide.md).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  runHarnessTurn,
  pushSessionToBridge,
  refreshGitStatusSlot,
} from '../../lib/harnessChat';
import { resetHarnessImageSession } from '../../lib/harnessImages';
import { resetHarnessMathSession } from '../../lib/harnessMath';
import {
  HarnessBridge,
  HARNESS_PROTOCOL_VERSION,
  Lifecycle,
  MessageKind,
} from '../../lib/harnessBridge';
import { ember, teal } from '../../lib/palette';
import {
  createDefaultSessionStore,
  createEmptySession,
  type SessionSnapshot,
  type SessionStore,
} from '../../lib/sessionStore';
import {
  createHttpSessionRepository,
  mergeAdoptedUsage,
  type IdSessionRepository,
  type SessionSummary,
} from '../../lib/sessionRepository';
import {
  bootCloudSession,
  readUrlSessionId,
  shouldAdoptBootServer,
} from '../../lib/sessionBoot';
import {
  canLoadEarlier as sessionCanLoadEarlier,
  earlierRingStart,
  latestRingStart,
} from '../../lib/sessionWindow';
import {
  applySessionModel as applySessionModelFn,
  foldPendingModelChange as foldPendingModelChangeFn,
  flushPendingThenRestore,
  discardPendingModelChange,
} from '../../lib/harnessHostModelPersist';
import {
  buildSessionCatalogEntries,
  foldPendingSessionSwitch,
  foldSessionListResult,
} from '../../lib/sessionSummaryLabel';
import AppNav from '../components/AppNav';
import SessionPicker from '../components/SessionPicker';
import PersonaPicker from '../components/PersonaPicker';
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

/**
 * Busy spinner pulse cadence (plan #574, `HARNESS_BUSY_TICK_HZ`). NEW cap —
 * 10 Hz while Busy, 0 otherwise. The host wall-clock tick advances the 8-cell
 * 2×4 WARM clockwise pulse one cell per tick (~0.8 s cycle) and re-uses the
 * v14 whole-turn clock feed (`setTurnElapsed`) every 10th tick (~1 Hz). 10 Hz ≪
 * the dvui 60 fps frame ceiling and turns are transient — see docs/harness-limits.md.
 */
const HARNESS_BUSY_TICK_HZ = 10 as const;

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

/**
 * Phase 3 (#488): resolve the user's default persona id (summary list carries
 * `isDefault`) for binding at New session when no persona was explicitly chosen
 * in the picker. Fail-open — returns undefined when unauthenticated /
 * unavailable / no default, so New still works (None). Body never reaches the
 * client; only the summary + id.
 */
async function fetchDefaultPersonaId(): Promise<string | undefined> {
  try {
    const res = await fetch('/api/personas', { credentials: 'same-origin' });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      personas?: Array<{ id?: unknown; isDefault?: unknown }>;
    };
    if (!Array.isArray(data.personas)) return undefined;
    const def = data.personas.find((p) => p.isDefault === true);
    return typeof def?.id === 'string' && def.id ? def.id : undefined;
  } catch {
    return undefined;
  }
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
  /** True while an async switch (repo.get → activateSession) is in flight; New/Clear/poll ack-and-drop while set. */
  const switchInFlightRef = useRef(false);
  const onSwitchSessionRef = useRef<(id: string) => void>(() => {});
  /** Server id to bind once the in-flight turn finishes (boot mint mid-turn), #430. */
  const pendingMintBindRef = useRef<string | null>(null);
  const sessionRef = useRef<SessionSnapshot>(createEmptySession());
  /** Oldest session.messages index currently hydrated into the Wasm ring. */
  const ringWindowStartRef = useRef(0);

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hostNote, setHostNote] = useState<string | null>(null);
  /** Cloud session summaries for the picker (no transcripts). */
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  /** Canonical active session id (= `SessionSnapshot.id`, server-minted when cloud). */
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  /** False once the cloud repo reports disabled (401 / Redis-off) → picker hides. */
  const [cloudEnabled, setCloudEnabled] = useState(true);
  /**
   * Phase 3 (#488): persona to bind at New session.
   *   - `undefined` → not yet chosen → bind the default persona (or None).
   *   - `string`   → explicitly chosen persona id (selected in PersonaPicker).
   *   - `null`     → explicitly chosen **None** (no persona even if a default exists).
   */
  const [personaPick, setPersonaPick] = useState<string | null | undefined>(undefined);

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

  /**
   * Meta-only persist seam (Plan #616, PR #618 re-run 6 Minor L1). A model-pick
   * fold on the 150 ms poll updates `sessionRef` + local save (the fold also
   * PUTs the cloud row) but must NOT move `ringWindowStartRef` or touch
   * `setCanLoadEarlier`. `writeLocalSession` snaps the pointer to latest, which
   * would clear a live Load-earlier window in the host while the Wasm ring still
   * shows the earlier page — the next send's `needSnap` then says already-latest
   * and paints the turn onto the stale window. A pick is not a transcript change.
   */
  const writeLocalSessionMeta = useCallback((next: SessionSnapshot) => {
    sessionRef.current = next;
    storeRef.current?.save(next);
  }, []);

  /**
   * Plan #616 (source #610) — delegate to the extracted pure function in
   * lib/harnessHostModelPersist.ts so the logic is unit-testable without
   * rendering React.
   */
  const applySessionModel = useCallback((snap: SessionSnapshot) => {
    const b = bridgeRef.current;
    if (!b) return;
    applySessionModelFn(snap, b, sessionRef, writeLocalSession, repoRef.current);
  }, [writeLocalSession]);

  /** Apply server snapshot to local store + latest Wasm ring window. */
  const adoptCloudSession = useCallback(
    (next: SessionSnapshot) => {
      // Merge usage: same-id adopt keeps local's honest last-completed value
      // when the server snapshot has none (plan #626 test 5).
      const merged = mergeAdoptedUsage(next, sessionRef.current);
      const b = bridgeRef.current;
      if (b) {
        // Flush a pending menu/Next pick onto the CURRENT session before
        // replacing it (PR #618 re-run 5 Minor L1). Restore-by-id never acks.
        flushPendingThenRestore(
          merged,
          b,
          sessionRef,
          writeLocalSession,
          repoRef.current,
          inflightRef.current,
        );
      } else {
        writeLocalSession(merged);
      }
      const bridge = bridgeRef.current;
      if (bridge) {
        hydrateRingWindow(bridge, merged, latestRingStart(merged.messages.length));
      }
    },
    [writeLocalSession, hydrateRingWindow],
  );

  /**
   * Plan #616 (source #610) — delegate to the extracted pure function in
   * lib/harnessHostModelPersist.ts so the logic is unit-testable without
   * rendering React.
   */
  const foldPendingModelChange = useCallback(() => {
    const b = bridgeRef.current;
    if (!b) return;
    foldPendingModelChangeFn(b, sessionRef, writeLocalSessionMeta, repoRef.current, inflightRef.current);
  }, [writeLocalSessionMeta]);

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
    setSessions((prev) => {
      const next = foldSessionListResult(prev, res);
      if (next.cloudEnabled === false) setCloudEnabled(false);
      return next.sessions;
    });
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
            // Phase 2 (#627 / #625): persist every mid-turn session patch
            // (cwd change, sandbox switch) via the same persist callback the
            // turn-end path uses — local write + coalesced cloud PUT.
            onSessionPatch: persist,
          },
        );
        // Plan #616 (source #610): fold the LIVE selection into the snapshot before
        // persisting — a Next-cycle-then-immediate-send right before a poll tick must
        // still persist (row 12: submit still reads the live `getSelectedModel()`; this
        // just carries that same truth forward into the snapshot).
        const liveId = bridge.getSelectedModel();
        const folded: SessionSnapshot = liveId
          ? { ...next, selectedModel: liveId }
          : next;
        // Always persist — including user Stop/cancel (and late abort after a finished
        // stream). Dropping session on signal.aborted left SessionStore behind Wasm:
        // Load earlier / refresh could wipe the cancelled turn from the ring.
        persist(folded);
        if (!result.ok) {
          setHostNote(result.error);
        }
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
          // Persist the transcript under the real server-minted id NOW — not only as a
          // fire-and-forget PUT. A reload here must restore under the id the URL advertises
          // (#430 re-review): otherwise localStorage would still say sess_X while `?s=` says
          // the fresh uuid, and boot's get(uuid) (the empty minted row) would adopt/wipe the
          // first-turn dialogue instead of keeping it.
          writeLocalSession(bound);
          setActiveSessionId(pendingId);
          setUrlSessionId(pendingId);
          repoRef.current?.put(pendingId, bound);
        }
      }
    },
    [persist, setUrlSessionId, writeLocalSession],
  );

  useEffect(() => {
    let cancelled = false;
    /** Phase 2 (#540): git status-slot cadence timer; armed once boot binds the bridge. */
    let gitTimer: number | undefined;
    const canvas = canvasRef.current;
    if (!canvas) return;

    (async () => {
      try {
        const store = createDefaultSessionStore();
        storeRef.current = store;
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
          if (catalog.models.length === 0) {
            setHostNote('No models granted — ask a tenant admin for inference access.');
          }
        } else {
          bridge.setModelCatalog([]);
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
            systemLine = `Invincible harness · ${sel} · type below, Enter to send`;
          } else {
            systemLine =
              'Invincible harness · no models granted — ask a tenant admin for inference access';
          }
          bridge.pushMessage(MessageKind.System, systemLine);
        }

        // Plan #616 (source #610): restore the stored selected model by id AFTER the
        // catalog push + local/empty session establish — a stored id that matches the
        // catalog selects it; null/absent resets to the default. (A revoke/catalog
        // change lands on the default first granted, never a ghost index.)
        applySessionModel(sessionRef.current);

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
              // Flush a pending pick onto local before LWW so a menu click
              // during boot is in `local.updatedAt` / `selectedModel` (PR #618
              // re-run 5 Minor L1). activateSession flushes again (no-op).
              const bootBridge = bridgeRef.current;
              if (bootBridge) {
                // Meta-only persist — never disturbs the ring window (PR #618
                // re-run 6 Minor L1). The subsequent activateSession/adopt
                // rehydrates to latest anyway.
                foldPendingModelChangeFn(
                  bootBridge,
                  sessionRef,
                  writeLocalSessionMeta,
                  repoRef.current,
                  inflightRef.current,
                );
              }
              // LWW guard for the boot-pin path (re-review #430 pass 3): the server row
              // can be the EMPTY mint (`updatedAt: 0`) while local holds dialogue under
              // the SAME id that a still-in-flight put() hasn't flushed yet. If the server
              // doesn't win LWW, keep the local transcript (it's already in the ring) and
              // push it to the cloud so a reload stops re-serving the empty mint over it.
              // bootCloudSession pins ?s=id either way.
              const local = sessionRef.current;
              if (!shouldAdoptBootServer(local, serverSnap)) {
                setActiveSessionId(id);
                repoRef.current?.put(id, local);
                return;
              }
              activateSession(mergeAdoptedUsage({ ...serverSnap, id }, local));
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
                // bind until the turn finishes; runPrompt applies it in finally. Return
                // 'deferred' so bootCloudSession skips the `?s=` pin too: never advertise
                // the empty minted row as canonical before it's actually bound.
                pendingMintBindRef.current = id;
                return 'deferred';
              }
              activateSession(merged);
              r.put(id, merged); // persist any carried-over local history
              return 'bound';
            },
            onUrlUpdate: (id) => setUrlSessionId(id),
          });
          // Only hide the picker when the repo is actually disabled (401 / Redis-off);
          // a transient 5xx/network error during boot keeps the cloud UI live so a reload
          // or refresh can recover — don't permanently strand local-only this page load.
          if (result.kind === 'local') setCloudEnabled(r.enabled);
          void refreshSessions();
        })();

        const poll = () => {
          if (cancelled) return;
          const b = bridgeRef.current;
          if (b) {
            // Protocol v9: Stop first — abort inflight and skip starting a turn this tick.
            if (b.takePendingCancel()) {
              abortRef.current?.abort();
            } else if (inflightRef.current || switchInFlightRef.current) {
              foldPendingSessionSwitch(true, () => b.takePendingSessionSwitch(), () => {});
            } else {
              // Plan #616 (source #610): fold a user Next cycle into the session
              // snapshot + persist + ack before any other pending event this tick.
              foldPendingModelChange();
              const switched = foldPendingSessionSwitch(
                false,
                () => b.takePendingSessionSwitch(),
                (id) => onSwitchSessionRef.current(id),
                () => {
                  // Adversarial #642: leftover Send must not run on the destination.
                  b.takePendingSubmit();
                  b.setLifecycle(Lifecycle.Ready);
                },
              );
              if (switched !== 'switched' && b.takePendingLoadEarlier()) {
                const session = sessionRef.current;
                const nextStart = earlierRingStart(ringWindowStartRef.current);
                hydrateRingWindow(b, session, nextStart);
              } else if (switched !== 'switched') {
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

          // Phase 2 (#538/#540): arm the git status-slot cadence ONLY once the
          // bridge + session exist (they were set earlier this boot effect). Read
          // the refs live each tick (never capture a stale bridge/session), skip
          // mid-turn, and fire once immediately so the first git paint isn't
          // delayed a full interval. The host cadence is the PRIMARY throttle
          // (the server rate cap is only a per-instance backstop), so keep the
          // interval well above STATUS_PROBE_MIN_INTERVAL_MS. Fail-soft lives
          // inside refreshGitStatusSlot (any error keeps the last value and
          // never blanks a sibling or blocks a turn).
          const tick = () => {
            if (cancelled || inflightRef.current) return; // never fire mid-turn
            const b = bridgeRef.current;
            const s = sessionRef.current;
            if (!b || !s) return;
            void refreshGitStatusSlot(b, s);
          };
          tick(); // immediate first paint, not a 10 s-stale header
          gitTimer = window.setInterval(tick, 10_000);
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
      if (gitTimer != null) {
        clearInterval(gitTimer);
        gitTimer = undefined;
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
    applySessionModel,
    foldPendingModelChange,
  ]);

  /**
   * Whole-turn Busy clock + spinner pulse (#347 / plan #457, protocol v14 / plan
   * #567; plan #574): while Busy, tick a host wall-clock timer at
   * `HARNESS_BUSY_TICK_HZ` (10 Hz). Clock is client wall time from turn start
   * (NOT provider `usage`); since the DOM top-bar chip was removed (plan #567)
   * the host never renders anything — it is a pure feeder with NO React state.
   * Each 10 Hz tick advances the Wasm 2×4 spinner phase via `setBusyTick(tick)`;
   * every 10th tick it also pushes the elapsed seconds via `setTurnElapsed(sec)`
   * (the ~1 Hz `mm:ss` clock) to the Wasm busy row. Intentionally no `useState`
   * here — a state round-trip per second would re-render the whole host
   * (pickers, authNav, canvas parent) just to feed values no JSX reads
   * (adversarial review #568 L5). Idle/Stop/error clears both to 0.
   *
   * Reduced motion (plan #574 Major fix): the host still runs the interval, but
   * SKIPS the per-tick spinner push (`setBusyTick`) so the grid stays static at
   * phase 0 while the FULL-TURN `mm:ss` clock (`setTurnElapsed`) keeps ticking
   * — reduced motion disables only the pulse travel, never the clock (the v14
   * regression plan-review caught). `prefers-reduced-motion` is read fresh at
   * each busy start, so an OS-level toggle applies on the next turn.
   */
  useEffect(() => {
    if (!busy) {
      bridgeRef.current?.setBusyTick(0);
      bridgeRef.current?.setTurnElapsed(0);
      return;
    }
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now();
    bridgeRef.current?.setBusyTick(0);
    bridgeRef.current?.setTurnElapsed(0);
    let tick = 0;
    const id = window.setInterval(() => {
      tick += 1;
      // Batch scalar pushes so the Wasm refreshes once per tick even when both
      // setBusyTick and setTurnElapsed fire on the same 10th-tick interval
      // (adversarial review #576 L5 — each export calls refresh() independently
      // in bridge.zig; beginBatch/endBatch coalesce them into a single frame).
      bridgeRef.current?.beginBatch();
      if (!reduceMotion) {
        bridgeRef.current?.setBusyTick(tick);
      }
      if (tick % HARNESS_BUSY_TICK_HZ === 0) {
        const sec = Math.max(0, Math.floor((performance.now() - start) / 1000));
        bridgeRef.current?.setTurnElapsed(sec);
      }
      bridgeRef.current?.endBatch();
    }, Math.round(1000 / HARNESS_BUSY_TICK_HZ));
    return () => {
      window.clearInterval(id);
      bridgeRef.current?.setBusyTick(0);
      bridgeRef.current?.setTurnElapsed(0);
    };
  }, [busy]);

  /**
   * Phase 3 (#488): persona to bind at New session, honoring the picker.
   *   - explicit string → that chosen persona
   *   - explicit null   → None (no bind even if a default exists)
   *   - unset (undefined) → the user's default persona, or None when none.
   */
  const resolveNewPersona = useCallback(async (): Promise<string | undefined> => {
    if (personaPick !== undefined) return personaPick ?? undefined;
    return fetchDefaultPersonaId();
  }, [personaPick]);

  const onClear = useCallback(() => {
    if (inflightRef.current || switchInFlightRef.current) return;
    abortRef.current?.abort();
    const repo = repoRef.current;
    const bridge = bridgeRef.current;
    const clearedId = sessionRef.current.id;
    // INTENTIONAL ack-only (not flushPendingThenRestore). Clear deletes this
    // row. Fold-after-remove resurrects via a new-epoch PUT; fold-before-remove
    // is a wasted PUT then DELETE. New/switch flush; Clear acks. See
    // discardPendingModelChange.
    // Adversarial #642: ack any stale session-switch pending synchronously at
    // click (navigation discard, mirror discardPendingModelChange). The catalog
    // rewrite (useEffect → setSessionCatalog) no longer replays it.
    if (bridge) {
      discardPendingModelChange(bridge);
      bridge.takePendingSessionSwitch();
    }

    const resetBridge = (id: string, personaId?: string) => {
      // Local only — never PUT empty. Cloud clear = DELETE this session + mint new.
      const base = createEmptySession(id);
      // Phase 3 (#488): New/Clear binds a persona (default from GET /api/personas,
      // else None). The fresh empty session resets cwd + activeSandboxId already
      // (createEmptySession carries neither) and now carries the bound personaId.
      const empty = personaId ? { ...base, personaId } : base;
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
        // Protocol v13 (plan #538/#541): a fresh New session has no sandbox/cwd
        // bind yet — clear the status-slot pack so no stale slots linger.
        bridge.clearStatusSlots();
        // Plan #616 (source #610): New/Clear starts on the default model (index 0);
        // the fresh empty snapshot already omits `selectedModel`.
        bridge.setSelectedModel(null);
        bridge.pushMessage(MessageKind.System, 'New session started.');
        bridge.setLifecycle(Lifecycle.Ready);
      }
      setHostNote(null);
      canvasRef.current?.focus();
    };

    if (!repo || !repo.enabled) {
      // Disable-safe: New session (Clear alias) — local only, no cloud DELETE.
      void (async () => {
        const pid = await resolveNewPersona();
        resetBridge(createEmptySession().id, pid);
        setUrlSessionId(null);
      })();
      return;
    }

    void (async () => {
      // Clear = New session: delete THIS session only (other sessions survive),
      // then mint a brand-new server session (parent #415 lock).
      await repo.remove(clearedId);
      // Post-Clear active session is server-minted: the next turn PUTs against a
      // real resource, never a throwaway local sess_ id.
      const created = await repo.create();
      const pid = await resolveNewPersona();
      if (created.action === 'ok') {
        resetBridge(created.snapshot.id, pid);
        setUrlSessionId(created.snapshot.id);
      } else {
        resetBridge(createEmptySession().id, pid);
        setUrlSessionId(null);
      }
      void refreshSessions();
    })();
  }, [writeLocalSession, refreshSessions, setUrlSessionId, resolveNewPersona]);

  const onNewSession = useCallback(() => {
    const repo = repoRef.current;
    if (!repo || !repo.enabled || inflightRef.current || switchInFlightRef.current) return;
    // Adversarial #642: ack any stale session-switch pending synchronously at
    // click before the async repo.create + activateSession.
    bridgeRef.current?.takePendingSessionSwitch();
    abortRef.current?.abort();
    void (async () => {
      const created = await repo.create();
      if (created.action !== 'ok') return; // stay on the current session
      const pid = await resolveNewPersona();
      const base = createEmptySession(created.snapshot.id);
      // Phase 3 (#488): New session binds the chosen persona, the default, or
      // explicit None. Fresh id + empty transcript; createEmptySession already
      // resets cwd/sandbox.
      const empty = pid ? { ...base, personaId: pid } : base;
      activateSession(empty);
      setUrlSessionId(created.snapshot.id);
      repo.put(created.snapshot.id, empty);
    })();
  }, [activateSession, setUrlSessionId, resolveNewPersona]);

  const onSwitchSession = useCallback(
    (id: string) => {
      const repo = repoRef.current;
      const bridge = bridgeRef.current;
      if (!repo || !repo.enabled || !bridge || inflightRef.current) return;
      if (switchInFlightRef.current) return; // another switch already in-flight
      if (id === sessionRef.current.id) return;
      abortRef.current?.abort();
      const sourceId = sessionRef.current.id; // generation token — guard against stale get
      switchInFlightRef.current = true;
      void (async () => {
        try {
          const got = await repo.get(id);
          // Adversarial #642: re-check the generation token after every await so
          // a New/Clear during repo.get does not activate the stale destination.
          if (sessionRef.current.id !== sourceId) return;
          if (got.action !== 'ok') return; // 404/gone stays on current local session (never blank)
          // Adopt the server transcript; canonical id = fetched id.
          activateSession(got.snapshot);
          setUrlSessionId(id);
        } finally {
          switchInFlightRef.current = false;
        }
      })();
    },
    [activateSession, setUrlSessionId],
  );
  onSwitchSessionRef.current = onSwitchSession;

  useEffect(() => {
    const b = bridgeRef.current;
    if (!b || phase !== 'ready') return;
    if (!cloudEnabled) {
      b.setSessionCatalog([], null);
      return;
    }
    b.setSessionCatalog(buildSessionCatalogEntries(sessions, activeSessionId), activeSessionId);
  }, [sessions, activeSessionId, cloudEnabled, phase]);

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
          busy={busy}
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
              {phase === 'ready' && (
                <SessionPicker
                  hidden={!cloudEnabled}
                  disabled={busy}
                  onNew={onNewSession}
                />
              )}
              {phase === 'ready' && (
                <PersonaPicker
                  value={personaPick}
                  onChange={setPersonaPick}
                  disabled={busy}
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
