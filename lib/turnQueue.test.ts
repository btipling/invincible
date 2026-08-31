/**
 * backend-agents F21 (plan #815) — persisted submit-queue mirror helpers.
 * Pure unit rows: sanitize/append/remove/restore-head semantics + the
 * reload re-arm (stub bridge, mirrors the lib/harnessChat.test.ts stub).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TURN_QUEUE_DRAIN_MAX_ATTEMPTS,
  TURN_QUEUE_MAX_ITEMS,
  TURN_QUEUE_TEXT_MAX_CHARS,
  lastUserContent,
  mergeQueues,
  queueAppend,
  queueClear,
  queueHydratePlan,
  queueOf,
  queueRestoreHead,
  queueWithoutText,
  queueTextFromUserContent,
  rearmQueueFromMirror,
  removeQueuedText,
  sanitizeQueue,
} from './turnQueue';
import { createEmptySession, formatPromptWithHistory, makeMessage, type SessionSnapshot } from './sessionStore';
import type { HarnessBridge } from './harnessBridge';
import { HARNESS_QUEUE_MAX_ITEMS } from './harnessChat';

function sess(partial: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { ...createEmptySession(), ...partial };
}

/** Minimal queue-surface stub (matches the lib/harnessChat.test.ts pattern). */
function stubBridge(opts?: { queued?: number; insertOk?: boolean }) {
  const inserts: string[] = [];
  let queued = opts?.queued ?? 0;
  const bridge = {
    queuedCount: () => queued,
    queuedInsertFront: (text: string) => {
      inserts.push(text);
      const ok = opts?.insertOk ?? true;
      if (ok) queued += 1;
      return ok;
    },
  } as unknown as HarnessBridge;
  return { bridge, inserts, queuedNow: () => queued };
}

describe('sanitizeQueue (F21)', () => {
  it('drops non-string items from an array; undefined for non-arrays', () => {
    expect(sanitizeQueue(undefined)).toBeUndefined();
    expect(sanitizeQueue('nope')).toBeUndefined();
    expect(sanitizeQueue({ 0: 'a' })).toBeUndefined();
    expect(sanitizeQueue(['a', 42, 'b'])).toEqual(['a', 'b']);
  });

  it('trims items and drops blanks', () => {
    expect(sanitizeQueue(['  hello  ', '   ', ''])).toEqual(['hello']);
  });

  it('drops over-cap items (fail-closed, never truncates a prompt)', () => {
    const big = 'x'.repeat(TURN_QUEUE_TEXT_MAX_CHARS + 1);
    const ok = 'y'.repeat(TURN_QUEUE_TEXT_MAX_CHARS);
    expect(sanitizeQueue([big, ok])).toEqual([ok]);
  });

  it('caps depth at TURN_QUEUE_MAX_ITEMS (Wasm MAX_ITEMS parity)', () => {
    const items = Array.from(
      { length: TURN_QUEUE_MAX_ITEMS + 5 },
      (_, i) => `p${i}`,
    );
    const out = sanitizeQueue(items);
    expect(out).toHaveLength(TURN_QUEUE_MAX_ITEMS);
    expect(out?.[0]).toBe('p0');
  });
});

describe('queueAppend / queueOf (F21)', () => {
  it('queueOf: empty array reads as unset', () => {
    expect(queueOf(sess())).toBeUndefined();
    expect(queueOf(sess({ queue: [] }))).toBeUndefined();
    expect(queueOf(sess({ queue: [' a '] }))).toEqual(['a']);
  });

  it('queueAppend appends ordered items (duplicates legal — one removal per accepted start)', () => {
    let s = sess();
    s = queueAppend(s, 'first');
    s = queueAppend(s, '  second  ');
    expect(s.queue).toEqual(['first', 'second']);
    s = queueAppend(s, 'first');
    expect(s.queue).toEqual(['first', 'second', 'first']);
  });

  it('queueAppend no-ops on blank/over-cap text and at depth cap', () => {
    let s = sess();
    expect(queueAppend(s, '   ')).toBe(s);
    expect(queueAppend(s, 'x'.repeat(TURN_QUEUE_TEXT_MAX_CHARS + 1))).toBe(s);
    for (let i = 0; i < TURN_QUEUE_MAX_ITEMS; i++) {
      s = queueAppend(s, `p${i}`);
    }
    expect(queueAppend(s, 'one more')).toBe(s);
    expect(s.queue).toHaveLength(TURN_QUEUE_MAX_ITEMS);
  });

  it('queueAppend bumps updatedAt', () => {
    const next = queueAppend(sess({ updatedAt: 1 }), 'hello');
    expect(next.updatedAt).toBeGreaterThan(1);
  });
});

