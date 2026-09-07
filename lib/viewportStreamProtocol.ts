/** Versioned viewport records. Synthetic lifecycle controls never occupy a stored cursor. */
import type { AgentStreamEvent } from './agent/agentStream';
import { HARNESS_SESSION_MAX_MSG_BYTES, VIEWPORT_RESPONSE_MAX_BYTES, sanitizeTurnRunId, sanitizeTurnStreamCursor } from './sessionCloudCaps';
import { HARNESS_RING_MAX } from './sessionWindow';
import { byteLength, objectRecord, parseViewportRow, parseViewportCarriers, validateViewportEvent, type ViewportView } from './sessionViewport';

export type ViewportSnapshot = ViewportView & {
  runId: string; resumeIndex?: number; sampledRange: { start: number; end: number };
};
export type ViewportRecord =
  | { type: 'viewport_state'; version: 1; runId: string; status: string; phase: 'recovering' }
  | ({ type: 'viewport_snapshot' } & ViewportSnapshot)
  | { type: 'turn_event'; version: 1; runId: string; nextIndex: number; event: AgentStreamEvent; skipped?: never }
  | { type: 'turn_event'; version: 1; runId: string; nextIndex: number; skipped: true; event?: never }
  | { type: 'viewport_end'; version: 1; runId: string; status: string }
  | { type: 'viewport_error'; version: 1; runId: string; code: string };

