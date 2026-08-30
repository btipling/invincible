/**
 * Gate for host auto-continue after a recoverable bookkeeping give-up
 * (plan #887 — `shouldAutoContinueAfterGiveUp` / HarnessHost).
 *
 * Operator queued follow-ups and an unacked pending submit always win.
 */
export function canAutoContinue(opts: {
  inflight: boolean;
  queuedCount: number;
  hasPendingSubmit: boolean;
}): boolean {
  return !opts.inflight && opts.queuedCount === 0 && !opts.hasPendingSubmit;
}
