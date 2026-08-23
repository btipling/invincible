import { describe, expect, it } from 'vitest';
import { decideDetach } from './detachTurn';

/**
 * Host detach seam (plan #789, source #766 — backend-agents slice C).
 *
 * Closing a viewport (unmount, session switch, New/Clear, logout) must NOT treat
 * "the tab went away" as "the turn is over". The guard must distinguish a
 * durable server-owned run (meta.turnRunId present, post-E — close reader only)
 * from a legacy tab-owned /api/agent fetch (no turnRunId, the slice-C reality —
 * abort so no unpersisted 1800s Function keeps burning with no writer).
 *
 * Neither path sends a server cancel; this decides only the client-side
 * AbortController for the attached fetch. Plan-review Major fix: a naïve
 * "detach = never abort" would strand a present-but-unbacked busy tab, so the
 * decision keys on `turnRunId` PRESENCE, not merely "no live turn".
 */
describe('decideDetach (detach vs abort guard)', () => {
  it('no turnRunId → abort (legacy tab-owned turn must still abort so nothing burns unpersisted)', () => {
    expect(decideDetach(undefined)).toEqual({ kind: 'abort', reason: 'legacy-turn' });
  });

  it('empty turnRunId → abort (guard keys on presence; a present-but-empty is legacy)', () => {
    expect(decideDetach('')).toEqual({ kind: 'abort', reason: 'legacy-turn' });
  });

  it('present turnRunId → close-reader only (durable server-owned run survives the tab)', () => {
    expect(decideDetach('wf_run_9ax2k')).toEqual({
      kind: 'close-reader',
      reason: 'durable-run',
    });
  });

  it('present turnRunId never aborts and never signals a server cancel on either path', () => {
    const run = decideDetach('wf_run_a');
    expect(run.kind).toBe('close-reader');
    // No remote-cancel instruction is ever part of the decision — the seam is a
    // viewport-close, not a cancel; only Stop/Esc (takePendingCancel) cancels.
    expect(run).not.toHaveProperty('serverCancel');
  });
});
