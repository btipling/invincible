/**
 * Message-checkpoint truncation helper (plan #800, backend-agents B6).
 *
 * A turn's message checkpoint is a structured multi-turn `{role, content}`
 * projection that later persist rows (B7/B13) write as a **Blob object**, never
 * the 1 MiB envelope `meta` body. Before that write can happen, the projection
 * must be bounded: a bounded row count and a bounded UTF-8 serialized byte
 * size, with an explicit `truncated` marker so a writer knows the checkpoint
 * lost data.
 *
 * This module is a **pure, server/client-safe helper**: it holds no state, talks
 * to no store, and is only concerned with turning a (possibly hostile or huge)
 * row stream into a bounded, deterministic projection. **Never throws** — any
 * malformed input fails closed to a truncated/empty projection. It does NOT put
 * transcript content in workflow events (delta/seed only).
 */
import {
  TURN_MSG_CHECKPOINT_MAX_BYTES,
  TURN_MSG_CHECKPOINT_MAX_ROWS,
} from '../sessionCloudCaps';
import type { SessionRole } from '../sessionStore';

/** A single `{role, content}` checkpoint row. `content` is always a string (may be empty). */
export type CheckpointRow = { role: string; content: string };

/** Overridable limits (defaults = the plan #800 NEW caps). */
export type CheckpointLimits = { maxRows: number; maxBytes: number };

/** Snapshot message the Blob transcript parser accepts (`parseCloudSessionSnapshot`). */
export type CheckpointSnapshotMessage = {
  id: string;
  role: SessionRole;
  text: string;
  at: number;
};

const SESSION_ROLES = new Set<SessionRole>([
  'user',
  'assistant',
  'system',
  'error',
  'tool_run',
  'skill_attached',
]);

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function serializedBytes(rows: CheckpointRow[]): number {
  return utf8Bytes(JSON.stringify(rows));
}

/**
 * Accept only a well-formed `{role, content}` row: a non-null, non-array object
 * whose `role` is a non-empty string and whose `content` is a string (empty
 * content allowed). Anything else (missing/`undefined`/non-string `role`,
 * non-string `content`, a bare primitive, an array) is malformed → dropped.
 */
function normalizeRow(item: unknown): CheckpointRow | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
  const o = item as Record<string, unknown>;
  if (typeof o.role !== 'string' || o.role.length === 0) return undefined;
  if (typeof o.content !== 'string') return undefined;
  return { role: o.role, content: o.content };
}

/**
 * UTF-8-safe truncation: keep the longest prefix of `s` whose UTF-8 byte length
 * ≤ `budget`. Iterates code points so a multi-byte rune is never split mid-emit.
 */
function truncateUtf8Safe(s: string, budget: number): string {
  if (utf8Bytes(s) <= budget) return s;
  let out = '';
  let remaining = budget;
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (b > remaining) break;
    out += ch;
    remaining -= b;
  }
  return out;
}

/**
 * Fit a single oversize row into `maxBytes` so that its *serialized* form — after
 * `JSON.stringify` escapes `"`, `\`, and control chars (each control char expands
 * to `\uXXXX`, up to 6× its raw UTF-8 footprint) — stays within the cap. The raw
 * `content` byte budget is binary-searched (whole-UTF-8-rune, so no mid-rune
 * split) to the largest prefix whose serialized JSON of the row fits `maxBytes`.
 *
 * Returns the fitted row, or `null` when even a content-less version cannot fit
 * (the serialized scaffolding alone exceeds `maxBytes`) → the caller drops it
 * deterministically. Never throws.
 */
