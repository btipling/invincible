/** Read-only head + bounded stream tail. No ancestry reconstruction and no writes. */
import {
  HARNESS_SESSION_MAX_BODY_BYTES, VIEWPORT_RECOVERY_MAX_MS, VIEWPORT_RECOVERY_MAX_BYTES,
  VIEWPORT_TAIL_MAX_FRAMES, VIEWPORT_FINAL_PROBE_MAX_MS, VIEWPORT_HEAD_READ_MAX_OBJECTS,
} from '../sessionCloudCaps';
import { HARNESS_RING_MAX } from '../sessionWindow';
import { isObjectIdBoundTo, type ObjectScope, type BlobTranscriptStore } from './blobStore';
import {
  byteLength, objectRecord, parseViewportRow, parseViewportEvent, fitViewportRows,
  viewportCarriers, ViewportReducer, VIEWPORT_HISTORY_NOTE, type ViewportView,
} from '../sessionViewport';
import type { SessionMessage } from '../sessionStore';
import type { ViewportSnapshot } from '../viewportStreamProtocol';
import { type ViewportRunReader, viewportWait } from '../workflows/viewportRunReader';

export function emptyViewport(sessionId: string, meta?: unknown): ViewportView {
  return { version: 1, sessionId, replace: false, rows: [], source: 'unavailable',
    historyComplete: false, incomplete: true, gap: true, hasEarlier: false, carriers: viewportCarriers(meta) };
}

export async function readViewportHead(opts: {
  scope: ObjectScope; meta: Record<string, unknown>; blob: Pick<BlobTranscriptStore, 'read'>;
  signal?: AbortSignal; deadline?: number;
}): Promise<ViewportView> {
  const fallback = emptyViewport(opts.scope.sessionId, opts.meta);
  const pointer = opts.meta.transcriptPointer;
  if (typeof pointer !== 'string' || !isObjectIdBoundTo(pointer, opts.scope) || VIEWPORT_HEAD_READ_MAX_OBJECTS < 1 || opts.signal?.aborted) return fallback;
  try {
    const deadline = opts.deadline ?? Date.now() + VIEWPORT_RECOVERY_MAX_MS;
    if (Date.now() >= deadline) return fallback;
    const raw = await viewportWait(opts.blob.read(pointer), deadline - Date.now(), opts.signal);
    if (raw === null || raw.length > HARNESS_SESSION_MAX_BODY_BYTES || byteLength(raw) > HARNESS_SESSION_MAX_BODY_BYTES || Date.now() >= deadline) return fallback;
    const body = objectRecord(JSON.parse(raw));
    if (!body || body.id !== opts.scope.sessionId || !Array.isArray(body.messages)) return fallback;
    const rows: SessionMessage[] = [];
    // Only newest candidates; no full-message mapping (including malformed histories).
    for (let i = body.messages.length - 1; i >= Math.max(0, body.messages.length - HARNESS_RING_MAX) && Date.now() < deadline; i--) {
      const row = parseViewportRow(body.messages[i], i);
      if (row) rows.push(row);
    }
    rows.reverse();
    const view: ViewportView = { ...fallback, source: rows.length ? 'stored_head' : 'unavailable',
      carriers: viewportCarriers(opts.meta, body.queue), replace: rows.length > 0, gap: false,
      hasEarlier: body.messages.length > rows.length ||
        (typeof body.prev === 'string' && isObjectIdBoundTo(body.prev, opts.scope)) };
    view.rows = fitViewportRows(rows, view);
    view.hasEarlier ||= view.rows.length < rows.length;
    view.replace = view.rows.length > 0;
    return view;
  } catch { return fallback; }
}

export async function recoverViewport(opts: {
  runId: string; sessionId: string; initialIndex: number; run: ViewportRunReader;
  readHead: (deadline: number) => Promise<ViewportView>; signal?: AbortSignal;
  /** Skip SDK sample + tail probe (cancelled/failed C16 hang class). Head-only. */
  skipStream?: boolean;
  /** Shared recovery clock (H0 + head + sample). Defaults to now + VIEWPORT_RECOVERY_MAX_MS. */
  deadline?: number;
}): Promise<ViewportSnapshot> {
  const deadline = opts.deadline ?? Date.now() + VIEWPORT_RECOVERY_MAX_MS;
  const remaining = () => Math.max(0, deadline - Date.now());
  const headPromise = viewportWait(opts.readHead(deadline), remaining(), opts.signal)
    .catch(() => emptyViewport(opts.sessionId));
  const start = Math.max(0, opts.initialIndex - VIEWPORT_TAIL_MAX_FRAMES);
  let end = start, bytes = 0, gap = opts.skipStream || start > 0;
  const reducer = new ViewportReducer();
  let reader: ReadableStreamDefaultReader<string | Uint8Array> | undefined;
  try {
    if (!opts.skipStream && start < opts.initialIndex && !opts.signal?.aborted) {
      reader = opts.run.open(start).getReader();
      while (end < opts.initialIndex && end - start < VIEWPORT_TAIL_MAX_FRAMES && Date.now() < deadline) {
        const chunk = await viewportWait(reader.read(), deadline - Date.now(), opts.signal);
        if (chunk.done) { gap = true; break; }
        const size = typeof chunk.value === 'string' ? byteLength(chunk.value) : chunk.value.byteLength;
        if (size > VIEWPORT_RECOVERY_MAX_BYTES - bytes) { gap = true; break; }
        bytes += size;
        const text = typeof chunk.value === 'string' ? chunk.value : new TextDecoder('utf-8', { fatal: true }).decode(chunk.value);
        const event = parseViewportEvent(text);
        end++;
        if (event) reducer.apply(event); else gap = true;
      }
    }
  } catch { gap = true; }
  finally { if (reader) void reader.cancel().catch(() => {}); }
  const head = await headPromise;
  if (opts.signal?.aborted) throw new Error('Viewport read aborted');
  let resumeIndex = opts.initialIndex;
  if (!opts.skipStream) {
    try {
      resumeIndex = Math.max(resumeIndex, await viewportWait(opts.run.nextIndex(), VIEWPORT_FINAL_PROBE_MAX_MS, opts.signal));
    } catch { gap = true; }
  }
  if (opts.signal?.aborted) throw new Error('Viewport read aborted');
  gap ||= end < opts.initialIndex || resumeIndex > opts.initialIndex;
  const sampled = reducer.snapshot();
  const rows = sampled.length ? sampled : head.rows;
  const snapshot: ViewportSnapshot = {
    ...head, runId: opts.runId, sampledRange: { start, end },
    source: sampled.length ? 'stream_tail' : head.source, rows: [],
    gap, hasEarlier: gap || head.hasEarlier, replace: rows.length > 0,
    // skipStream never captured a tail; do not mint a guessed transport cursor.
    ...(opts.skipStream ? {} : { resumeIndex }),
  };
  if (rows.length) {
    const note: SessionMessage = { id: 'viewport_history_note', role: 'system', text: VIEWPORT_HISTORY_NOTE, at: 0 };
    // Include actual record envelope/framing in accounting, not just the rows.
    snapshot.rows = fitViewportRows([...rows, note], { ...snapshot, type: 'viewport_snapshot', framing: 'event: viewport_snapshot\ndata: \n\n' });
    snapshot.replace = snapshot.rows.length > 1;
    if (!snapshot.replace) snapshot.rows = [];
  }
  return snapshot;
}
