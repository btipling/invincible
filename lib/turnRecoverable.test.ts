import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTO_CONTINUE_PER_GIVE_UP,
  AUTO_CONTINUE_PROMPT,
  isRecoverableBookkeepingError,
  migrateAutoContinueFlag,
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
    // Production `unavailableResponse` / `failureFromJson` copies `error`, not `code`.
    'session store unavailable',
    'Session Store Unavailable',
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
    // Attach 503 (D18 keep-running) — not the sessions `error` field.
    'Unable to attach to run stream (store unavailable).',
    'Unable to resolve tenant for the durable turn.',
    'Unable to start durable turn (fail closed): boom',
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

  it('production sessions error field is recoverable', () => {
    expect(
      shouldAutoContinueAfterGiveUp({ ...base, error: 'session store unavailable' }),
    ).toBe(true);
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

describe('migrateAutoContinueFlag (mint-bind cap 1)', () => {
  it('moves the bit sess_* → UUID', () => {
    const flags = new Map<string, boolean>([['sess_local', true]]);
    migrateAutoContinueFlag(flags, 'sess_local', 'uuid-mint');
    expect(flags.get('sess_local')).toBeUndefined();
    expect(flags.get('uuid-mint')).toBe(true);
  });

  it('same id is a no-op', () => {
    const flags = new Map<string, boolean>([['id', true]]);
    migrateAutoContinueFlag(flags, 'id', 'id');
    expect([...flags.entries()]).toEqual([['id', true]]);
  });

  it('unset source does not stamp the destination', () => {
    const flags = new Map<string, boolean>();
    migrateAutoContinueFlag(flags, 'sess_local', 'uuid-mint');
    expect(flags.size).toBe(0);
  });

  it('after migrate, a UUID give-up is still one-shot', () => {
    const flags = new Map<string, boolean>([['sess_local', true]]);
    migrateAutoContinueFlag(flags, 'sess_local', 'uuid-mint');
    expect(
      shouldAutoContinueAfterGiveUp({
        resultOk: false,
        kind: 'error',
        error: 'session store unavailable',
        turnStatus: 'completed',
        inflight: false,
        queuedCount: 0,
        hasPendingSubmit: false,
        didAutoContinue: flags.get('uuid-mint') === true,
      }),
    ).toBe(false);
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
    expect(host).toContain('migrateAutoContinueFlag(');
  });

  it('does not implement #849 detach-on-EOF and does not same-POST retry', () => {
    expect(host).not.toContain('same-POST');
    expect(host).toContain('skipUserAppend: opts?.skipUserAppend');
  });
});