function fitSingleRow(row: CheckpointRow, maxBytes: number): CheckpointRow | null {
  const scaffold = utf8Bytes(JSON.stringify([{ role: row.role, content: '' }]));
  if (scaffold > maxBytes) return null;
  // Search the raw-content byte budget; serialized size is monotonic non-decreasing
  // in the raw prefix length, so a binary search is exact and always terminates
  // (best starts at 0, and the empty content serializes to `scaffold <= maxBytes`).
  const totalContent = utf8Bytes(row.content);
  let lo = 0;
  let hi = totalContent;
  let best = 0;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const fitted = truncateUtf8Safe(row.content, mid);
    const serialized = utf8Bytes(JSON.stringify([{ role: row.role, content: fitted }]));
    if (serialized <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { role: row.role, content: truncateUtf8Safe(row.content, best) };
}

/**
 * Bound a message checkpoint to the row cap then the byte cap, keeping the
 * **head** rows (oldest-first), and mark `truncated=true` when either cap forced
 * a drop. A single oversize row's `content` is truncated UTF-8-safely to the
 * remaining byte budget — or, if even a content-less row can't fit, dropped
 * deterministically — so a lone giant message can never blow the byte cap or
 * throw. **Never throws** (fail-closed): non-array input and malformed rows drop
 * with `truncated=true`; a well-formed row set under both caps passes through
 * unchanged with `truncated=false`.
 *
 * `limits` is optional and defaults to the plan #800 NEW caps
 * (`TURN_MSG_CHECKPOINT_MAX_ROWS` / `TURN_MSG_CHECKPOINT_MAX_BYTES`); callers may
 * override for tests or tighter embeddings, but production always uses the caps.
 */
export function truncateMessageCheckpoint(
  input: unknown,
  limits?: Partial<CheckpointLimits>,
): { rows: CheckpointRow[]; truncated: boolean } {
  const maxRows = limits?.maxRows ?? TURN_MSG_CHECKPOINT_MAX_ROWS;
  const maxBytes = limits?.maxBytes ?? TURN_MSG_CHECKPOINT_MAX_BYTES;

  const rows: CheckpointRow[] = [];
  if (!Array.isArray(input)) {
    // Non-array input fails closed: no projection, marked truncated.
    return { rows, truncated: true };
  }
  let truncated = false;
  for (const item of input) {
    const r = normalizeRow(item);
    if (r) {
      rows.push(r);
    } else {
      truncated = true; // malformed row dropped (fail-closed)
    }
  }

  // Row cap first: keep the head rows up to `maxRows`.
  if (rows.length > maxRows) {
    rows.length = maxRows;
    truncated = true;
  }

  // Byte cap next: drop tail rows until the serialized form fits; a lone
  // remaining oversize row has its content truncated (or is dropped).
  while (rows.length > 0 && serializedBytes(rows) > maxBytes) {
    if (rows.length === 1) {
      const fit = fitSingleRow(rows[0], maxBytes);
      if (fit) {
        rows[0] = fit;
      } else {
        rows.length = 0;
      }
      truncated = true;
      break;
    }
    rows.pop();
    truncated = true;
  }

  return { rows, truncated };
}

/**
 * Map a bounded `{role, content}` checkpoint onto `SessionSnapshot.messages`.
 *
 * Checkpoint `tool` (the turn-loop reconstruction role) becomes session
 * `tool_run`. Other unknown roles are dropped so `parseCloudSessionSnapshot`
 * cannot fail closed on the whole blob. Empty checkpoint → `[]` (valid; LWW
 * then keeps a local-with-dialogue snapshot). Never throws.
 */
export function checkpointToSnapshotMessages(
  checkpoint: ReadonlyArray<{ role: string; content: string }>,
): CheckpointSnapshotMessage[] {
  const out: CheckpointSnapshotMessage[] = [];
  for (let i = 0; i < checkpoint.length; i++) {
    const row = checkpoint[i];
    if (!row || typeof row.role !== 'string' || typeof row.content !== 'string') continue;
    const mapped = row.role === 'tool' ? 'tool_run' : row.role;
    if (!SESSION_ROLES.has(mapped as SessionRole)) continue;
    out.push({
      id: `cp_${i}`,
      role: mapped as SessionRole,
      text: row.content,
      at: 1 + i,
    });
  }
  return out;
}

/**
 * Pull `messages` off a parseable snapshot JSON body. Returns null when the
 * body is not `{ id, messages[] }` with SessionRole rows — leftover `{ deltas }`
 * and other unreadable objects fail closed so the caller can start from this
 * run only. Runtime-pure: no `sessionRepository` import.
 */
export function snapshotMessagesFromUnknown(
  body: unknown,
  expectedId: string,
): CheckpointSnapshotMessage[] | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (o.id !== expectedId) return null;
  if (!Array.isArray(o.messages)) return null;
  const out: CheckpointSnapshotMessage[] = [];
  for (const m of o.messages) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
    const msg = m as Record<string, unknown>;
    if (typeof msg.id !== 'string' || !msg.id) return null;
    if (typeof msg.role !== 'string' || !SESSION_ROLES.has(msg.role as SessionRole)) {
      return null;
    }
    if (typeof msg.text !== 'string') return null;
    if (typeof msg.at !== 'number' || !Number.isFinite(msg.at)) return null;
    out.push({
      id: msg.id,
      role: msg.role as SessionRole,
      text: msg.text,
      at: msg.at,
    });
  }
  return out;
}

