/**
 * Plan #812 (backend-agents D18) — unit + source-lock tests for `decideDetach`.
 *
 * Rows (locked contract + adversarial #844):
 *   - durable run present (turnRunId + turnStatus running/cancelling) → `detach`
 *   - in-flight `/api/turns` reader (`durablePath`) → `detach` even before
 *     headers fold running onto the session
 *   - idle / no run id → `noop`
 *   - in-flight turn, no durable run id → `detach-close`
 *   - Stop / Esc → `cancel`
 * Plus persist-after-detach (adversarial #844 re-review): Clear discarded →
 * `drop` (never resurrect via PUT upsert); detached+running → `preserve`;
 * live epoch → `live`.
 * Plus first-turn mint bind (adversarial #844): preserve targets pending mint
 * UUID not `sess_*`; mint bind skipped on Switch/Clear; unmount still binds.
 * Plus unmount-nulling `repoRef` still PUTs via the captured repo object.
 * Plus the source-lock that counts `decideDetach`-wired detach sites vs raw
 * `abort()` call sites in `HarnessHost.tsx`.
 * Plus same-tab EOF detach must not light ember `hostNote` (adversarial #853).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  abortReasonFor,
  applyStopFoldToSession,
  decideDetach,
  decideDetachPersist,
  decideStopFoldPost,
  decideStopFoldPre,
  DETACH_ABORT_REASON,
  isDetachAbort,
  preserveTargetId,
  putPreservedTurn,
  releaseBusyViewport,
  shouldAbortReader,
  shouldApplyMintBind,
  shouldSetHostTurnNote,
  shouldSkipCancelPost,
  type DetachTurnInput,
} from './detachTurn';

function input(over: Partial<DetachTurnInput> = {}): DetachTurnInput {
  return { cancel: false, inflight: false, ...over };
}

describe('decideDetach (plan #812 D18 contract)', () => {
  it('Stop / Esc → cancel (never routed through detach)', () => {
    expect(
      decideDetach(
        input({
          cancel: true,
          inflight: true,
          durablePath: true,
          turnRunId: 'run_1',
          turnStatus: 'running',
        }),
      ),
    ).toBe('cancel');
    expect(
      decideDetach(
        input({
          cancel: true,
          inflight: false,
        }),
      ),
    ).toBe('cancel');
  });

  it('durable run present + running → detach', () => {
    const d = decideDetach(
      input({ inflight: true, turnRunId: 'run_abc', turnStatus: 'running' }),
    );
    expect(d).toBe('detach');
    expect(shouldAbortReader(d)).toBe(true);
    expect(abortReasonFor(d)).toBe(DETACH_ABORT_REASON);
  });

  it('durable run present + cancelling → detach', () => {
    const d = decideDetach(
      input({ inflight: true, turnRunId: 'run_abc', turnStatus: 'cancelling' }),
    );
    expect(d).toBe('detach');
    expect(abortReasonFor(d)).toBe(DETACH_ABORT_REASON);
  });

  it('in-flight durablePath with no local running yet → detach (adversarial #844)', () => {
    const d = decideDetach(input({ inflight: true, durablePath: true }));
    expect(d).toBe('detach');
    expect(shouldAbortReader(d)).toBe(true);
    expect(abortReasonFor(d)).toBe(DETACH_ABORT_REASON);
    // Leftover completed id from a prior turn must not force detach-close.
    expect(
      decideDetach(
        input({
          inflight: true,
          durablePath: true,
          turnRunId: 'run_old',
          turnStatus: 'completed',
        }),
      ),
    ).toBe('detach');
  });

  it('durable run with terminal status (completed) → not detach, noop when idle', () => {
    expect(
      decideDetach(input({ inflight: false, turnRunId: 'run_1', turnStatus: 'completed' })),
    ).toBe('noop');
    expect(
      decideDetach(input({ inflight: false, turnRunId: 'run_1', turnStatus: 'idle' })),
    ).toBe('noop');
  });

  it('idle / no run id → noop (nothing to do)', () => {
    expect(decideDetach(input({}))).toBe('noop');
    expect(decideDetach({ cancel: false, inflight: false })).toBe('noop');
    expect(shouldAbortReader('noop')).toBe(false);
  });

  it('in-flight turn with no durable run id → detach-close (client abort OK)', () => {
    const d = decideDetach(input({ inflight: true }));
    expect(d).toBe('detach-close');
    expect(shouldAbortReader(d)).toBe(true);
    expect(abortReasonFor(d)).toBeUndefined();
    expect(
      decideDetach(input({ inflight: true, turnStatus: 'running' })),
    ).toBe('detach-close');
  });

  it('shouldAbortReader: detach / detach-close / cancel close the reader', () => {
    expect(shouldAbortReader('detach')).toBe(true);
    expect(shouldAbortReader('detach-close')).toBe(true);
    expect(shouldAbortReader('noop')).toBe(false);
    expect(shouldAbortReader('cancel')).toBe(true);
  });

  it('isDetachAbort: only abort(DETACH_ABORT_REASON)', () => {
    const detach = new AbortController();
    detach.abort(DETACH_ABORT_REASON);
    expect(isDetachAbort(detach.signal)).toBe(true);
    const stop = new AbortController();
    stop.abort();
    expect(isDetachAbort(stop.signal)).toBe(false);
    expect(isDetachAbort(undefined)).toBe(false);
  });
});

describe('decideDetachPersist (adversarial #844 Clear-vs-PUT / late persist)', () => {
  it('Clear/remove discarded → drop even with running+id (never resurrect)', () => {
    expect(
      decideDetachPersist({
        detached: true,
        discarded: true,
        turnRunId: 'wr_live',
        turnStatus: 'running',
      }),
    ).toBe('drop');
    expect(
      decideDetachPersist({
        detached: false,
        discarded: true,
        turnRunId: 'wr_live',
        turnStatus: 'running',
      }),
    ).toBe('drop');
  });

  it('detached + running + turnRunId → preserve (Switch/New/unmount)', () => {
    expect(
      decideDetachPersist({
        detached: true,
        discarded: false,
        turnRunId: 'wr_live',
        turnStatus: 'running',
      }),
    ).toBe('preserve');
  });

  it('detached without a durable running id → drop (no omit-clear PUT)', () => {
    expect(
      decideDetachPersist({ detached: true, discarded: false }),
    ).toBe('drop');
    expect(
      decideDetachPersist({
        detached: true,
        discarded: false,
        turnRunId: 'wr_old',
        turnStatus: 'completed',
      }),
    ).toBe('drop');
    expect(
      decideDetachPersist({
        detached: true,
        discarded: false,
        turnRunId: 'wr_old',
        turnStatus: 'cancelling',
      }),
    ).toBe('drop');
  });

  it('still on this turn (epoch match) → live', () => {
    expect(
      decideDetachPersist({
        detached: false,
        discarded: false,
        turnRunId: 'wr_live',
        turnStatus: 'running',
      }),
    ).toBe('live');
    expect(decideDetachPersist({ detached: false, discarded: false })).toBe('live');
  });
});

describe('preserveTargetId / shouldApplyMintBind (adversarial #844 first-turn mint)', () => {
  it('preserve PUT lands on pending mint UUID, not local sess_*', () => {
    expect(preserveTargetId('sess_local', 'uuid-mint')).toBe('uuid-mint');
    expect(preserveTargetId('sess_local', '  uuid-mint  ')).toBe('uuid-mint');
    expect(preserveTargetId('sess_local', null)).toBe('sess_local');
    expect(preserveTargetId('sess_local', undefined)).toBe('sess_local');
    expect(preserveTargetId('sess_local', '')).toBe('sess_local');
    expect(preserveTargetId('sess_local', '   ')).toBe('sess_local');
  });

  it('unmount / same-session applies mint bind; Switch and Clear do not', () => {
    expect(
      shouldApplyMintBind({
        sessionId: 'sess_local',
        startedId: 'sess_local',
        discarded: false,
        switchInFlight: false,
      }),
    ).toBe(true);
    expect(
      shouldApplyMintBind({
        sessionId: 'sess_local',
        startedId: 'sess_local',
        discarded: false,
        switchInFlight: true,
      }),
    ).toBe(false);
    expect(
      shouldApplyMintBind({
        sessionId: 'sess_local',
        startedId: 'sess_local',
        discarded: true,
        switchInFlight: false,
      }),
    ).toBe(false);
    expect(
      shouldApplyMintBind({
        sessionId: 'other',
        startedId: 'sess_local',
        discarded: false,
        switchInFlight: false,
      }),
    ).toBe(false);
  });

  it('unmount-nulling the host repo ref still PUTs the captured repo (adversarial #844)', () => {
    const puts: { id: string; snap: { id: string; turnRunId?: string; turnStatus?: string } }[] =
      [];
    const liveRepo = {
      put(id: string, snap: { id: string; turnRunId?: string; turnStatus?: string }) {
        puts.push({ id, snap });
      },
    };
    let repoRef: typeof liveRepo | null = liveRepo;
    const captured = repoRef;
    repoRef = null;
    const snapshot = {
      id: 'sess_local',
      turnRunId: 'wr_live',
      turnStatus: 'running' as const,
    };
    const { targetId, preserved } = putPreservedTurn(
      captured,
      snapshot,
      'sess_local',
      'uuid-mint',
    );
    expect(repoRef).toBeNull();
    expect(targetId).toBe('uuid-mint');
    expect(preserved).toEqual({
      id: 'uuid-mint',
      turnRunId: 'wr_live',
      turnStatus: 'running',
    });
    expect(puts).toEqual([
      {
        id: 'uuid-mint',
        snap: { id: 'uuid-mint', turnRunId: 'wr_live', turnStatus: 'running' },
      },
    ]);
  });

  it('putPreservedTurn with a null captured repo is a no-op (no throw)', () => {
    expect(() =>
      putPreservedTurn(
        null,
        { id: 'sess_local', turnRunId: 'wr_live', turnStatus: 'running' },
        'sess_local',
        'uuid-mint',
      ),
    ).not.toThrow();
  });
});

describe('releaseBusyViewport', () => {
  it('clears inflight + busy, promote-gate false, then Ready', () => {
    const inflightRef = { current: true };
    const setBusy = vi.fn();
    const setQueuePromoteAllowed = vi.fn();
    const setLifecycleReady = vi.fn();
    releaseBusyViewport({
      inflightRef,
      setBusy,
      setQueuePromoteAllowed,
      setLifecycleReady,
    });
    expect(inflightRef.current).toBe(false);
    expect(setBusy).toHaveBeenCalledWith(false);
    expect(setQueuePromoteAllowed).toHaveBeenCalledWith(false);
    expect(setLifecycleReady).toHaveBeenCalledTimes(1);
    expect(setQueuePromoteAllowed.mock.invocationCallOrder[0]).toBeLessThan(
      setLifecycleReady.mock.invocationCallOrder[0],
    );
  });
});

describe('HarnessHost detach wiring source-lock (plan #812 D18)', () => {
  const host = readFileSync(resolve(process.cwd(), 'app/harness/HarnessHost.tsx'), 'utf8');
  const module = readFileSync(resolve(process.cwd(), 'lib/detachTurn.ts'), 'utf8');

  it('decideDetach + shouldAbortReader exist in lib/detachTurn.ts', () => {
    expect(module).toContain('export function decideDetach');
    expect(module).toContain('export function shouldAbortReader');
    expect(module).toContain('export function abortReasonFor');
    expect(module).toContain('export function decideDetachPersist');
    expect(module).toContain('export function preserveTargetId');
    expect(module).toContain('export function putPreservedTurn');
    expect(module).toContain('export function shouldApplyMintBind');
    expect(module).toContain('export function shouldSetHostTurnNote');
    expect(module).toContain('export function releaseBusyViewport');
    expect(module).toContain('durablePath');
  });

  it('host wires 4 detach sites through decideDetach and never the Stop/Esc path', () => {
    const detachCalls = host.match(/detachTurn\(\)/g) ?? [];
    expect(detachCalls.length).toBe(4);

    const helper = host.slice(
      host.indexOf('const detachTurn = useCallback'),
      host.indexOf('const runPrompt = useCallback'),
    );
    expect(helper).toContain('decideDetach(');
    expect(helper).toContain('shouldAbortReader(');
    expect(helper).toContain('abortReasonFor(');
    expect(helper).toContain('durablePath: true');
    expect(helper).toContain('releaseBusyViewport(');
    expect(helper).toContain('turnEpochRef.current += 1');
  });

  it('raw abort() sites: helper (reasoned) + runPrompt supersede + poll Stop', () => {
    const aborts = host.match(/abortRef\.current\?\.abort\(/g) ?? [];
    expect(aborts.length).toBe(3);
    const poll = host.slice(
      host.indexOf('const poll = () =>'),
      host.indexOf('pollRef.current = window.setTimeout(poll, 150)'),
    );
    expect(poll).toContain('takePendingCancel()');
    expect(poll).toContain('abortRef.current?.abort()');
    expect(poll).toContain('releaseBusyViewport(');
    expect(poll).not.toContain('decideDetach');
    expect(poll).not.toContain('abortReasonFor');
    expect(poll).not.toContain('turnEpochRef');
  });

  it('Clear / New / Switch do not return on inflight before detachTurn', () => {
    const clear = host.slice(host.indexOf('const onClear = useCallback'), host.indexOf('const onNewSession'));
    expect(clear).toContain('detachTurn()');
    expect(clear).not.toMatch(/if \(inflightRef\.current/);
    const neu = host.slice(
      host.indexOf('const onNewSession = useCallback'),
      host.indexOf('const onSwitchSession = useCallback'),
    );
    expect(neu).toContain('detachTurn()');
    expect(neu).not.toMatch(/inflightRef\.current \|\| switchInFlightRef/);
    const sw = host.slice(
      host.indexOf('const onSwitchSession = useCallback'),
      host.indexOf('onSwitchSessionRef.current = onSwitchSession'),
    );
    expect(sw).toContain('detachTurn()');
    expect(sw).not.toMatch(/inflightRef\.current\) return/);
  });

  it('Clear marks discarded id before remove so post-detach PUT cannot upsert', () => {
    const clear = host.slice(host.indexOf('const onClear = useCallback'), host.indexOf('const onNewSession'));
    expect(clear).toContain('discardedSessionIdsRef.current.add(clearedId)');
    const addAt = clear.indexOf('discardedSessionIdsRef.current.add(clearedId)');
    const removeAt = clear.indexOf('repo.remove(clearedId)');
    expect(addAt).toBeGreaterThan(-1);
    expect(removeAt).toBeGreaterThan(addAt);
  });

  it('runPrompt persist path uses decideDetachPersist (epoch + discarded)', () => {
    const runStart = host.indexOf('const runPrompt = useCallback');
    const run = host.slice(runStart, host.indexOf('useEffect(() => {', runStart));
    expect(run).toContain('decideDetachPersist(');
    expect(run).toContain('discardedSessionIdsRef.current.has(startedId)');
    expect(run).toContain("action === 'preserve'");
    expect(run).toContain("action === 'drop'");
    // Late mid-turn patches must take the same gate (not raw persist).
    // Adversarial #870: paintQuota=false so a quota Error row cannot steal
    // the live last ring row from livePaintToolRun / growAssistant. A
    // still-running post-turn persist also skips paint (hot resume attach).
    expect(run).toContain('onSessionPatch: (s) => persistTurn(s, false)');
    expect(run).toContain("persistTurn(folded, folded.turnStatus !== 'running')");
    expect(run).toContain("persistTurn(reconciled, reconciled.turnStatus !== 'running')");
  });

  it('preserve + finally mint-bind first-turn UUID (adversarial #844)', () => {
    const runStart = host.indexOf('const runPrompt = useCallback');
    const run = host.slice(runStart, host.indexOf('useEffect(() => {', runStart));
    expect(run).toContain('const repo = repoRef.current');
    expect(run).toContain('putPreservedTurn(repo, foldedSnapshot, startedId, pendingMintId)');
    expect(run).toContain('shouldApplyMintBind(');
    expect(run).toContain('pendingMintBindRef.current');
    expect(run).toContain('switchInFlightRef.current');
    // persistTurn preserve + finally mint-bind must use the captured repo, not
    // repoRef.current (unmount nulls the ref before the abort microtask).
    const persistTurn = run.slice(
      run.indexOf('const persistTurn ='),
      run.indexOf('setBusy(true)'),
    );
    expect(persistTurn).toContain('putPreservedTurn(repo,');
    expect(persistTurn).not.toContain('repoRef.current');
    // Pin ?s= only on live completion — not after detach/unmount.
    const bind = run.slice(run.indexOf('const pendingId = pendingMintBindRef.current'));
    expect(bind).toContain('shouldApplyMintBind(');
    expect(bind).toContain('writeLocalSession(bound)');
    expect(bind).toContain('repo?.put(pendingId, bound)');
    expect(bind).not.toContain('repoRef.current?.put');
    expect(bind).toContain('if (!detached)');
    const pin = bind.slice(bind.indexOf('if (!detached)'));
    expect(pin).toContain('setUrlSessionId(pendingId)');
    expect(pin).toContain('setActiveSessionId(pendingId)');
    // Detached bind must not fall through to setUrl (would rewrite /settings).
    const detachedBind = bind.slice(0, bind.indexOf('if (!detached)'));
    expect(detachedBind).not.toContain('setUrlSessionId(pendingId)');
  });

  it('runPrompt skips ember hostNote on same-tab running detach (adversarial #853)', () => {
    const runStart = host.indexOf('const runPrompt = useCallback');
    const run = host.slice(runStart, host.indexOf('useEffect(() => {', runStart));
    expect(run).toContain('shouldSetHostTurnNote(persisted.turnStatus)');
    expect(run).not.toMatch(/if \(!result\.ok\) \{\s*setHostNote\(result\.error\);/);
  });

  it('poll Stop wires the G22 server cancel (plan #816)', () => {
    const poll = host.slice(
      host.indexOf('const poll = () =>'),
      host.indexOf('pollRef.current = window.setTimeout(poll, 150)'),
    );
    // Cancel POST fires through the turnApi client + the pre/post fold planner.
    expect(poll).toContain('cancelTurn(');
    expect(poll).toContain('decideStopFoldPre(');
    expect(poll).toContain('decideStopFoldPost(');
    expect(poll).toContain('shouldSkipCancelPost(');
    expect(poll).toContain('applyStopFoldToSession(');
    expect(poll).toContain('cancelPostedRunIdsRef');
    expect(poll).toContain('pendingStopFoldRef');
    // A repeat Stop after 'cancelling' never re-POSTs; a terminal/gone ack
    // clears the id + folds completed (orphan-unstick); a failed ack keeps
    // running + paints a soft note (never a fake cancel). Failed ack MUST
    // persist running (adversarial-review #927) so Stop can retry.
    expect(poll).toContain("fold.kind === 'clear-terminal'");
    expect(poll).toContain("fold.kind === 'keep-running'");
    expect(poll).toContain('setHostNote(');
    expect(poll).toContain('persist(applyStopFoldToSession(');
    expect(poll).toContain('cancelPostedRunIdsRef.current.delete');
    // Adversarial-review #927: late ack must not persist onto a new runPrompt.
    expect(poll).toContain('if (inflightRef.current) return');
  });

  it('runPrompt nulls pendingStopFoldRef so a leftover fold cannot ride the next persistTurn (adversarial-review #927)', () => {
    const runStart = host.indexOf('const runPrompt = useCallback');
    const run = host.slice(runStart, host.indexOf('useEffect(() => {', runStart));
    expect(run).toContain('pendingStopFoldRef.current = null');
  });

  it('persistTurn applies pendingStopFold so harnessChat cannot beat a failed ack (adversarial-review #927)', () => {
    expect(host).toContain('pendingStopFoldRef.current');
    expect(host).toContain('applyStopFoldToSession(snapshot, pendingFold.runId, pendingFold.fold)');
  });
});

describe('shouldSetHostTurnNote (adversarial #853 same-tab detach)', () => {
  it('running (EOF / D18 persist) does not surface host error chrome', () => {
    expect(shouldSetHostTurnNote('running')).toBe(false);
  });

  it('completed / cancelling / unset still surface the note', () => {
    expect(shouldSetHostTurnNote('completed')).toBe(true);
    expect(shouldSetHostTurnNote('cancelling')).toBe(true);
    expect(shouldSetHostTurnNote(undefined)).toBe(true);
  });
});

describe('G22 Stop/Esc server-cancel fold planner (plan #816)', () => {
  describe('decideStopFoldPre', () => {
    it('live durable run (turnRunId + running) → cancelling (route to server cancel)', () => {
      expect(
        decideStopFoldPre({ turnRunId: 'wr_live', turnStatus: 'running' }),
      ).toEqual({ kind: 'cancelling' });
    });

    it('no run id (legacy /api/agent path) → legacy-clear', () => {
      expect(decideStopFoldPre({ turnStatus: 'running' })).toEqual({
        kind: 'legacy-clear',
      });
      expect(decideStopFoldPre({})).toEqual({ kind: 'legacy-clear' });
    });

    it('run id but not running (cancelling / completed / idle) → legacy-clear', () => {
      // 'cancelling' is handled by shouldSkipCancelPost upstream (no re-POST);
      // a pre-fold here means the run is not in the live-running state.
      expect(
        decideStopFoldPre({ turnRunId: 'wr_1', turnStatus: 'cancelling' }),
      ).toEqual({ kind: 'legacy-clear' });
      expect(
        decideStopFoldPre({ turnRunId: 'wr_1', turnStatus: 'completed' }),
      ).toEqual({ kind: 'legacy-clear' });
      expect(decideStopFoldPre({ turnRunId: 'wr_1', turnStatus: 'idle' })).toEqual({
        kind: 'legacy-clear',
      });
    });
  });

  describe('decideStopFoldPost', () => {
    const pre = { kind: 'cancelling' as const };

    it('accepted → cancelling (KEEP turnRunId, fold cancelling)', () => {
      expect(decideStopFoldPost({ pre, outcome: { kind: 'accepted' } })).toEqual({
        kind: 'cancelling',
      });
    });

    it('terminal (409) → clear-terminal (orphan-unstick: clear id + completed)', () => {
      expect(decideStopFoldPost({ pre, outcome: { kind: 'terminal' } })).toEqual({
        kind: 'clear-terminal',
      });
    });

    it('gone (404) → clear-terminal (orphan-unstick)', () => {
      expect(decideStopFoldPost({ pre, outcome: { kind: 'gone' } })).toEqual({
        kind: 'clear-terminal',
      });
    });

    it('failed (429/5xx/network) → keep-running (never a fake cancel)', () => {
      expect(decideStopFoldPost({ pre, outcome: { kind: 'failed' } })).toEqual({
        kind: 'keep-running',
      });
    });

    it('legacy-clear pre never reaches the outcome mapping', () => {
      expect(
        decideStopFoldPost({
          pre: { kind: 'legacy-clear' },
          outcome: { kind: 'accepted' },
        }),
      ).toEqual({ kind: 'legacy-clear' });
      expect(
        decideStopFoldPost({
          pre: { kind: 'legacy-clear' },
          outcome: { kind: 'failed' },
        }),
      ).toEqual({ kind: 'legacy-clear' });
    });
  });

  describe('shouldSkipCancelPost', () => {
    it('cancelling + run id → true (a second Stop never re-POSTs)', () => {
      expect(
        shouldSkipCancelPost({ turnRunId: 'wr_live', turnStatus: 'cancelling' }),
      ).toBe(true);
    });

    it('running / no id / terminal → false', () => {
      expect(
        shouldSkipCancelPost({ turnRunId: 'wr_live', turnStatus: 'running' }),
      ).toBe(false);
      expect(shouldSkipCancelPost({ turnStatus: 'cancelling' })).toBe(false);
      expect(
        shouldSkipCancelPost({ turnRunId: 'wr_1', turnStatus: 'completed' }),
      ).toBe(false);
      expect(shouldSkipCancelPost({})).toBe(false);
    });
  });

  describe('applyStopFoldToSession (adversarial-review #927)', () => {
    const live = { turnRunId: 'wr_live', turnStatus: 'cancelling' as const };

    it('cancelling keeps the id and folds cancelling', () => {
      expect(
        applyStopFoldToSession(
          { turnRunId: 'wr_live', turnStatus: 'running' as const },
          'wr_live',
          { kind: 'cancelling' },
        ),
      ).toEqual({ turnRunId: 'wr_live', turnStatus: 'cancelling' });
    });

    it('keep-running reverts optimistic cancelling so Stop can retry', () => {
      expect(
        applyStopFoldToSession(live, 'wr_live', { kind: 'keep-running' }),
      ).toEqual({ turnRunId: 'wr_live', turnStatus: 'running' });
    });

    it('clear-terminal drops the id and folds completed', () => {
      expect(
        applyStopFoldToSession(live, 'wr_live', { kind: 'clear-terminal' }),
      ).toEqual({ turnRunId: undefined, turnStatus: 'completed' });
    });

    it('never clobbers a newer run id', () => {
      expect(
        applyStopFoldToSession(
          { turnRunId: 'wr_newer', turnStatus: 'running' as const },
          'wr_live',
          { kind: 'keep-running' },
        ),
      ).toEqual({ turnRunId: 'wr_newer', turnStatus: 'running' });
    });

    it('never plants a cleared id (adversarial-review #927)', () => {
      const cleared = { turnRunId: undefined, turnStatus: 'completed' as const };
      expect(
        applyStopFoldToSession(cleared, 'wr_live', { kind: 'keep-running' }),
      ).toEqual(cleared);
      expect(
        applyStopFoldToSession(cleared, 'wr_live', { kind: 'cancelling' }),
      ).toEqual(cleared);
      expect(
        applyStopFoldToSession(cleared, 'wr_live', { kind: 'clear-terminal' }),
      ).toEqual(cleared);
    });

    it('legacy-clear is a no-op on the snapshot', () => {
      expect(applyStopFoldToSession(live, 'wr_live', { kind: 'legacy-clear' })).toEqual(
        live,
      );
    });
  });
});

