import { describe, expect, it } from 'vitest';
import { encodeToolRun, addToolStart, addToolResult, createToolRunGroup } from './toolRun';
import { appendMessage, createEmptySession, makeMessage } from './sessionStore';
import {
  bumpStreamCursor,
  decideAttachClass,
  shouldSkipToolResult,
  shouldSkipToolStart,
  skillAlreadyHydrated,
  textDeltaDedup,
  thisRunAssistantText,
  thisRunToolItems,
  thisRunWindow,
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
