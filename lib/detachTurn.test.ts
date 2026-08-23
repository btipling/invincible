import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

describe('HarnessHost wiring lock — tear-down uses detachTurn (PR #790 review L6)', () => {
  it('unmount/switch/New/Clear each call detachTurn() (4 sites); the only abortRef.abort() sites are detachTurn, runPrompt, takePendingCancel', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'app/harness/HarnessHost.tsx'),
      'utf-8',
    );
    // 1) The detach seam is wired on ALL FOUR tear-down paths. If anyone reverts
    //    unmount/switch/New/Clear back to a direct abortRef.abort(), this count
    //    drops to 3 and the durable-run #710 behavior lives only in the
    //    (untested) cleanup — decideDetach stays green and the seam vanishes.
    const detachSites = src.match(/detachTurn\(\);/g) ?? [];
    expect(detachSites).toHaveLength(4);
    // Anchor the four sites so a rename of both sides can't false-pass.
    expect(src).toContain('// Plan #789 (source #766): unmount detaches');
    expect(src).toContain('// Plan #789 (source #766): Clear/New detaches');
    expect(src).toContain('// Plan #789 (source #766): New detaches');
    expect(src).toContain('// Plan #789 (source #766): switching away detaches');
    // 2) The only remaining abortRef.abort() sites are the detachTurn legacy
    //    path, the runPrompt controller-replace, and the Stop/Esc
    //    takePendingCancel poll. A misplaced abort on a durable-run path (or a
    //    revert of the unmount seam back to abort) bumps this count and fails.
    const abortSites = src.match(/abortRef\.current\?\.abort\(\);/g) ?? [];
    expect(abortSites).toHaveLength(3);
    // The three allowed contexts survive — detachTurn itself, runPrompt's
    // controller replace, and the poll's takePendingCancel (Stop/Esc) guard.
    expect(src).toContain("if (decision.kind === 'abort') {");
    expect(src).toContain('const controller = new AbortController();');
    expect(src).toContain('if (b.takePendingCancel()) {');
  });
});
