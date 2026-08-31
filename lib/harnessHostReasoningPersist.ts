/**
 * Plan #898 — host-side reasoning-effort persist, extracted from HarnessHost
 * so it can be unit-tested without rendering React. Host owns the default
 * (`defaultEffortFromOptions`); Wasm only paints + raises pending on click.
 */
import { defaultEffortFromOptions } from './agent/reasoningConfig';
import { toGatewayReasoningWire } from './gateway/reasoningWire';
import type { HarnessBridge } from './harnessBridge';
import type { IdSessionRepository } from './sessionRepository';
import type { SessionSnapshot } from './sessionStore';
import { sanitizeReasoningEffort } from './sessionCloudCaps';
import type { ModelPersistSessionRef, PersistLocal } from './harnessHostModelPersist';

/**
 * Push this model's joined effort list into Wasm and restore-or-default the
 * selection. Catalog / stored `max` is rewritten to `xhigh` (picker label
 * stays `xhigh`). The default algorithm never chooses `xhigh` / `max`.
 * Poison / not-in-list / unset → `defaultEffortFromOptions`.
 * Empty options → clear list (picker hidden) and drop the carrier.
 */
export function applySessionReasoning(
  snap: SessionSnapshot,
  options: readonly string[],
  bridge: HarnessBridge,
  sessionRef: ModelPersistSessionRef,
  persist: PersistLocal,
  repo: IdSessionRepository | null,
): void {
  const cleanedOptions: string[] = [];
  for (const v of options) {
    const token = toGatewayReasoningWire(v);
    if (!token) continue;
    if (cleanedOptions.includes(token)) continue;
    cleanedOptions.push(token);
  }
  bridge.setReasoningEfforts(cleanedOptions);

  if (cleanedOptions.length === 0) {
    bridge.setSelectedReasoning(null);
    if (sessionRef.current.reasoningEffort !== undefined) {
      delete sessionRef.current.reasoningEffort;
      sessionRef.current.updatedAt = Date.now();
      persist({ ...sessionRef.current });
      repo?.put(sessionRef.current.id, sessionRef.current);
    }
    return;
  }

  const storedRaw = sanitizeReasoningEffort(snap.reasoningEffort);
  const stored = toGatewayReasoningWire(snap.reasoningEffort);
  const pick =
    stored && cleanedOptions.includes(stored)
      ? stored
      : defaultEffortFromOptions(cleanedOptions);
  if (pick) bridge.setSelectedReasoning(pick);
  else bridge.setSelectedReasoning(null);

  const live = bridge.getSelectedReasoning();
  // Drop a sticky/poisoned carrier, or rewrite stored `max` to live `xhigh`.
  // Unset carrier stays omitted (New/Clear: default lives in Wasm only).
  if (storedRaw !== undefined && storedRaw !== (live ?? undefined)) {
    if (live) sessionRef.current.reasoningEffort = live;
    else delete sessionRef.current.reasoningEffort;
    sessionRef.current.updatedAt = Date.now();
    persist({ ...sessionRef.current });
    repo?.put(sessionRef.current.id, sessionRef.current);
  }
}

/**
 * User effort-menu pick. Fold the LIVE selection into the snapshot and persist
 * so a pick survives without a turn, then ack. Picker tokens are wire values
 * (`xhigh`, never `max`).
 */
export function foldPendingReasoningChange(
  bridge: HarnessBridge,
  sessionRef: ModelPersistSessionRef,
  persist: PersistLocal,
  repo: IdSessionRepository | null,
  isInflight: boolean,
): void {
  if (isInflight) return;
  if (!bridge.hasPendingReasoningChange()) return;
  const live = bridge.getSelectedReasoning();
  const next: SessionSnapshot = { ...sessionRef.current, updatedAt: Date.now() };
  if (live) next.reasoningEffort = live;
  else delete next.reasoningEffort;
  persist(next);
  repo?.put(next.id, next);
  bridge.ackPendingReasoningChange();
}

/** Clear-only — same rationale as `discardPendingModelChange`. */
export function discardPendingReasoningChange(bridge: HarnessBridge): void {
  if (bridge.hasPendingReasoningChange()) bridge.ackPendingReasoningChange();
}
