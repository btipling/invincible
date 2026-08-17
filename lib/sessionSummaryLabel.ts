/**
 * Session-rail labels + catalog slice (host-side).
 * Wasm paints the bytes; it does not format titles.
 */
import {
  HARNESS_SESSION_LABEL_MAX_BYTES,
  HARNESS_SESSION_RAIL_MAX,
  isRedisSafeOpaqueId,
} from './sessionCloudCaps';
import { truncateUtf8 } from './sessionRepository';

export type SessionLabelInput = {
  id: string;
  title?: string | null;
  createdAt?: number;
  updatedAt?: number;
};

export function sessionSummaryLabel(s: SessionLabelInput): string {
  const title = typeof s.title === 'string' ? s.title.trim() : '';
  if (title.length > 0) return title;
  const short = s.id.length > 8 ? `…${s.id.slice(-7)}` : s.id;
  return `Untitled · ${short}`;
}

function updatedAtOf(s: SessionLabelInput): number {
  return typeof s.updatedAt === 'number' && Number.isFinite(s.updatedAt) ? s.updatedAt : 0;
}

function labeledRow(s: SessionLabelInput): { id: string; label: string } {
  const raw = sessionSummaryLabel(s);
  const label = truncateUtf8(raw, HARNESS_SESSION_LABEL_MAX_BYTES);
  return { id: s.id, label: label.length > 0 ? label : sessionSummaryLabel({ id: s.id }) };
}

/**
 * Sort newest-first, pin current (prepend if missing), slice to the rail cap.
 */
export function buildSessionCatalogEntries(
  sessions: SessionLabelInput[],
  currentId: string | null,
): { id: string; label: string }[] {
  const safe = sessions.filter((s) => isRedisSafeOpaqueId(s.id));
  safe.sort((a, b) => updatedAtOf(b) - updatedAtOf(a));

  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();

  if (currentId && isRedisSafeOpaqueId(currentId)) {
    const fromList = safe.find((s) => s.id === currentId);
    out.push(labeledRow(fromList ?? { id: currentId }));
    seen.add(currentId);
  }

  for (const s of safe) {
    if (seen.has(s.id)) continue;
    if (out.length >= HARNESS_SESSION_RAIL_MAX) break;
    out.push(labeledRow(s));
    seen.add(s.id);
  }
  return out;
}

/** Host poll fold: take (acks) then apply or drop. In-flight = ack-and-drop. */
export function foldPendingSessionSwitch(
  inflight: boolean,
  take: () => string | null,
  onSwitch: (id: string) => void,
): 'switched' | 'dropped' | 'none' {
  const id = take();
  if (id == null || id.length === 0) return 'none';
  if (inflight) return 'dropped';
  onSwitch(id);
  return 'switched';
}