/**
 * Suffix-merge this-run snapshot messages onto a prior readable transcript.
 *
 * Finds the longest prefix of `incoming` that is already a suffix of `prior`
 * (`role`+`text`) so a host PUT that already includes this turn is not
 * duplicated. Remainder is appended with unique `cp_*` ids and `at` values
 * strictly after the prior max. Empty incoming keeps prior. Empty prior
 * keeps incoming. Never throws.
 */
export function mergeCheckpointOntoPrior(
  prior: ReadonlyArray<CheckpointSnapshotMessage>,
  incoming: ReadonlyArray<CheckpointSnapshotMessage>,
): CheckpointSnapshotMessage[] {
  if (prior.length === 0) return incoming.slice();
  if (incoming.length === 0) return prior.slice();
  let overlap = 0;
  const max = Math.min(prior.length, incoming.length);
  for (let k = max; k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      const p = prior[prior.length - k + i];
      const n = incoming[i];
      if (!p || !n || p.role !== n.role || p.text !== n.text) {
        ok = false;
        break;
      }
    }
    if (ok) {
      overlap = k;
      break;
    }
  }
  const appended = incoming.slice(overlap);
  if (appended.length === 0) return prior.slice();
  const baseAt = prior.reduce((m, x) => (x.at > m ? x.at : m), 0);
  const used = new Set(prior.map((m) => m.id));
  const out = prior.slice();
  for (let i = 0; i < appended.length; i++) {
    const row = appended[i];
    if (!row) continue;
    let n = out.length;
    let id = `cp_${n}`;
    while (used.has(id)) {
      n += 1;
      id = `cp_${n}`;
    }
    used.add(id);
    out.push({
      id,
      role: row.role,
      text: row.text,
      at: baseAt + 1 + i,
    });
  }
  return out;
}

/**
 * If `content` is a snapshot JSON object, replace `messages` with the
 * suffix-merge against `prior`. Non-snapshot objects (test `{delta}` bodies,
 * leftover `{ deltas }`) return null so the caller can stamp the original.
 * Invalid JSON returns null. No clock — the seam stamps `updatedAt` after.
 */
export function applyPriorMessagesToSnapshotJson(
  content: string,
  prior: ReadonlyArray<CheckpointSnapshotMessage> | null,
  expectedId: string,
): string | null {
  try {
    const parsed: unknown = JSON.parse(content);
    const incoming = snapshotMessagesFromUnknown(parsed, expectedId);
    if (incoming === null) return null;
    const rec = parsed as Record<string, unknown>;
    const messages = mergeCheckpointOntoPrior(prior ?? [], incoming);
    return JSON.stringify({ ...rec, messages });
  } catch {
    return null;
  }
}