export function encodeViewportRecord(record: ViewportRecord): Uint8Array {
  const { type, ...data } = record;
  return new TextEncoder().encode(`event: ${type}\n${type === 'turn_event' ? `id: ${record.nextIndex}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}

export type ViewportMode = { kind: 'legacy' } | { kind: 'cold' } | { kind: 'indexed'; startIndex: number };
export function parseViewportMode(url: URL, method: 'GET' | 'POST'): ViewportMode | null {
  const q = url.searchParams;
  if (!q.has('viewportVersion')) return q.has('hydrate') ? null : { kind: 'legacy' };
  if (['viewportVersion', 'hydrate', 'startIndex', 'sessionId'].some(k => q.getAll(k).length > 1) || q.get('viewportVersion') !== '1') return null;
  if (method === 'POST') return q.has('hydrate') || q.has('startIndex') ? null : { kind: 'indexed', startIndex: 0 };
  if (q.has('hydrate')) return q.get('hydrate') === 'tail' && !q.has('startIndex') ? { kind: 'cold' } : null;
  // GET v1 must pick hydrate=tail (bounded recovery) or an explicit startIndex.
  // Omitting both is not origin replay — that was the #924 class this path exists to avoid.
  if (!q.has('startIndex')) return null;
  const raw = q.get('startIndex');
  const index = raw !== null && /^(0|[1-9]\d*)$/.test(raw) ? sanitizeTurnStreamCursor(Number(raw)) : undefined;
  return index === undefined ? null : { kind: 'indexed', startIndex: index };
}

/** Incremental UTF-8/SSE decoder; unknown or inconsistent positions are not guessed. */
export class ViewportStreamDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = '';
  private nextIndex: number | undefined;
  constructor(private readonly runId: string, startIndex?: number) { this.nextIndex = startIndex; }
  push(bytes: Uint8Array, final = false): ViewportRecord[] {
    this.pending += this.decoder.decode(bytes, { stream: !final });
    // Normalize complete CRLF pairs only: a trailing CR may join next network chunk.
    this.pending = this.pending.replace(/\r\n/g, '\n');
    const out: ViewportRecord[] = [];
    for (;;) {
      const end = this.pending.indexOf('\n\n');
      if (end < 0) break;
      const block = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 2);
      if (!block.trim() || block.split('\n').every(l => l.startsWith(':'))) continue;
      out.push(this.parse(block));
    }
    if (final && this.pending.trim()) throw new Error('Incomplete viewport record');
    return out;
  }
  private parse(block: string): ViewportRecord {
    const fields = (name: string) => block.split('\n').filter(l => l.startsWith(`${name}:`)).map(l => l.slice(name.length + 1).trimStart());
    const types = fields('event'), ids = fields('id');
    if (types.length !== 1 || ids.length > 1) throw new Error('Invalid viewport framing');
    const o = objectRecord(JSON.parse(fields('data').join('\n')));
    if (!o || o.version !== 1 || sanitizeTurnRunId(o.runId) !== this.runId || o.runId !== this.runId) throw new Error('Invalid viewport identity');
    const type = types[0];
    if (type !== 'turn_event' && ids.length) throw new Error('Synthetic viewport index');
    if (type === 'turn_event') {
      const index = sanitizeTurnStreamCursor(o.nextIndex);
      if (index === undefined || this.nextIndex === undefined || index !== this.nextIndex + 1 || ids[0] !== String(index)) throw new Error('Invalid viewport cursor');
      const event = o.skipped === true ? undefined : validateViewportEvent(o.event);
      if (!event && o.skipped !== true) throw new Error('Invalid viewport event');
      this.nextIndex = index;
      return event ? { type, version: 1, runId: this.runId, nextIndex: index, event }
        : { type, version: 1, runId: this.runId, nextIndex: index, skipped: true };
    }
    if (type === 'viewport_snapshot') {
      const hasResume = Object.prototype.hasOwnProperty.call(o, 'resumeIndex');
      const index = hasResume ? sanitizeTurnStreamCursor(o.resumeIndex) : undefined;
      const range = objectRecord(o.sampledRange);
      if ((hasResume && index === undefined) || !range || sanitizeTurnStreamCursor(range.start) === undefined ||
        sanitizeTurnStreamCursor(range.end) === undefined || (range.start as number) > (range.end as number) ||
        (index !== undefined && (range.end as number) > index) ||
        typeof o.sessionId !== 'string' || !Array.isArray(o.rows) || o.rows.length > HARNESS_RING_MAX ||
        o.historyComplete !== false || o.incomplete !== true || typeof o.replace !== 'boolean' ||
        typeof o.gap !== 'boolean' || typeof o.hasEarlier !== 'boolean' ||
        !['stream_tail', 'stored_head', 'unavailable'].includes(String(o.source)) ||
        !objectRecord(o.carriers) || byteLength(block) > VIEWPORT_RESPONSE_MAX_BYTES) throw new Error('Invalid viewport snapshot');
      const rows = o.rows.map((r, i) => {
        const raw = objectRecord(r);
        const parsed = parseViewportRow(r, i);
        if (!parsed || typeof raw?.text !== 'string' || byteLength(raw.text) > HARNESS_SESSION_MAX_MSG_BYTES) throw new Error('Invalid viewport row');
        return parsed;
      });
      if (index !== undefined) {
        if (this.nextIndex !== undefined && index < this.nextIndex) throw new Error('Rewound viewport');
        this.nextIndex = index;
      }
      const start = sanitizeTurnStreamCursor(range.start)!;
      const end = sanitizeTurnStreamCursor(range.end)!;
      return {
        type,
        version: 1,
        runId: this.runId,
        sessionId: o.sessionId as string,
        rows,
        replace: o.replace as boolean,
        source: String(o.source) as ViewportView['source'],
        historyComplete: false,
        incomplete: true,
        gap: o.gap as boolean,
        hasEarlier: o.hasEarlier as boolean,
        carriers: parseViewportCarriers(o.carriers),
        sampledRange: { start, end },
        ...(index !== undefined ? { resumeIndex: index } : {}),
      };
    }
    if (type === 'viewport_state' && o.phase === 'recovering' && typeof o.status === 'string')
      return { type, version: 1, runId: this.runId, status: o.status, phase: 'recovering' };
    if (type === 'viewport_end' && ['completed', 'failed', 'cancelled'].includes(String(o.status)))
      return { type, version: 1, runId: this.runId, status: o.status as string };
    if (type === 'viewport_error' && typeof o.code === 'string')
      return { type, version: 1, runId: this.runId, code: o.code };
    throw new Error('Unknown viewport record');
  }
}
