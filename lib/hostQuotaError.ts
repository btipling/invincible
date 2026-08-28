/**
 * Host-side localStorage quota signal (plan #865).
 *
 * Ring-only: paints one in-canvas Error row per quota episode. Does **not**
 * append onto `SessionSnapshot.messages` (cannot persist the line, and would
 * enlarge the payload that just failed). Never rethrows — cloud persist after
 * `writeLocalSession` must still run.
 */
import { MessageKind } from './harnessBridge';
import { isQuotaExceededError, type SessionSnapshot, type SessionStore } from './sessionStore';

export const LOCAL_SAVE_QUOTA_ERROR =
  "Couldn't save this session locally (storage full). Cloud sync still runs.";

export type QuotaWarnFlag = { current: boolean };

export type QuotaErrorBridge = {
  pushMessage(kind: MessageKind, text: string): void;
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
 * Wrap `store.save`. Success clears the once-flag (next quota can paint again).
 * Quota throw → `pushHostQuotaError`. Other throws are not expected (`save`
 * swallows non-quota) and are not rethrown.
 */
export function tryLocalSave(
  store: SessionStore | null | undefined,
  snapshot: SessionSnapshot,
  bridge: QuotaErrorBridge | null | undefined,
  warned: QuotaWarnFlag,
): void {
  if (!store) return;
  try {
    store.save(snapshot);
    warned.current = false;
  } catch (err) {
    if (!isQuotaExceededError(err)) return;
    pushHostQuotaError(bridge, warned);
  }
}
