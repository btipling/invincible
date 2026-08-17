/**
 * Plan #616 (source #610) — host-side model-persist logic extracted from HarnessHost
 * so it can be unit-tested without rendering React. The HarnessHost callbacks
 * delegate to these pure functions; dependencies arrive as explicit parameters.
 */
import type { HarnessBridge } from './harnessBridge';
import type { IdSessionRepository } from './sessionRepository';
import type { SessionSnapshot, SessionStore } from './sessionStore';

/**
 * Host-side session-ref shape — the mutable current-session holder + persist seam.
 * HarnessHost owns the real refs; tests inject mocks.
 */
export interface ModelPersistSessionRef {
  current: SessionSnapshot;
}

/** Persist seam: write to local SessionStore. */
export type PersistLocal = (next: SessionSnapshot) => void;

/**
 * Plan #616 Goal 3: after a catalog-push restore, if the stored model id is NOT
 * in the current catalog, drop `selectedModel` from the snapshot so a revoked
 * model never ghosts back on re-grant. The bridge returns `true` even on a miss
 * (Wasm falls back to index 0 silently), so a host-side compare is mandatory.
 * Only drops when the catalog is loaded AND non-empty (`getSelectedModel()`
 * non-null); never drops on transport failure.
 *
 * @param snap — the snapshot whose stored model id to restore.
 * @param bridge — live HarnessBridge (null-guarded by the caller).
 * @param sessionRef — mutable holder of the current SessionSnapshot.
 * @param persist — local-save + (optional) cloud-PUT seam.
 * @param repo — cloud session repo (nullable; no-op on null).
 */
export function applySessionModel(
  snap: SessionSnapshot,
  bridge: HarnessBridge,
  sessionRef: ModelPersistSessionRef,
  persist: PersistLocal,
  repo: IdSessionRepository | null,
): void {
  const storedId = snap.selectedModel;
  bridge.setSelectedModel(storedId ?? null);
  if (!storedId) return;
  // Compare the live selection after set-by-id — if the catalog is loaded
  // (non-null) and the live id differs from the stored id, the stored id
  // wasn't in the catalog. Drop it from the snapshot + persist so the ghost
  // pick can never resurrect on a later re-grant.
  const live = bridge.getSelectedModel();
  if (live !== null && live !== storedId) {
    delete sessionRef.current.selectedModel;
    persist({ ...sessionRef.current });
    repo?.put(sessionRef.current.id, sessionRef.current);
  }
}

/**
 * Plan #616: a user Next cycle in Wasm raises the pending-model-change flag.
 * The host folds the LIVE selection into the session snapshot and persists
 * (local save + cloud PUT) so a pick survives without waiting for a turn, then
 * acks. Stamps `updatedAt: Date.now()` so LWW peers and `shouldAdoptBootServer`
 * see the Next-only persist.
 *
 * @param bridge — live HarnessBridge (null-guarded by the caller).
 * @param sessionRef — mutable holder of the current SessionSnapshot.
 * @param persist — local-save seam.
 * @param repo — cloud session repo (nullable; no-op on null).
 * @param isInflight — true when a turn is running (caller gates before calling).
 */
export function foldPendingModelChange(
  bridge: HarnessBridge,
  sessionRef: ModelPersistSessionRef,
  persist: PersistLocal,
  repo: IdSessionRepository | null,
  isInflight: boolean,
): void {
  if (isInflight) return;
  if (!bridge.hasPendingModelChange()) return;
  const liveId = bridge.getSelectedModel();
  const next: SessionSnapshot = { ...sessionRef.current, updatedAt: Date.now() };
  if (liveId) next.selectedModel = liveId;
  else delete next.selectedModel;
  if (next.id !== sessionRef.current.id) {
    bridge.ackPendingModelChange();
    return;
  }
  persist(next);
  repo?.put(next.id, next);
  bridge.ackPendingModelChange();
}
