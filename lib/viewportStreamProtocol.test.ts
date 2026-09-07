import { describe, expect, it } from 'vitest';
import { encodeViewportRecord, parseViewportMode, ViewportStreamDecoder, type ViewportRecord } from './viewportStreamProtocol';
import { emptyViewport } from './sessions/viewportRead';

const snap: ViewportRecord = { type: 'viewport_snapshot', ...emptyViewport('session'), runId: 'run', resumeIndex: 42, sampledRange: { start: 0, end: 40 } };
describe('negotiated viewport codec', () => {
  it('decodes fragmented UTF-8/CRLF and separates explicit snapshot jumps from stored indices', () => {
    const decoder = new ViewportStreamDecoder('run');
    const text = new TextDecoder().decode(encodeViewportRecord(snap)) + new TextDecoder().decode(encodeViewportRecord({ type: 'turn_event', version: 1, runId: 'run', nextIndex: 43, event: { type: 'text_delta', text: '漢🙂' } }));
    const bytes = new TextEncoder().encode(text.replace(/\n/g, '\r\n'));
    const records: ViewportRecord[] = [];
    for (const byte of bytes) records.push(...decoder.push(new Uint8Array([byte])));
    decoder.push(new Uint8Array(), true);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ nextIndex: 43, event: { text: '漢🙂' } });
  });
  it('display-only snapshot (unknown tail) does not jump the cursor to origin', () => {
    const decoder = new ViewportStreamDecoder('run');
    const { resumeIndex: _ignored, ...display } = snap;
    const rec = decoder.push(encodeViewportRecord({ ...display, type: 'viewport_snapshot' }))[0];
    expect(rec).toMatchObject({ type: 'viewport_snapshot', sampledRange: { start: 0, end: 40 } });
    expect(rec).not.toHaveProperty('resumeIndex');
    expect(() => decoder.push(encodeViewportRecord({
      type: 'turn_event', version: 1, runId: 'run', nextIndex: 1, event: { type: 'text_delta', text: 'x' },
    }))).toThrow('Invalid viewport cursor');
  });
  it('drops extra snapshot keys and re-sanitizes encoded carriers', () => {
    const decoder = new ViewportStreamDecoder('run');
    const hostile = [
      'event: viewport_snapshot',
      `data: ${JSON.stringify({
        version: 1, runId: 'run', sessionId: 'session', resumeIndex: 42,
        sampledRange: { start: 0, end: 40 }, rows: [], replace: false,
        source: 'unavailable', historyComplete: false, incomplete: true,
        gap: true, hasEarlier: false,
        carriers: { cwd: '/etc/passwd', workingNotes: 'secret notes', queue: ['next'] },
        workingNotes: 'secret notes', personaSnapshot: 'persona body',
      })}`,
      '',
      '',
    ].join('\n');
    const rec = decoder.push(new TextEncoder().encode(hostile))[0];
    expect(rec).toMatchObject({ type: 'viewport_snapshot', resumeIndex: 42, carriers: { queue: ['next'] } });
    expect(rec).not.toHaveProperty('workingNotes');
    expect(rec).not.toHaveProperty('personaSnapshot');
    expect(JSON.stringify(rec)).not.toMatch(/secret|persona body|\/etc/);
    expect((rec as { carriers: { cwd?: string } }).carriers.cwd).toBeUndefined();
  });
  it('known skipped frame advances; synthetic terminal does not need an index', () => {
    const decoder = new ViewportStreamDecoder('run', 3);
    expect(decoder.push(encodeViewportRecord({ type: 'turn_event', version: 1, runId: 'run', nextIndex: 4, skipped: true }))[0]).toMatchObject({ skipped: true });
    expect(decoder.push(encodeViewportRecord({ type: 'viewport_end', version: 1, runId: 'run', status: 'cancelled' }))[0].type).toBe('viewport_end');
  });
  it.each([
    'event: turn_event\nid: 8\ndata: {"version":1,"runId":"run","nextIndex":8,"skipped":true}\n\n',
    'event: viewport_end\nid: 4\ndata: {"version":1,"runId":"run","status":"completed"}\n\n',
    'event: viewport_end\ndata: {"version":1,"runId":"foreign","status":"completed"}\n\n',
    'event: turn_event\nid: 4\ndata: {"version":1,"runId":"run","nextIndex":4,"event":{"type":"unknown"}}\n\n',
  ])('rejects inconsistent or hostile record %s', text => {
    expect(() => new ViewportStreamDecoder('run', 3).push(new TextEncoder().encode(text))).toThrow();
  });
  it('fails closed on incomplete/malformed UTF-8 rather than guessing raw position', () => {
    expect(() => new ViewportStreamDecoder('run').push(new TextEncoder().encode('event: unfinished'), true)).toThrow();
    expect(() => new ViewportStreamDecoder('run').push(new Uint8Array([0xff]), true)).toThrow();
  });
  it('negotiates explicitly, preserves old mode, rejects duplicate/conflicting selectors', () => {
    const mode = (query: string, method: 'GET'|'POST' = 'GET') => parseViewportMode(new URL(`https://example.com/?${query}`), method);
    expect(mode('startIndex=2')).toEqual({ kind: 'legacy' });
    expect(mode('viewportVersion=1&hydrate=tail')).toEqual({ kind: 'cold' });
    expect(mode('viewportVersion=1&startIndex=42')).toEqual({ kind: 'indexed', startIndex: 42 });
    expect(mode('viewportVersion=1&startIndex=0')).toEqual({ kind: 'indexed', startIndex: 0 });
    expect(mode('viewportVersion=1', 'POST')).toEqual({ kind: 'indexed', startIndex: 0 });
    for (const query of ['hydrate=tail', 'viewportVersion=2', 'viewportVersion=1', 'viewportVersion=1&sessionId=s1', 'viewportVersion=1&viewportVersion=1', 'viewportVersion=1&hydrate=tail&startIndex=0', 'viewportVersion=1&startIndex=01', 'viewportVersion=1&startIndex=1e3', 'viewportVersion=1&startIndex=1000000001']) expect(mode(query)).toBeNull();
    expect(mode('viewportVersion=1&startIndex=1', 'POST')).toBeNull();
  });
});
