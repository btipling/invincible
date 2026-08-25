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
 * Plus the source-lock that counts `decideDetach`-wired detach sites vs raw
 * `abort()` call sites in `HarnessHost.tsx`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  abortReasonFor,
  decideDetach,
  decideDetachPersist,
  DETACH_ABORT_REASON,
  isDetachAbort,
  shouldAbortReader,
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

describe('HarnessHost detach wiring source-lock (plan #812 D18)', () => {
  const host = readFileSync(resolve(process.cwd(), 'app/harness/HarnessHost.tsx'), 'utf8');
  const module = readFileSync(resolve(process.cwd(), 'lib/detachTurn.ts'), 'utf8');

  it('decideDetach + shouldAbortReader exist in lib/detachTurn.ts', () => {
    expect(module).toContain('export function decideDetach');
    expect(module).toContain('export function shouldAbortReader');
    expect(module).toContain('export function abortReasonFor');
    expect(module).toContain('export function decideDetachPersist');
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
    expect(poll).not.toContain('decideDetach');
    expect(poll).not.toContain('abortReasonFor');
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
    expect(run).toContain('onSessionPatch: persistTurn');
  });
});
