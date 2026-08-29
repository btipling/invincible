/**
 * Host-side localStorage quota signal (plan #865).
 *
 * Ring-only: paints one in-canvas Error row per quota episode. Does **not**
 * append onto `SessionSnapshot.messages` (cannot persist the line, and would
 * enlarge the payload that just failed). Never rethrows — cloud persist after
 * `writeLocalSession` must still run.
 *
 * Mid-turn `onSessionPatch` must pass `{ paint: false }`. A ring Error row
 * becomes last, so `inv_update_last_message` misses the open assistant/tool
 * card and `livePaintToolRun` appends a duplicate `tool_run` (adversarial
 * #870). The same steal happens if we paint while `turnStatus==='running'`
 * and a later hot-resume / Send-while-running attach starts a new
 * `runHarnessTurn` — `lastRingRowIsToolRun` is initialized from the snapshot
 * last role, not the ring. Skip paint on running snapshots; a terminal persist
 * still throws and paints once.
 *
 * Callers that rebuild the ring after save (`hydrateMessages` / `clearMessages`)
 * must pass `{ paint: false }` and then `paintQuotaAfterRebuild` so the once-flag
 * is not spent on a row the rebuild immediately drops (adversarial #870).
 * Load-earlier / needSnap rebuild without a save must still
 * `paintQuotaAfterRebuild(..., warned.current)` after hydrate — F5 resets the
 * ref, those in-page rebuilds do not.
 */
import { MessageKind } from './harnessBridge';
import { isQuotaExceededError, type SessionSnapshot, type SessionStore } from './sessionStore';

export const LOCAL_SAVE_QUOTA_ERROR =
  "Couldn't save this session locally (storage full). Cloud sync still runs.";

export type QuotaWarnFlag = { current: boolean };

export type QuotaErrorBridge = {
  pushMessage(kind: MessageKind, text: string): void;
};

export type TryLocalSaveOpts = {
  /**
   * When false, quota is still swallowed (never rethrown) but the Error row
   * is not painted and the once-flag is left unset so a later save can paint.
   * Default true. Running snapshots skip paint regardless (see `tryLocalSave`).
   */
  paint?: boolean;
};

/**
 * Paint the locked quota copy once per episode. No-op while `warned.current`.
 * Does not set the flag when there is no bridge (so the first live canvas can
 * still paint). Never throws.
 */
export function pushHostQuotaError(
  bridge: QuotaErrorBridge | null | undefined,
  warned: QuotaWarnFlag,
): void {
  if (warned.current) return;
  if (!bridge) return;
  try {
    bridge.pushMessage(MessageKind.Error, LOCAL_SAVE_QUOTA_ERROR);
    warned.current = true;
  } catch {
    /* ignore — never throw out of the host save catch */
  }
}

/**
 * After a ring rebuild (`hydrateMessages` / `clearMessages`), paint if the
 * save that preceded it quota'd. Clears the once-flag first so a push that
 * the rebuild just dropped does not spend the episode. Skips while the
 * snapshot is still `running` (cold attach / hot resume must not see Error
 * as last). Never throws.
 */
export function paintQuotaAfterRebuild(
  bridge: QuotaErrorBridge | null | undefined,
  warned: QuotaWarnFlag,
  quota: boolean,
  snapshot?: Pick<SessionSnapshot, 'turnStatus'>,
): void {
  if (!quota) return;
  if (snapshot?.turnStatus === 'running') return;
  warned.current = false;
  pushHostQuotaError(bridge, warned);
}

/**
 * Wrap `store.save`. Returns whether `save` threw quota (even when paint is
 * skipped). Success clears the once-flag (next quota can paint again).
 * Quota throw → `pushHostQuotaError` unless `{ paint: false }` **or** the
 * snapshot is still `running` (hot resume / Send-while-running may continue
 * the stream). Other throws are not expected (`save` swallows non-quota) and
 * are not rethrown.
 */
export function tryLocalSave(
  store: SessionStore | null | undefined,
  snapshot: SessionSnapshot,
  bridge: QuotaErrorBridge | null | undefined,
  warned: QuotaWarnFlag,
  opts?: TryLocalSaveOpts,
): boolean {
  if (!store) return false;
  try {
    store.save(snapshot);
    warned.current = false;
    return false;
  } catch (err) {
    if (!isQuotaExceededError(err)) return false;
    if (opts?.paint === false) return true;
    if (snapshot.turnStatus === 'running') return true;
    pushHostQuotaError(bridge, warned);
    return true;
  }
}
