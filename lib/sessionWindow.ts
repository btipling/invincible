/**
 * Host-side ring window math for SessionStore → Wasm hydrate.
 * Zig ring capacity is MAX_MSG=48 (`native/harness/src/bridge.zig`) — keep in sync.
 */

import type { SessionMessage } from './sessionStore';

/** Must match Zig `MAX_MSG`. */
export const HARNESS_RING_MAX = 48;

/** How far “Load earlier” steps back along session.messages. */
export const HISTORY_PAGE = 24;

/** Index of the oldest message in the latest ring window. */
export function latestRingStart(
  messageCount: number,
  ringMax: number = HARNESS_RING_MAX,
): number {
  if (messageCount <= 0 || ringMax <= 0) return 0;
  return Math.max(0, messageCount - ringMax);
}

/** Next window start when loading earlier history (never below 0). */
export function earlierRingStart(
  ringWindowStart: number,
  page: number = HISTORY_PAGE,
): number {
  if (ringWindowStart <= 0) return 0;
  return Math.max(0, ringWindowStart - Math.max(1, page));
}

/** True when session has messages older than the current ring window. */
export function canLoadEarlier(ringWindowStart: number): boolean {
  return ringWindowStart > 0;
}

/**
 * Slice of session messages to hydrate into the ring (length ≤ ringMax).
 * Never returns more than `ringMax` messages.
 */
export function sliceMessagesForRing(
  messages: readonly SessionMessage[],
  windowStart: number,
  ringMax: number = HARNESS_RING_MAX,
): SessionMessage[] {
  const start = Math.max(0, Math.min(windowStart, messages.length));
  return messages.slice(start, start + ringMax);
}
