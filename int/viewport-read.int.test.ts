import { describe, expect, it, vi } from 'vitest';
import { loadBridge } from './loadBridge';
import { ringTexts } from './driver';
import { MessageKind, Lifecycle } from '../lib/harnessBridge';
import { MemoryBlobTranscriptStore } from '../lib/sessions/blobStores';
import { newBlobObjectId } from '../lib/sessions/blobStore';
import { readViewportHead } from '../lib/sessions/viewportRead';
import { createViewportRunReader, type ViewportRun } from '../lib/workflows/viewportRunReader';
import { viewportStream } from '../lib/agent/viewportStream';
import { ViewportStreamDecoder } from '../lib/viewportStreamProtocol';
import { VIEWPORT_HISTORY_NOTE } from '../lib/sessionViewport';

const scope = { tenantId: 'int_tenant', userId: 'int_user', sessionId: 'int_session' };
const line = (event: object) => `data: ${JSON.stringify(event)}\n\n`;

describe('bounded recovery → protocol → real Wasm display (backend foundation)', () => {
  it('one-head/late-tail recovery never paints historical thinking; subsequent live text/thinking survives', async () => {
    const bridge = await loadBridge();
    bridge.pushMessage(MessageKind.Assistant, 'cached tail must not rewind to prompt');
    const blob = new MemoryBlobTranscriptStore(), pointer = newBlobObjectId(scope), prev = newBlobObjectId(scope);
    await blob.writeSegment({ objectId: pointer, maxBytes: 8 * 1024 * 1024,
      content: JSON.stringify({ id: scope.sessionId, prev, messages: [{ role: 'assistant', text: 'older head' }] }) });
    const read = vi.spyOn(blob, 'read'), write = vi.spyOn(blob, 'writeSegment');
    const opens: number[] = [];
    const H0 = 100000, H = H0 + 7;
    let probes = 0;
    const run: ViewportRun = { status: 'running', getReadable(opts) {
      const start = opts?.startIndex ?? 0; opens.push(start);
      let i = start;
      return Object.assign(new ReadableStream<string>({ pull(c) {
        if (start === -1) return; // public tail metadata handle, cancelled by adapter
        if (start < H0) {
          if (i >= H0) { c.close(); return; }
          c.enqueue(line(i++ === H0 - 1 ? { type: 'text_delta', text: 'most recent sampled assistant' }
            : { type: 'reasoning_delta', text: 'HISTORICAL_THINKING_MUST_NOT_PAINT' }));
        } else {
          const events = [
            { type: 'reasoning_delta', text: 'new live thinking' },
            { type: 'text_delta', text: 'new live assistant' },
            { type: 'done', text: 'aggregate (not appended by int consumer)' },
          ];
          if (i - H >= events.length) { c.close(); return; }
          c.enqueue(line(events[i++ - H]));
        }
      } }), { getTailIndex: async () => (probes++ === 0 ? H0 : H) - 1 });
    } };
    // Same composition as GET hydrate=tail: startIndex 0, H0 captured inside viewportStream.
    const stream = viewportStream({ runId: 'run', sessionId: scope.sessionId, run: createViewportRunReader(run), startIndex: 0,
      cold: { status: 'cancelling', readHead: deadline => readViewportHead({ scope, meta: { transcriptPointer: pointer }, blob, deadline }) } });
    const parser = new ViewportStreamDecoder('run'), reader = stream.getReader();
    let sawSnapshot = false, nextIndex = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      for (const record of parser.push(value)) {
        if (record.type === 'viewport_state') {
          bridge.setLifecycle(Lifecycle.Busy);
          expect(ringTexts(bridge)).toContain('cached tail must not rewind to prompt');
        } else if (record.type === 'viewport_snapshot') {
          sawSnapshot = true;
          if (record.resumeIndex !== undefined) nextIndex = record.resumeIndex;
          expect(record.gap).toBe(true); expect(record.historyComplete).toBe(false);
          if (record.replace) bridge.hydrateMessages(record.rows.map(row => ({
            kind: row.role === 'assistant' ? MessageKind.Assistant : row.role === 'tool_run' ? MessageKind.ToolRun : MessageKind.System,
            text: row.text,
          })));
          expect(ringTexts(bridge)).toContain('most recent sampled assistant');
          expect(ringTexts(bridge)).toContain(VIEWPORT_HISTORY_NOTE);
        } else if (record.type === 'turn_event') {
          expect(record.nextIndex).toBe(nextIndex + 1); nextIndex = record.nextIndex;
          if (record.event?.type === 'reasoning_delta') bridge.pushMessage(MessageKind.Thinking, record.event.text);
          if (record.event?.type === 'text_delta') bridge.pushMessage(MessageKind.Assistant, record.event.text);
        }
        expect(ringTexts(bridge).join('\n')).not.toContain('HISTORICAL_THINKING');
        expect(bridge.messageCount()).toBeLessThanOrEqual(2048);
      }
    }
    parser.push(new Uint8Array(), true);
    expect(sawSnapshot).toBe(true); expect(nextIndex).toBe(H + 3);
    expect(ringTexts(bridge)).toContain('new live thinking');
    expect(ringTexts(bridge)).toContain('new live assistant');
    expect(opens).toContain(H0 - 2048); expect(opens).toContain(H); expect(opens).not.toContain(0);
    expect(read).toHaveBeenCalledExactlyOnceWith(pointer); expect(write).not.toHaveBeenCalled();
  });

  it('head-only fallback paints the latest real ring without reading its ancestors', async () => {
    const bridge = await loadBridge(), blob = new MemoryBlobTranscriptStore(), pointer = newBlobObjectId(scope);
    await blob.writeSegment({ objectId: pointer, maxBytes: 8 * 1024 * 1024, content: JSON.stringify({ id: scope.sessionId,
      prev: newBlobObjectId(scope), messages: Array.from({ length: 3000 }, (_, i) => ({ role: 'assistant', text: `row-${i}` })) }) });
    const read = vi.spyOn(blob, 'read');
    const view = await readViewportHead({ scope, meta: { transcriptPointer: pointer }, blob });
    bridge.hydrateMessages(view.rows.map(r => ({ kind: MessageKind.Assistant, text: r.text })));
    expect(bridge.messageCount()).toBe(2048); expect(ringTexts(bridge).at(-1)).toBe('row-2999');
    expect(view.historyComplete).toBe(false); expect(view.hasEarlier).toBe(true); expect(read).toHaveBeenCalledOnce();
  });
});
