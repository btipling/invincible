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

/** A single `{role, content}` checkpoint row. `content` is always a string (may be empty). */
export type CheckpointRow = { role: string; content: string };

/** Overridable limits (defaults = the plan #800 NEW caps). */
export type CheckpointLimits = { maxRows: number; maxBytes: number };

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
 * Fit a single oversize row into `maxBytes` by truncating its `content`
 * UTF-8-safely to the byte budget. Returns the fitted row, or `null` when even a
 * content-less version of the row cannot fit (the serialized scaffolding alone
 * exceeds `maxBytes`) → the caller drops it deterministically. Never throws.
 */
function fitSingleRow(row: CheckpointRow, maxBytes: number): CheckpointRow | null {
  const base = utf8Bytes(JSON.stringify([{ role: row.role, content: '' }]));
  const contentBudget = maxBytes - base;
  if (contentBudget <= 0) return null;
  return { role: row.role, content: truncateUtf8Safe(row.content, contentBudget) };
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
