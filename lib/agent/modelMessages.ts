/**
 * Model-messages projection (plan #936, source #549 — structured truncated
 * `tool_result` on the wire).
 *
 * Maps the turn loop's reconstructed orchestrator `messages` rows onto a
 * persisted model-facing array — the same orchestrator shape `toModelMessages`
 * already consumes — so the NEXT durable turn seeds its orchestrator from real
 * `tool-call` / `tool-result` pairs (with `toolCallId` linkage) instead of a
 * flattened `formatPromptWithHistory` prose fold.
 *
 * Row mapping (mirrors the loop's own persist rules):
 *  - `{role:'user', content}`                      → kept verbatim.
 *  - `{role:'assistant', delta:{text, toolCalls}}` → kept; `reasoning` NEVER
 *    carried (the loop already omits it from persist).
 *  - `{role:'tool', …, result}`                    → `result` truncated to
 *    `MODEL_MSG_TOOL_RESULT_MAX_CHARS` (UTF-8-safe prefix + explicit marker,
 *    same idiom as `fitSingleRow`); `exec` disk-log `log:` pointers survive
 *    (they ride in the head of the compact summary).
 *  - `{role:'tool', …, ok:false, error}`           → the (already short) error
 *    kept verbatim — synthetic `skipped:` closers stay intact so a committed
 *    pair is never split.
 *  - `{role:'persist', …}` / `{role:'error', …}`   → SKIPPED (loop-internal;
 *    wrap-up errors are model-only, matching `checkpointRow`'s existing rule).
 *
 * Locked invariants (#549's locked comments + plan-review lock 2):
 *  1. Never split a call from its result — an assistant row's `toolCalls` and
 *     the following `tool` rows are written atomically; the projection never
 *     fabricates a result for a call that has none (the loop's
 *     `unpairedToolRows` synthetic `skipped:` rows are the only allowed closer).
 *  2. Truncate, don't omit — a fat `read_file`/`search` lands as a bounded
 *     excerpt (paths + status + head), never a disappearance, never the 2M-char
 *     execute-time blob.
 *  3. No orphan results (review lock) — a `{role:'tool'}` row whose
 *     `toolCallId` is not present on some assistant row's `toolCalls` in the
 *     same array is DROPPED (skip-with-marker): `toModelMessages` keeps any
 *     well-formed tool row while dropping a call with a missing id, so a seeded
 *     orphan `tool-result` with no matching `tool-call` would be rejected by
 *     strict providers.
 *
 * Bounding: capped to `MODEL_MSG_CHECKPOINT_MAX_ROWS` rows and
 * `MODEL_MSG_CHECKPOINT_MAX_BYTES` serialized bytes (head-trim, oldest kept —
 * same fail-closed idiom as `truncateMessageCheckpoint`). The projection is its
 * own session-bound Blob object; only the object id rides
 * `meta.modelMessagesPointer` (never the 1 MiB envelope meta).
 *
 * Pure, server/client-safe, never throws — malformed rows fail closed to a
 * dropped/truncated projection. No I/O, no store, no secrets.
 */
import {
  MODEL_MSG_CHECKPOINT_MAX_BYTES,
  MODEL_MSG_CHECKPOINT_MAX_ROWS,
  MODEL_MSG_TOOL_RESULT_MAX_CHARS,
} from '../sessionCloudCaps';

/** A single tool-call on an assistant row (the loop's `TurnToolCallDelta`). */
export type ModelToolCall = {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
};

/** A persisted orchestrator-shape row (the shape `toModelMessages` consumes). */
export type ModelMessageRow =
  | { role: 'user'; content: string }
  | { role: 'assistant'; delta: { text: string; toolCalls: ModelToolCall[] } }
  | { role: 'tool'; toolName: string; toolCallId: string; result: string }
  | { role: 'tool'; toolName: string; toolCallId: string; ok: false; error: string };

export type ModelMessagesLimits = {
  maxRows: number;
  maxBytes: number;
  maxToolResultChars: number;
};

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Explicit truncation marker appended after a bounded tool-result excerpt. */
const TRUNCATION_MARKER = '… [truncated — full output on sandbox disk / omitted]';

/**
 * UTF-8-safe truncation: keep the longest prefix of `s` whose UTF-8 byte
 * length ≤ `budget`, iterating code points so a multi-byte rune is never split
 * mid-emit (same idiom as `messageCheckpoint.truncateUtf8Safe`).
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
 * Bound a tool `result` to `maxChars` (a char cap — peer-locked ~2k-char
 * excerpt order), by whole code points (never split a surrogate pair), with an
 * explicit marker when truncated. `exec` results are already compact summaries
 * whose `log:` disk pointers ride in the head, so the pointer lines survive.
 */