describe('queueWithoutText (F21 adversarial #901 HEAD)', () => {
  it('removes the FIRST matching copy; empty result is unset', () => {
    expect(queueWithoutText(['a', 'b', 'a'], 'a')).toEqual(['b', 'a']);
    expect(queueWithoutText(['only'], 'only')).toBeUndefined();
  });

  it('no-ops (same reference) on blank / absent / missing carrier', () => {
    const q = ['a'];
    expect(queueWithoutText(q, '')).toBe(q);
    expect(queueWithoutText(q, 'zzz')).toBe(q);
    expect(queueWithoutText(undefined, 'a')).toBeUndefined();
  });
});

describe('queueTextFromUserContent (F21 adversarial #901 fold unwrap)', () => {
  it('passes a bare prompt through (no history)', () => {
    expect(queueTextFromUserContent('follow-up B')).toBe('follow-up B');
    expect(queueTextFromUserContent('  hello  ')).toBe('hello');
  });

  it('unwraps the last User line of a formatPromptWithHistory fold', () => {
    const folded = formatPromptWithHistory(
      [makeMessage('user', 'turn-1 user'), makeMessage('assistant', 'turn-1 assistant')],
      'follow-up B',
    );
    expect(folded).toContain('User: turn-1 user');
    expect(folded).not.toBe('follow-up B');
    expect(queueTextFromUserContent(folded)).toBe('follow-up B');
  });

  it('does not treat an earlier User line as this-run', () => {
    const folded = formatPromptWithHistory(
      [makeMessage('user', 'follow-up C'), makeMessage('assistant', 'ok')],
      'follow-up B',
    );
    expect(queueTextFromUserContent(folded)).toBe('follow-up B');
  });
});

describe('mergeQueues (F21 adversarial #901 adopt)', () => {
  it('keeps a local queueAppend the worker head omitted', () => {
    expect(mergeQueues(undefined, ['follow-up B'], 'turn-1 user')).toEqual([
      'follow-up B',
    ]);
  });

  it('strips an in-flight last user from a stale-long server queue (fold unwrap)', () => {
    const folded = formatPromptWithHistory(
      [makeMessage('user', 'turn-1 user'), makeMessage('assistant', 'turn-1 assistant')],
      'follow-up B',
    );
    expect(
      mergeQueues(['follow-up B', 'follow-up C'], ['follow-up C'], folded),
    ).toEqual(['follow-up C']);
  });

  it('union appends local extras after server order; empty union is unset', () => {
    expect(mergeQueues(['a'], ['a', 'b'])).toEqual(['a', 'b']);
    expect(mergeQueues(undefined, undefined)).toBeUndefined();
    expect(mergeQueues(['only'], ['only'], 'only')).toBeUndefined();
  });

  it('lastUserContent is the TAIL user (reconstructed history), not the first', () => {
    expect(
      lastUserContent([
        { role: 'user', text: 'turn-1' },
        { role: 'assistant', text: 'ok' },
        { role: 'user', text: 'follow-up B' },
      ]),
    ).toBe('follow-up B');
    expect(lastUserContent([])).toBeUndefined();
  });

  it('TURN_QUEUE_MAX_ITEMS tracks HARNESS_QUEUE_MAX_ITEMS (Wasm MAX_ITEMS pin)', () => {
    expect(TURN_QUEUE_MAX_ITEMS).toBe(HARNESS_QUEUE_MAX_ITEMS);
  });
});

describe('removeQueuedText / queueRestoreHead (F21)', () => {
  it('removes the FIRST matching copy only', () => {
    let s = sess({ queue: ['a', 'b', 'a'] });
    s = removeQueuedText(s, 'a');
    expect(s.queue).toEqual(['b', 'a']);
  });

  it('deletes the carrier when the last item is removed (absent = unset, no [] noise)', () => {
    let s = sess({ queue: ['only'] });
    s = removeQueuedText(s, 'only');
    expect('queue' in s).toBe(false);
  });

  it('no-ops on blank text / absent match / missing carrier (same object out)', () => {
    const s = sess({ queue: ['a'] });
    expect(removeQueuedText(s, '')).toBe(s);
    expect(removeQueuedText(s, 'zzz')).toBe(s);
    const bare = sess();
    expect(removeQueuedText(bare, 'a')).toBe(bare);
  });

  it('restore-head puts the text at the FRONT and re-inserts an absent text', () => {
    let s = sess({ queue: ['a', 'b', 'c'] });
    s = queueRestoreHead(s, 'a');
    expect(s.queue).toEqual(['a', 'b', 'c']);
    s = queueRestoreHead(s, 'z');
    expect(s.queue).toEqual(['z', 'a', 'b', 'c']);
    expect(queueRestoreHead(s, '   ')).toBe(s);
    expect(
      queueRestoreHead(s, 'x'.repeat(TURN_QUEUE_TEXT_MAX_CHARS + 1)),
    ).toBe(s);
  });

  it('restore-head refuses at depth cap (fail-closed, never drops a sibling)', () => {
    let s = sess();
    for (let i = 0; i < TURN_QUEUE_MAX_ITEMS; i++) s = queueAppend(s, `p${i}`);
    const before = s.queue;
    expect(queueRestoreHead(s, 'new head')).toBe(s);
    expect(s.queue).toEqual(before);
  });
});

