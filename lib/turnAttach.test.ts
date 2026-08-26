import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeToolRun, addToolStart, addToolResult, createToolRunGroup } from './toolRun';
import { appendMessage, createEmptySession, makeMessage } from './sessionStore';
import {
  bumpStreamCursor,
  decideAttachClass,
  decideHotResume,
  decideSendAttach,
  isAttachRunGone,
  lastUserText,
  prefixThroughLastUser,
  shouldSkipToolResult,
  shouldSkipToolStart,
  skillAlreadyHydrated,
  textDeltaDedup,
  thisRunAssistantText,
  thisRunToolItems,
  thisRunWindow,
  withoutTrailingFollowUpUser,
} from './turnAttach';
import { TURN_STREAM_CURSOR_MAX } from './sessionCloudCaps';

describe('decideAttachClass', () => {
  it('none when not running / no run id', () => {
    expect(
      decideAttachClass({
        turnStatus: 'completed',
        turnRunId: 'wr_1',
        heapApplied: { runId: 'wr_1', count: 3 },
      }),
    ).toEqual({ kind: 'none' });
    expect(
      decideAttachClass({
        turnStatus: 'running',
        heapApplied: null,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('F5 / boot (no heap applied) is cold at 0 even when envelope C is large', () => {
    expect(
      decideAttachClass({
        turnRunId: 'wr_1',
        turnStatus: 'running',
        envelopeCursor: 4096,
        heapApplied: null,
      }),
    ).toEqual({ kind: 'cold', startIndex: 0 });
  });

  it('poison/absent envelope C while running is still cold when heap is empty', () => {
    expect(
      decideAttachClass({
        turnRunId: 'wr_1',
        turnStatus: 'running',
        envelopeCursor: undefined,
        heapApplied: null,
      }),
    ).toEqual({ kind: 'cold', startIndex: 0 });
  });

  it('C=0 with same-heap applied 0 is hot resume (not poison)', () => {
    expect(
      decideAttachClass({
        turnRunId: 'wr_1',
        turnStatus: 'running',
        envelopeCursor: 0,
        heapApplied: { runId: 'wr_1', count: 0 },
      }),
    ).toEqual({ kind: 'hot', startIndex: 0 });
  });

  it('hot resume uses heap-applied count, not envelope C', () => {
    expect(
      decideAttachClass({
        turnRunId: 'wr_1',
        turnStatus: 'running',
        envelopeCursor: 12,
        heapApplied: { runId: 'wr_1', count: 7 },
      }),
    ).toEqual({ kind: 'hot', startIndex: 7 });
  });

  it('same-heap hot resume ignores envelope C (other-tab LWW must not skip reconnect)', () => {
    expect(
      decideAttachClass({
        turnRunId: 'wr_1',
        turnStatus: 'running',
        envelopeCursor: 80,
        heapApplied: { runId: 'wr_1', count: 4 },
      }),
    ).toEqual({ kind: 'hot', startIndex: 4 });
  });

  it('a different run id on the heap is cold (switch-back)', () => {
    expect(
      decideAttachClass({
        turnRunId: 'wr_new',
        turnStatus: 'running',
        envelopeCursor: 2,
        heapApplied: { runId: 'wr_old', count: 9 },
      }),
    ).toEqual({ kind: 'cold', startIndex: 0 });
  });
});

describe('isAttachRunGone (adversarial #857)', () => {
  it('only 404 is run-gone; 503/401/5xx/network stay subscribe-fail', () => {
    expect(isAttachRunGone(404)).toBe(true);
    expect(isAttachRunGone(503)).toBe(false);
    expect(isAttachRunGone(401)).toBe(false);
    expect(isAttachRunGone(400)).toBe(false);
    expect(isAttachRunGone(500)).toBe(false);
    expect(isAttachRunGone(undefined)).toBe(false);
  });
});

describe('decideHotResume (adversarial #857 host glue)', () => {
  const live = {
    turnRunId: 'wr_1',
    turnStatus: 'running' as const,
    envelopeCursor: 12,
  };

  it('POST drop (no attachStart) hot-resumes at heap C', () => {
    expect(
      decideHotResume({
        ...live,
        heapApplied: { runId: 'wr_1', count: 5 },
      }),
    ).toEqual({ kind: 'hot', startIndex: 5 });
  });

  it('empty-EOF GET (applied == attachStart) does not reconnect', () => {
    expect(
      decideHotResume({
        ...live,
        heapApplied: { runId: 'wr_1', count: 5 },
        attachStart: 5,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('GET that applied frames past attachStart hot-resumes', () => {
    expect(
      decideHotResume({
        ...live,
        heapApplied: { runId: 'wr_1', count: 8 },
        attachStart: 5,
      }),
    ).toEqual({ kind: 'hot', startIndex: 8 });
  });

  it('cold heap / completed fold do not hot-resume', () => {
    expect(
      decideHotResume({
        ...live,
        heapApplied: null,
        attachStart: undefined,
      }),
    ).toEqual({ kind: 'none' });
    expect(
      decideHotResume({
        turnRunId: 'wr_1',
        turnStatus: 'completed',
        heapApplied: { runId: 'wr_1', count: 5 },
      }),
    ).toEqual({ kind: 'none' });
  });
});

describe('HarnessHost attach wiring source-lock (plan #813 / adversarial #857)', () => {
  const host = readFileSync(resolve(process.cwd(), 'app/harness/HarnessHost.tsx'), 'utf8');

  it('boot / adopt / activateSession kick cold attach at startIndex=0 + dedup', () => {
    expect(host).toContain('const kickColdAttach = useCallback');
    expect(host.match(/queueMicrotask\(kickColdAttach\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(host).toContain('startIndex: 0, dedup: true');
    expect(host).toContain('if (inflightRef.current) return');
  });

  it('hot resume uses decideHotResume (empty-EOF does not spin inline)', () => {
    expect(host).toContain('decideHotResume(');
    expect(host).not.toContain('const progressed =');
    expect(host).toContain('dedup: false');
  });

  it('Send while running uses decideSendAttach (never POST / C15 409)', () => {
    expect(host).toContain(
      'Adversarial #857: Send while a durable run is live',
    );
    expect(host).toContain('decideSendAttach(');
    expect(host).toContain('heapApplied: heapAppliedRef.current');
  });

  it('detachTurn clears inflight so switch can cold-attach', () => {
    const helper = host.slice(
      host.indexOf('const detachTurn = useCallback'),
      host.indexOf('const runPrompt = useCallback'),
    );
    expect(helper).toContain('inflightRef.current = false');
  });
});

describe('decideSendAttach (adversarial #857 Send-while-running)', () => {
  const live = {
    turnRunId: 'wr_1',
    turnStatus: 'running' as const,
    envelopeCursor: 12,
  };

  it('heap null / count 0 is cold at 0 + dedup (Blob-shaped, not hot-at-0)', () => {
    expect(decideSendAttach({ ...live, heapApplied: null })).toEqual({
      kind: 'cold',
      runId: 'wr_1',
      startIndex: 0,
      dedup: true,
    });
    expect(
      decideSendAttach({ ...live, heapApplied: { runId: 'wr_1', count: 0 } }),
    ).toEqual({
      kind: 'cold',
      runId: 'wr_1',
      startIndex: 0,
      dedup: true,
    });
  });

  it('heap already applied frames is hot at C without dedup', () => {
    expect(
      decideSendAttach({ ...live, heapApplied: { runId: 'wr_1', count: 7 } }),
    ).toEqual({
      kind: 'hot',
      runId: 'wr_1',
      startIndex: 7,
      dedup: false,
    });
  });

  it('different run / not running → none or cold', () => {
    expect(
      decideSendAttach({
        ...live,
        turnRunId: 'wr_new',
        heapApplied: { runId: 'wr_old', count: 9 },
      }),
    ).toEqual({
      kind: 'cold',
      runId: 'wr_new',
      startIndex: 0,
      dedup: true,
    });
    expect(
      decideSendAttach({
        turnRunId: 'wr_1',
        turnStatus: 'completed',
        heapApplied: { runId: 'wr_1', count: 5 },
      }),
    ).toEqual({ kind: 'none' });
  });
});

describe('withoutTrailingFollowUpUser', () => {
  const isUser = (r: { role: string }) => r.role === 'user';

  it('drops a follow-up user that is not the session last user', () => {
    const rows = [
      { role: 'user', text: 'hello' },
      { role: 'user', text: 'follow-up' },
    ];
    expect(withoutTrailingFollowUpUser(rows, isUser, 'hello')).toEqual([
      { role: 'user', text: 'hello' },
    ]);
  });

  it('drops a duplicate follow-up with the same text as the originating user', () => {
    const rows = [
      { role: 'user', text: 'hello' },
      { role: 'thinking', text: 'hmm' },
      { role: 'user', text: 'hello' },
    ];
    expect(withoutTrailingFollowUpUser(rows, isUser, 'hello')).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'thinking', text: 'hmm' },
    ]);
  });

  it('keeps the originating last-user when it is the tail', () => {
    const rows = [{ role: 'user', text: 'hello' }];
    expect(withoutTrailingFollowUpUser(rows, isUser, 'hello')).toEqual(rows);
  });

  it('keeps a non-user tail (hot resume live ring)', () => {
    const rows = [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'Hello' },
    ];
    expect(withoutTrailingFollowUpUser(rows, isUser, 'hello')).toEqual(rows);
  });

  it('lastUserText returns the last user row', () => {
    expect(lastUserText([])).toBeUndefined();
    expect(
      lastUserText([
        { role: 'user', text: 'a' },
        { role: 'assistant', text: 'b' },
        { role: 'user', text: 'c' },
      ]),
    ).toBe('c');
  });
});

describe('thisRunWindow / assistant text', () => {
  it('scopes after the last user row — prior-turn assistant is not in the window', () => {
    let s = createEmptySession();
    s = appendMessage(s, 'user', 'first');
    s = appendMessage(s, 'assistant', 'OLD');
    s = appendMessage(s, 'user', 'second');
    s = appendMessage(s, 'assistant', 'NEW');
    const w = thisRunWindow(s.messages);
    expect(w.map((m) => m.role + ':' + m.text)).toEqual(['assistant:NEW']);
    expect(thisRunAssistantText(s.messages)).toBe('NEW');
  });

  it('prefixThroughLastUser keeps prior turns + this prompt, drops this-run suffix', () => {
    let s = createEmptySession();
    s = appendMessage(s, 'user', 'first');
    s = appendMessage(s, 'assistant', 'OLD');
    s = appendMessage(s, 'user', 'second');
    s = appendMessage(s, 'tool_run', '1 tool');
    s = appendMessage(s, 'assistant', 'NEW');
    expect(prefixThroughLastUser(s.messages).map((m) => m.role + ':' + m.text)).toEqual([
      'user:first',
      'assistant:OLD',
      'user:second',
    ]);
  });
});

describe('textDeltaDedup', () => {
  it('disabled → always grow the chunk', () => {
    expect(
      textDeltaDedup({
        enabled: false,
        hydratedAssistant: 'Hello',
        replayedBefore: '',
        chunk: 'He',
      }),
    ).toEqual({ action: 'grow', chunk: 'He' });
  });

  it('prefix of hydrated this-run assistant → skip (no double-grow)', () => {
    expect(
      textDeltaDedup({
        enabled: true,
        hydratedAssistant: 'Hello world',
        replayedBefore: '',
        chunk: 'Hello',
      }),
    ).toEqual({ action: 'skip' });
    expect(
      textDeltaDedup({
        enabled: true,
        hydratedAssistant: 'Hello world',
        replayedBefore: 'Hello',
        chunk: ' world',
      }),
    ).toEqual({ action: 'skip' });
  });

  it('extends hydrated text → grow only the suffix', () => {
    expect(
      textDeltaDedup({
        enabled: true,
        hydratedAssistant: 'Hello',
        replayedBefore: 'Hello',
        chunk: ' world',
      }),
    ).toEqual({ action: 'grow-suffix', chunk: ' world' });
  });

  it('no this-run assistant → grow (unpersisted live text)', () => {
    expect(
      textDeltaDedup({
        enabled: true,
        hydratedAssistant: '',
        replayedBefore: '',
        chunk: 'live',
      }),
    ).toEqual({ action: 'grow', chunk: 'live' });
  });
});

describe('tool ordinal skip', () => {
  it('skips start/result when the hydrated card already has a terminal item', () => {
    const g = createToolRunGroup();
    addToolStart(g, 'read_file');
    addToolResult(g, 'read_file', true, 'ok', undefined);
    const payload = encodeToolRun(g);
    expect(payload).toBeTruthy();
    let s = createEmptySession();
    s = appendMessage(s, 'user', 'read it');
    s = {
      ...s,
      messages: [...s.messages, makeMessage('tool_run', payload!)],
    };
    const hydrated = thisRunToolItems(s.messages);
    expect(hydrated).toEqual([{ name: 'read_file', status: 'ok' }]);
    expect(
      shouldSkipToolStart({
        enabled: true,
        hydrated,
        name: 'read_file',
        replayedStartsOfName: 1,
      }),
    ).toBe(true);
    expect(
      shouldSkipToolResult({
        enabled: true,
        hydrated,
        name: 'read_file',
        replayedResultsOfName: 1,
      }),
    ).toBe(true);
  });

  it('does not skip a live suffix tool that hydrate does not have', () => {
    expect(
      shouldSkipToolStart({
        enabled: true,
        hydrated: [{ name: 'read_file', status: 'ok' }],
        name: 'exec',
        replayedStartsOfName: 1,
      }),
    ).toBe(false);
  });

  it('running hydrated card still grows on tool_result', () => {
    expect(
      shouldSkipToolResult({
        enabled: true,
        hydrated: [{ name: 'exec', status: 'running' }],
        name: 'exec',
        replayedResultsOfName: 1,
      }),
    ).toBe(false);
  });
});

describe('skillAlreadyHydrated', () => {
  it('skips a replayed skill row already in the this-run window', () => {
    let s = createEmptySession();
    s = appendMessage(s, 'user', 'go');
    s = appendMessage(s, 'skill_attached', 'Skill attached: foo');
    expect(
      skillAlreadyHydrated(s.messages, {
        type: 'skill_attached',
        action: 'attach',
        slug: 'foo',
        ok: true,
      }),
    ).toBe(true);
    expect(
      skillAlreadyHydrated(s.messages, {
        type: 'skill_attached',
        action: 'attach',
        slug: 'bar',
        ok: true,
      }),
    ).toBe(false);
  });
});

describe('bumpStreamCursor', () => {
  it('increments and stays at the A3 max (does not drop-to-unset)', () => {
    expect(bumpStreamCursor(0)).toBe(1);
    expect(bumpStreamCursor(TURN_STREAM_CURSOR_MAX)).toBe(TURN_STREAM_CURSOR_MAX);
  });
});