function truncateToolResult(result: string, maxChars: number): string {
  if (result.length <= maxChars) return result;
  const head = [...result].slice(0, maxChars).join('');
  return `${head}\n${TRUNCATION_MARKER}`;
}

/** Normalize one assistant `toolCalls` entry; drop entries with no toolName. */
function normalizeToolCall(item: unknown): ModelToolCall | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const o = item as Record<string, unknown>;
  if (typeof o.toolName !== 'string' || o.toolName.length === 0) return undefined;
  const out: ModelToolCall = { toolName: o.toolName };
  if (typeof o.toolCallId === 'string' && o.toolCallId.length > 0) {
    out.toolCallId = o.toolCallId;
  }
  if ('args' in o) out.args = o.args;
  return out;
}

/**
 * Collect every `toolCallId` present on some assistant row's `toolCalls` in
 * `rows` — the set a well-formed tool row must join (review lock 2).
 */
function collectCallIds(rows: ReadonlyArray<unknown>): Set<string> {
  const ids = new Set<string>();
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    const o = m as { role?: unknown; delta?: { toolCalls?: unknown } };
    if (o.role !== 'assistant') continue;
    const calls = o.delta?.toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      const id = (c as { toolCallId?: unknown })?.toolCallId;
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
  }
  return ids;
}

/**
 * Project the loop's reconstructed `messages` onto the persisted model-facing
 * array. Pure + never throws; see the module header for the row mapping and
 * the locked truncation/pairing/orphan invariants.
 */
export function buildModelMessages(
  messages: ReadonlyArray<unknown>,
  limits?: Partial<ModelMessagesLimits>,
): { rows: ModelMessageRow[]; truncated: boolean } {
  const maxRows = limits?.maxRows ?? MODEL_MSG_CHECKPOINT_MAX_ROWS;
  const maxBytes = limits?.maxBytes ?? MODEL_MSG_CHECKPOINT_MAX_BYTES;
  const maxToolResultChars =
    limits?.maxToolResultChars ?? MODEL_MSG_TOOL_RESULT_MAX_CHARS;

  const callIds = collectCallIds(messages);
  const rows: ModelMessageRow[] = [];
  let truncated = false;

  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      truncated = true;
      continue;
    }
    const o = m as Record<string, unknown>;
    const role = o.role;
    if (typeof role !== 'string') {
      truncated = true;
      continue;
    }

    if (role === 'user') {
      const content = typeof o.content === 'string' ? o.content : String(o.content ?? '');
      rows.push({ role: 'user', content });
      continue;
    }

    if (role === 'assistant') {
      const delta = o.delta as { text?: unknown; toolCalls?: unknown } | undefined;
      const text = typeof delta?.text === 'string' ? delta.text : '';
      const toolCalls: ModelToolCall[] = [];
      if (Array.isArray(delta?.toolCalls)) {
        for (const c of delta.toolCalls) {
          const call = normalizeToolCall(c);
          if (call) toolCalls.push(call);
          else truncated = true;
        }
      }
      // `reasoning` is deliberately NOT carried (live-only; omitted from persist).
      rows.push({ role: 'assistant', delta: { text, toolCalls } });
      continue;
    }

    if (role === 'tool') {
      const toolName = typeof o.toolName === 'string' && o.toolName ? o.toolName : 'tool';
      const toolCallId = typeof o.toolCallId === 'string' ? o.toolCallId : '';
      // Orphan-drop (review lock 2): a tool row whose call never converts
      // (missing toolCallId, or an id no assistant row carries) is dropped —
      // never seed a `tool-result` with no matching `tool-call`.
      if (toolCallId.length === 0 || !callIds.has(toolCallId)) {
        truncated = true;
        continue;
      }
      if (o.ok === false) {
        const error = typeof o.error === 'string' ? o.error : String(o.error ?? 'tool error');
        rows.push({ role: 'tool', toolName, toolCallId, ok: false, error });
      } else {
        const result = typeof o.result === 'string' ? o.result : String(o.result ?? '');
        rows.push({
          role: 'tool',
          toolName,
          toolCallId,
          result: truncateToolResult(result, maxToolResultChars),
        });
      }
      continue;
    }

    // role === 'persist' / 'error' / unknown → skip (loop-internal / model-only).
    if (role === 'persist' || role === 'error') continue;
    truncated = true;
  }

  // Row cap first: keep the head rows (oldest) up to `maxRows`.
  if (rows.length > maxRows) {
    rows.length = maxRows;
    truncated = true;
  }

  // Byte cap next: drop tail rows until the serialized form fits (head-trim,
  // oldest kept — same fail-closed idiom as `truncateMessageCheckpoint`).
  while (rows.length > 0 && utf8Bytes(JSON.stringify(rows)) > maxBytes) {
    rows.pop();
    truncated = true;
  }

  return { rows, truncated };
}
