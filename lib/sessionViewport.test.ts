import { describe, expect, it } from 'vitest';
import { byteLength, fitViewportRows, parseViewportCarriers, parseViewportEvent, parseViewportRow, viewportCarriers, viewportExcerpt, ViewportReducer } from './sessionViewport';
import { HARNESS_SESSION_MAX_MSG_BYTES, VIEWPORT_RESPONSE_MAX_BYTES } from './sessionCloudCaps';
import { decodeToolRun } from './toolRun';

describe('bounded disposable viewport', () => {
  it('keeps the newest UTF-8 excerpt within the existing bridge rail', () => {
    const text = '漢🙂'.repeat(100000) + ' latest';
    const excerpt = viewportExcerpt(text);
    expect(excerpt.startsWith('[Earlier text omitted]')).toBe(true);
    expect(excerpt.endsWith(' latest')).toBe(true);
    expect(excerpt).not.toContain('\ufffd');
    expect(byteLength(excerpt)).toBeLessThanOrEqual(HARNESS_SESSION_MAX_MSG_BYTES);
    expect(viewportExcerpt('small')).toBe('small');
  });
  it('fits complete escaped JSON including scaffold and keeps newest rows without mutation', () => {
    const rows = Array.from({ length: 2048 }, (_, i) => ({ id: `row_${i}`, role: 'assistant' as const,
      text: '\u0001"漢'.repeat(500), at: i }));
    const scaffold = { rows: [], source: 'stored_head', carriers: { queue: ['"'.repeat(5000)] } };
    const kept = fitViewportRows(rows, scaffold);
    expect(byteLength(JSON.stringify({ ...scaffold, rows: kept }))).toBeLessThanOrEqual(VIEWPORT_RESPONSE_MAX_BYTES);
    expect(kept.at(-1)?.id).toBe('row_2047');
    expect(kept.length).toBeLessThan(rows.length);
    expect(rows).toHaveLength(2048);
  });
  it('rejects invalid rows and excludes arbitrary meta, keys and model bodies', () => {
    expect(parseViewportRow({ role: 'reasoning', text: 'secret reasoning' }, 0)).toBeUndefined();
    expect(parseViewportRow({ role: 'assistant', text: 123 }, 0)).toBeUndefined();
    const carriers = viewportCarriers({ logicalCwd: 'src', selectedModel: 'test/model', workingNotes: 'private notes',
      personaSnapshot: 'persona body', compactionPointer: 'private', randomSecret: 'key',
      turnRunId: 'run_1', activeSandboxId: '*', usage: 'bad-json' }, ['next']);
    expect(carriers.cwd).toBe('src');
    expect(carriers.queue).toEqual(['next']);
    expect(JSON.stringify(carriers)).not.toMatch(/private|persona body|randomSecret/);
    expect(carriers.activeSandboxId).toBeUndefined();
    const encoded = parseViewportCarriers({
      cwd: carriers.cwd, selectedModel: 'test/model', queue: ['next'],
      workingNotes: 'private notes', personaSnapshot: 'persona body',
      cwdHost: '/etc/passwd',
    });
    expect(encoded).toMatchObject({ cwd: 'src', selectedModel: 'test/model', queue: ['next'] });
    expect(JSON.stringify(encoded)).not.toMatch(/private|persona body|\/etc/);
    expect(parseViewportCarriers({ cwd: '/etc/passwd', workingNotes: 'secret' }).cwd).toBeUndefined();
    expect(JSON.stringify(parseViewportCarriers({ cwd: '/etc/passwd', workingNotes: 'secret' }))).not.toContain('secret');
  });
  it('parses one stored frame, ignores unknown fields, rejects multiple/malformed frames', () => {
    expect(parseViewportEvent('data: {"type":"text_delta","text":"hi","secret":"hidden"}\r\n\r\n'))
      .toEqual({ type: 'text_delta', text: 'hi' });
    expect(parseViewportEvent('data: nope\n\n')).toBeUndefined();
    expect(parseViewportEvent('data: {"type":"new_unrecognized"}\n\n')).toBeUndefined();
    expect(parseViewportEvent('data: {"type":"text_delta","text":"a"}\n\ndata: {"type":"text_delta","text":"b"}\n\n')).toBeUndefined();
    expect(parseViewportEvent('data: {"type":"skill_attached","slug":"test","action":"attach","ok":true}\n\n')?.type).toBe('skill_attached');
  });
  it('never retains historical thinking or appends aggregate done over text', () => {
    const reducer = new ViewportReducer();
    reducer.apply({ type: 'reasoning_delta', text: 'historical thinking' });
    reducer.apply({ type: 'text_delta', text: 'a ' });
    reducer.apply({ type: 'text_delta', text: 'b' });
    reducer.apply({ type: 'done', text: 'earlier a b' });
    expect(reducer.snapshot().map(r => r.text)).toEqual(['a b']);
    expect(JSON.stringify(reducer)).not.toContain('historical thinking');
    const across = new ViewportReducer();
    across.apply({ type: 'text_delta', text: 'Hello' });
    across.apply({ type: 'reasoning_delta', text: 'hidden thinking' });
    across.apply({ type: 'text_delta', text: ' world' });
    expect(across.snapshot().map(r => r.text)).toEqual(['Hello world']);
    expect(JSON.stringify(across)).not.toContain('hidden thinking');
  });
  it('pairs tool ids within the visible group but does not name-pair an unrelated result', () => {
    const reducer = new ViewportReducer();
    reducer.apply({ type: 'tool_start', name: 'read', id: 'a' });
    reducer.apply({ type: 'tool_start', name: 'read', id: 'b' });
    reducer.apply({ type: 'tool_result', name: 'read', id: 'b', ok: true, summary: 'result b' });
    const group = decodeToolRun(reducer.snapshot()[0].text)!;
    expect(group.pending).toBe(1); expect(group.ok).toBe(1);
    reducer.apply({ type: 'tool_result', name: 'read', id: 'unknown', ok: true, summary: 'orphan' });
    expect(reducer.snapshot()).toHaveLength(2);
    expect(decodeToolRun(reducer.snapshot()[1].text)?.ok).toBe(1);
  });
  it('rolls groups and retains bounded state for very long text and many rows', () => {
    const reducer = new ViewportReducer();
    for (let i = 0; i < 2500; i++) {
      reducer.apply({ type: 'text_delta', text: 'x'.repeat(1024) });
      reducer.apply({ type: 'error', error: `err${i}` });
    }
    expect(reducer.snapshot().length).toBeLessThanOrEqual(2048);
    expect(byteLength(JSON.stringify(reducer.snapshot()))).toBeLessThanOrEqual(VIEWPORT_RESPONSE_MAX_BYTES + 2);
    const last = new ViewportReducer();
    last.apply({ type: 'done', text: 'x'.repeat(400000) + 'newest' });
    expect(last.snapshot()[0].text.endsWith('newest')).toBe(true);
  });
});
