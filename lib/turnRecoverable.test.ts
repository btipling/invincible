import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTO_CONTINUE_PER_GIVE_UP,
  AUTO_CONTINUE_PROMPT,
  isRecoverableBookkeepingError,
  shouldAutoContinueAfterGiveUp,
} from './turnRecoverable';

describe('isRecoverableBookkeepingError', () => {
  const yes = [
    'transcript segment write failed: blob 503',
    'Transcript Segment Write Failed',
    'transcript segment exceeds the object byte ceiling (oversize)',
    'OBJECT BYTE CEILING',
    'SESSION_STORE_UNAVAILABLE',
    '503 SESSION_STORE_UNAVAILABLE — redis down',
  ];
  const no = [
    'oversize',
    'payload oversize',
    'content filtered',
    'output truncated',
    'model error',
    'Request cancelled.',
    'step budget exhausted',
    'Turn ended · you stopped',
    'validation: empty prompt',
    '',
  ];

  for (const s of yes) {
    it(`recoverable: ${JSON.stringify(s)}`, () => {
      expect(isRecoverableBookkeepingError(s)).toBe(true);
    });
  }
  for (const s of no) {
    it(`not recoverable: ${JSON.stringify(s)}`, () => {
      expect(isRecoverableBookkeepingError(s)).toBe(false);
    });
  }
});

describe('shouldAutoContinueAfterGiveUp', () => {
  const recoverable = 'transcript segment write failed: blob 503';
  const base = {
    resultOk: false,
    kind: 'error' as const,
    error: recoverable,
    turnStatus: 'completed' as const,
    inflight: false,
    queuedCount: 0,
    hasPendingSubmit: false,
    didAutoContinue: false,
  };

  it('give-up recoverable + empty queue → true (one continue)', () => {
    expect(shouldAutoContinueAfterGiveUp(base)).toBe(true);
  });

  it('queuedCount>0 → no auto POST', () => {
    expect(shouldAutoContinueAfterGiveUp({ ...base, queuedCount: 1 })).toBe(false);
  });

  it('hasPendingSubmit → no auto POST', () => {
    expect(shouldAutoContinueAfterGiveUp({ ...base, hasPendingSubmit: true })).toBe(false);
  });

  it('inflight → no auto POST', () => {
    expect(shouldAutoContinueAfterGiveUp({ ...base, inflight: true })).toBe(false);
  });

  it('second recoverable (flag set) → no third POST', () => {
    expect(shouldAutoContinueAfterGiveUp({ ...base, didAutoContinue: true })).toBe(false);
  });

  it("turnStatus:'running' → no POST", () => {
    expect(shouldAutoContinueAfterGiveUp({ ...base, turnStatus: 'running' })).toBe(false);
  });

  it('success is never auto-continue', () => {
    expect(shouldAutoContinueAfterGiveUp({ ...base, resultOk: true })).toBe(false);
  });

  it('Stop / detach / timeout / empty / validation never auto-continue', () => {
    for (const kind of ['stop', 'detach', 'timeout', 'empty', 'validation'] as const) {
      expect(shouldAutoContinueAfterGiveUp({ ...base, kind })).toBe(false);
    }
  });

  it('content filtered is error-kind but not recoverable', () => {
    expect(
      shouldAutoContinueAfterGiveUp({ ...base, error: 'content filtered' }),
    ).toBe(false);
  });

  it('bare oversize is not recoverable', () => {
    expect(shouldAutoContinueAfterGiveUp({ ...base, error: 'oversize' })).toBe(false);
  });

  it('cap is one per give-up', () => {
    expect(AUTO_CONTINUE_PER_GIVE_UP).toBe(1);
    expect(AUTO_CONTINUE_PROMPT).toBe('continue');
  });
});

describe('HarnessHost auto-continue wiring source-lock (plan #887)', () => {
  const host = readFileSync(resolve(process.cwd(), 'app/harness/HarnessHost.tsx'), 'utf8');

  it('calls shouldAutoContinueAfterGiveUp + one continue with skipUserAppend', () => {
    expect(host).toContain('shouldAutoContinueAfterGiveUp(');
    expect(host).toContain('classifyTurnFailure(');
    expect(host).toContain('didAutoContinueBySessionRef');
    expect(host).toContain('AUTO_CONTINUE_PROMPT');
    expect(host).toContain('skipUserAppend: true');
    expect(host).toContain('autoContinue: true');
    expect(host).toContain('pushUser: false');
    expect(host).toContain('didAutoContinueBySessionRef.current.delete');
  });

  it('does not implement #849 detach-on-EOF and does not same-POST retry', () => {
    expect(host).not.toContain('same-POST');
    expect(host).toContain('skipUserAppend: opts?.skipUserAppend');
  });
});
