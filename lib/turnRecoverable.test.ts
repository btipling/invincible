import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyTurnFailure } from './harnessChat';
import {
  AUTO_CONTINUE_PER_GIVE_UP,
  AUTO_CONTINUE_PROMPT,
  isRecoverableBookkeepingError,
  migrateAutoContinueFlag,
  shouldAutoContinueAfterGiveUp,
  type AutoContinueGiveUpInput,
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
    // Belt-and-suspenders: POST /api/turns does not put this in result.error
    // (tenant fail / attach 503 use different copy — see `no` rows).
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
    // Production turn-path copies — intentionally not needles (D18 / C15).
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
  const base: AutoContinueGiveUpInput = {
    resultOk: false,
    kind: 'error',
    error: recoverable,
    turnStatus: 'completed',
    inflight: false,
    queuedCount: 0,
    hasPendingSubmit: false,
    didAutoContinue: false,
    repostFollowUp: false,
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

  it('repostFollowUp (send-while-running remapped re-POST) wins', () => {
    expect(shouldAutoContinueAfterGiveUp({ ...base, repostFollowUp: true })).toBe(false);
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

/**
 * Host compose: `classifyTurnFailure(...).kind` then `shouldAutoContinueAfterGiveUp`.
 * Locks the pair the host actually runs (adversarial-review #890 Minor L6).
 */
describe('host compose: classifyTurnFailure + shouldAutoContinueAfterGiveUp', () => {
  const idle = {
    resultOk: false as const,
    turnStatus: 'completed' as const,
    inflight: false,
    queuedCount: 0,
    hasPendingSubmit: false,
    didAutoContinue: false,
    repostFollowUp: false,
  };

  function hostWouldAutoContinue(
    error: string,
    status?: number,
    extra: Partial<AutoContinueGiveUpInput> = {},
  ): boolean {
    const kind = classifyTurnFailure(error, status).kind;
    return shouldAutoContinueAfterGiveUp({
      ...idle,
      kind,
      error,
      ...extra,
    });
  }

  it('persist copy + 503 → kind error → auto-continue', () => {
    const error = 'transcript segment write failed: blob 503';
    expect(classifyTurnFailure(error, 503).kind).toBe('error');
    expect(hostWouldAutoContinue(error, 503)).toBe(true);
  });

  it('object byte ceiling + no status → kind error → auto-continue', () => {
    const error = 'transcript segment exceeds the object byte ceiling (oversize)';
    expect(classifyTurnFailure(error).kind).toBe('error');
    expect(hostWouldAutoContinue(error)).toBe(true);
  });

  it('sessions error field → kind error → auto-continue (belt-and-suspenders)', () => {
    expect(hostWouldAutoContinue('session store unavailable', 503)).toBe(true);
  });

  it('turns-route tenant 503 is error-kind but not recoverable', () => {
    const error = 'Unable to resolve tenant for the durable turn.';
    expect(classifyTurnFailure(error, 503).kind).toBe('error');
    expect(hostWouldAutoContinue(error, 503)).toBe(false);
  });

  it('attach 503 is error-kind but not recoverable (and running would skip anyway)', () => {
    const error = 'Unable to attach to run stream (store unavailable).';
    expect(classifyTurnFailure(error, 503).kind).toBe('error');
    expect(hostWouldAutoContinue(error, 503)).toBe(false);
    expect(hostWouldAutoContinue(error, 503, { turnStatus: 'running' })).toBe(false);
  });

  it('504 timeout kind skips even if the body contained a needle', () => {
    expect(classifyTurnFailure('transcript segment write failed', 504).kind).toBe(
      'timeout',
    );
    expect(hostWouldAutoContinue('transcript segment write failed', 504)).toBe(false);
  });

  it('content-filter SSE error is error-kind but not recoverable', () => {
    expect(classifyTurnFailure('content filtered').kind).toBe('error');
    expect(hostWouldAutoContinue('content filtered')).toBe(false);
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
        repostFollowUp: false,
      }),
    ).toBe(false);
  });
});

describe('HarnessHost auto-continue wiring source-lock (plan #887)', () => {
  const host = readFileSync(resolve(process.cwd(), 'app/harness/HarnessHost.tsx'), 'utf8');

  it('fires shouldAutoContinueAfterGiveUp with host classifyTurnFailure compose + repostFollowUp', () => {
    expect(host).toMatch(
      /shouldAutoContinueAfterGiveUp\(\{[\s\S]*?classifyTurnFailure\(result\.error, result\.status, controller\.signal\)\.kind[\s\S]*?repostFollowUp,/,
    );
    expect(host).toContain('didAutoContinueBySessionRef');
    expect(host).toContain('AUTO_CONTINUE_PROMPT');
    expect(host).toContain('skipUserAppend: true');
    expect(host).toContain('autoContinue: true');
    expect(host).toContain('pushUser: false');
    expect(host).toContain('didAutoContinueBySessionRef.current.delete');
    expect(host).toContain('migrateAutoContinueFlag(');
  });

  it('auto-continue is a new runPrompt of continue (not attach, not same-POST retry)', () => {
    expect(host).toMatch(
      /runPromptRef\.current\(AUTO_CONTINUE_PROMPT,\s*\{[\s\S]*?skipUserAppend: true,[\s\S]*?autoContinue: true,/,
    );
    expect(host).toContain('skipUserAppend: opts?.skipUserAppend');
  });
});
