/**
 * Wall-clock deadline helpers (plan #923 / adversarial-review #926).
 *
 * Directive-free so vitest can lock signal construction without the Workflows
 * transform. `'use step'` shells rebuild an AbortSignal from a serialized
 * `deadlineAt` number — never pass a signal/closure across a step boundary.
 */

import { TURN_WALL_CLOCK_WRAPUP_MAX_MS } from '../sessionCloudCaps';

export function isDeadlineElapsed(
  deadlineAt: number | undefined,
  now = Date.now(),
): boolean {
  if (deadlineAt === undefined) return false;
  return deadlineAt - now <= 0;
}

/**
 * Absolute epoch for the **wall** wrap-up substitute bound.
 *
 * Pin to `deadlineAt + TURN_WALL_CLOCK_WRAPUP_MAX_MS` so a retried wrap-up
 * attempt cannot mint a fresh 5-min window from `Date.now()` (adversarial-
 * review #926). When the caller never supplied a 1h deadline, fall back to
 * `now + WRAPUP_MAX` (tests / inert cap).
 */
export function wrapUpDeadlineAt(
  deadlineAt: number | undefined,
  now = Date.now(),
): number {
  if (deadlineAt === undefined) return now + TURN_WALL_CLOCK_WRAPUP_MAX_MS;
  return deadlineAt + TURN_WALL_CLOCK_WRAPUP_MAX_MS;
}

/**
 * Rebuild an abort signal for THIS step attempt from a serialized epoch
 * deadline. `AbortSignal.timeout` fires on every retried attempt of a retried
 * step. An elapsed deadline returns an already-aborted signal. `undefined`
 * when the caller never supplied a deadline (cap inert).
 */
export function deadlineSignal(
  deadlineAt: number | undefined,
  now = Date.now(),
): AbortSignal | undefined {
  if (deadlineAt === undefined) return undefined;
  const remaining = deadlineAt - now;
  if (remaining <= 0) return AbortSignal.abort();
  return AbortSignal.timeout(remaining);
}

/** Combine 0–N abort signals. `undefined` if none were provided. */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s != null);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}
