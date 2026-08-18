/**
 * Gate for a future host auto-continue (session TODO drain).
 *
 * Operator queued follow-ups and an unacked pending submit always win.
 * There is no HarnessHost caller yet — do not invent one.
 */
export function canAutoContinue(opts: {
  inflight: boolean;
  queuedCount: number;
  hasPendingSubmit: boolean;
}): boolean {
  return !opts.inflight && opts.queuedCount === 0 && !opts.hasPendingSubmit;
}