describe('queueClear (F21)', () => {
  it('drops the whole mirror; absent stays untouched (same object)', () => {
    const s = queueClear(sess({ queue: ['a', 'b'] }));
    expect('queue' in s).toBe(false);
    const bare = sess();
    expect(queueClear(bare)).toBe(bare);
  });
});

describe('rearmQueueFromMirror (F21 reload hydration)', () => {
  it('inserts in REVERSE order so queuedInsertFront rebuilds the FIFO', () => {
    const { bridge, inserts } = stubBridge();
    const s = sess({ queue: ['one', 'two', 'three'] });
    const n = rearmQueueFromMirror(bridge, s);
    expect(n).toBe(3);
    expect(inserts).toEqual(['three', 'two', 'one']);
  });

  it('skips entirely when the Wasm queue is non-empty (never double-enqueues)', () => {
    const { bridge, inserts } = stubBridge({ queued: 1 });
    const n = rearmQueueFromMirror(bridge, sess({ queue: ['a'] }));
    expect(n).toBe(0);
    expect(inserts).toEqual([]);
  });

  it('no-ops on an empty/absent mirror', () => {
    const { bridge, inserts } = stubBridge();
    expect(rearmQueueFromMirror(bridge, sess())).toBe(0);
    expect(rearmQueueFromMirror(bridge, sess({ queue: [] }))).toBe(0);
    expect(inserts).toEqual([]);
  });

  it('stops on an insert reject (fail-closed: the rest stay in the mirror)', () => {
    const { bridge, inserts } = stubBridge({ insertOk: false });
    const s = sess({ queue: ['a', 'b', 'c'] });
    const n = rearmQueueFromMirror(bridge, s);
    expect(n).toBe(0);
    expect(inserts).toEqual(['c']);
    expect(s.queue).toEqual(['a', 'b', 'c']); // mirror untouched
  });

  it('re-arms with a fresh budget available (drain cap exported and generous)', () => {
    expect(TURN_QUEUE_DRAIN_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });
});

describe('queueHydratePlan (F21 adversarial #901 HEAD)', () => {
  it('cold: wipe FIFO then re-arm from the mirror', () => {
    expect(queueHydratePlan('cold')).toEqual({ preserveQueue: false, rearm: true });
  });

  it('live: keep FIFO and never re-arm (just-promoted head is still in the mirror)', () => {
    expect(queueHydratePlan('live')).toEqual({ preserveQueue: true, rearm: false });
  });
});

describe('HarnessHost F21 wiring source-lock (adversarial #901)', () => {
  const host = readFileSync(
    resolve(process.cwd(), 'app/harness/HarnessHost.tsx'),
    'utf8',
  );
  const harnessChat = readFileSync(
    resolve(process.cwd(), 'lib/harnessChat.ts'),
    'utf8',
  );

  it('strips a drained prompt from the mirror BEFORE runHarnessTurn (not after the terminal)', () => {
    const start = host.indexOf('await runHarnessTurn(');
    expect(start).toBeGreaterThan(0);
    const before = host.slice(0, start);
    const after = host.slice(start);
    expect(before).toContain('drainingQueued');
    expect(before).toContain('removeQueuedText(');
    expect(before).toContain('queueOf(');
    // Give-up / restore may mention removeQueuedText only before the call.
    expect(after.indexOf('removeQueuedText(')).toBe(-1);
    expect(after).toContain('queueRestoreHead(');
    expect(after).toContain('drainingQueued');
  });

  it('give-up Error is appendMessage\'d onto the snapshot (F5 is not silent)', () => {
    const start = host.indexOf('await runHarnessTurn(');
    const after = host.slice(start);
    expect(after).toContain("appendMessage(reconciled, 'error'");
  });

  it('empty-prompt cold attach preserves the FIFO (kickColdAttach must not wipe a re-arm)', () => {
    expect(harnessChat).toMatch(/const preserveQueue = attaching;/);
    expect(harnessChat).not.toMatch(
      /preserveQueue = attaching && \(rawPrompt/,
    );
  });

  it('Load-earlier and needSnap hydrates are live (no re-arm of a just-promoted head)', () => {
    // Both live ring snaps pass kind 'live' so queueHydratePlan skips re-arm.
    expect(host).toContain("hydrateRingWindow(b, session, nextStart, 'live')");
    expect(host).toContain(
      "hydrateRingWindow(b, sessionRef.current, latest, 'live')",
    );
    expect(host).toContain('queueHydratePlan(kind)');
    expect(host).toContain('if (plan.rearm)');
    // Cold sites stay default-cold (3-arg / explicit default), not 'live'.
    expect(host).toContain(
      'hydrateRingWindow(bridge, merged, latestRingStart(merged.messages.length))',
    );
    expect(host).toContain(
      'hydrateRingWindow(bridge, restored, latestRingStart(restored.messages.length))',
    );
  });
});
