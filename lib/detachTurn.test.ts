/**
 * Plan #812 (backend-agents D18) — unit + source-lock tests for `decideDetach`.
 *
 * Rows (locked contract):
 *   - durable run present (turnRunId + turnStatus running/cancelling) → `detach`
 *   - idle / no run id → `noop`
 *   - in-flight turn, no durable run id → `detach-close`
 *   - Stop / Esc → `cancel`
 * Plus the source-lock that counts `decideDetach`-wired detach sites vs raw
 * `abort()` call sites in `HarnessHost.tsx` (re-derived per review note — the
 * parent's "4+3=7" had to be reconciled against the 6 live abort sites).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideDetach, shouldAbortReader, type DetachTurnInput } from './detachTurn';

function input(over: Partial<DetachTurnInput> = {}): DetachTurnInput {
  return { cancel: false, inflight: false, ...over };
}

describe('decideDetach (plan #812 D18 contract)', () => {
  it('Stop / Esc → cancel (never routed through detach)', () => {
    // Even with a durable run present, a real cancel wins.
    expect(
      decideDetach(
        input({
          cancel: true,
          inflight: true,
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

  it('durable run present + running → detach (preserve id/status, no abort)', () => {
    const d = decideDetach(
      input({ inflight: true, turnRunId: 'run_abc', turnStatus: 'running' }),
    );
    expect(d).toBe('detach');
    expect(shouldAbortReader(d)).toBe(false);
  });

  it('durable run present + cancelling → detach (preserve id/status, no abort)', () => {
    const d = decideDetach(
      input({ inflight: true, turnRunId: 'run_abc', turnStatus: 'cancelling' }),
    );
    expect(d).toBe('detach');
    expect(shouldAbortReader(d)).toBe(false);
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
    // Legacy /api/agent path — no turnRunId carrier, but still in-flight.
    expect(
      decideDetach(input({ inflight: true, turnStatus: 'running' })),
    ).toBe('detach-close');
  });

  it('shouldAbortReader: only detach-close and cancel close the reader', () => {
    expect(shouldAbortReader('detach')).toBe(false);
    expect(shouldAbortReader('detach-close')).toBe(true);
    expect(shouldAbortReader('noop')).toBe(false);
    expect(shouldAbortReader('cancel')).toBe(true);
  });
});

describe('HarnessHost detach wiring source-lock (plan #812 D18)', () => {
  const host = readFileSync(resolve(process.cwd(), 'app/harness/HarnessHost.tsx'), 'utf8');
  const module = readFileSync(resolve(process.cwd(), 'lib/detachTurn.ts'), 'utf8');

  it('decideDetach + shouldAbortReader exist in lib/detachTurn.ts', () => {
    expect(module).toContain('export function decideDetach');
    expect(module).toContain('export function shouldAbortReader');
  });

  it('host wires 4 detach sites through decideDetach and never the Stop/Esc path', () => {
    // Re-derived per review note: the 4 detach sites (unmount cleanup, onClear,
    // onNewSession, onSwitchSession) each call the host `detachTurn()` helper
    // (which consults decideDetach); the two real-abort paths (runPrompt
    // supersede + poll Stop) stay raw `abort()`.
    const detachCalls = host.match(/detachTurn\(\)/g) ?? [];
    expect(detachCalls.length).toBe(4);

    // The detach helper must check shouldAbortReader before aborting, so a
    // durable detach never rides the abort-ref stop fold.
    const helper = host.slice(
      host.indexOf('const detachTurn = useCallback'),
      host.indexOf('onSwitchSessionRef.current = onSwitchSession'),
    );
    expect(helper).toContain('decideDetach(');
    expect(helper).toContain('shouldAbortReader(');
    expect(helper).toContain('abortRef.current?.abort()');
  });

  it('raw abort() sites are exactly the 3 aborts (2 cancel/raw + 1 in the detach helper)', () => {
    // Reconciles the parent "4 detach / 3 abort" against the 6 live
    // `abortRef.current?.abort()` sites: 4 became detachTurn() calls, leaving
    // runPrompt supersede + poll Stop + the helper's own abort = 3 raw.
    const aborts = host.match(/abortRef\.current\?\.abort\(\)/g) ?? [];
    expect(aborts.length).toBe(3);
    // No empty/loose abort without the helper decision.
    expect(host).not.toMatch(/(detachTurn\(\)[^;]*;)\s*\n\s*abortRef\.current/);
  });

  it('the poll Stop path (takePendingCancel) is still a raw cancel, not detach', () => {
    const poll = host.slice(host.indexOf('const poll = () =>'), host.indexOf('pollRef.current = window.setTimeout(poll, 150)'));
    expect(poll).toContain('takePendingCancel()');
    expect(poll).toContain('abortRef.current?.abort()');
    expect(poll).not.toContain('decideDetach');
  });
});
