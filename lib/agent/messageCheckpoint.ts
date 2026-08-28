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
 * `tool_run`. Empty-text `assistant` rows are dropped: `generateOneRound` always
 * sets `delta.text` (including `''` for tool-only rounds) and the host never
 * stores those rows. Other unknown roles are dropped so
 * `parseCloudSessionSnapshot` cannot fail closed on the whole blob. Empty
 * checkpoint → `[]` (valid; LWW then keeps a local-with-dialogue snapshot).
 * Never throws.
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
    if (mapped === 'assistant' && row.content.length === 0) continue;
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
 * Finds the longest prefix of `incoming` that flex-matches a suffix of `prior`:
 * - `user` / `assistant` compare `role`+`text`.
 * - `tool_run` compares **role only**. A single prior `tool_run` covers a run
 *   of incoming `tool_run` rows when the next prior row is not `tool_run`
 *   (host `livePaintToolRun` grows one encodeToolRun card for N tools).
 *   Consecutive prior `tool_run` rows stay 1:1 (worker-to-worker raw rows).
 *   When that prior card is the last `tool_run` in the matched suffix, incoming
 *   `assistant` rows that are still followed by a `tool_run` are skipped so
 *   per-round checkpoint text between tools cannot zero overlap (`turnLoop`
 *   interleaves `{role:'assistant', delta}` with tools). A later prior
 *   `tool_run` (worker interleaved `[t1, asst, t2]`) stays 1:1 — no skip.
 * - Incoming `assistant` rows are skipped while the current prior row is
 *   `tool_run` (per-round preamble / empty rounds are not in the mid-turn
 *   host snapshot; live assistant is bridge-only until terminal `done.text`).
 *   Skip is for matching only: when the prior suffix ends on a `tool_run`
 *   (no covering assistant), those skipped this-run assistant texts are
 *   folded into the appended tail as one row (`+=` of per-round `delta.text`,
 *   same as host `done.text`) — including when the last checkpoint round is
 *   empty-text so incoming ends on `tool_run` and overlap is the full prefix
 *   (no remainder). Fold runs only when the winning match **skipped** an
 *   incoming assistant against a prior `tool_run` (mid-turn host card). A
 *   worker 1:1 prior that already is this run (no skip) stays no-append,
 *   including empty last-round persist retry. A prior that already ends with
 *   a covering concat stays no-append. Persist retry onto that fold (B7
 *   wrote `[…, card, foldedJoin]`, then `'use step'` retries): incoming
 *   empty last-round ends on `tool_run` so the leftover covering assistant
 *   is not incoming-matched; a single leftover prior `assistant` that
 *   covers `+=` of this-run assts is skipped so the last raw tool is not
 *   appended. Consecutive prior assistants stay 1:1.
 * - After a this-run tool match, a single trailing prior `assistant` covers
 *   remaining incoming `assistant` rows when its text equals the incoming
 *   text or **ends with** it (host concatenated `done.text` vs last-round
 *   checkpoint). Reverse `incoming.endsWith(prior)` is not a cover: a new
 *   reply that happens to end with a previous short ack (`OK` / `Done`)
 *   must append. Consecutive prior assistants stay 1:1.
 * - Host-only `skill_attached` / `system` / `error` in the prior suffix are
 *   skipped so they cannot zero overlap.
 *
 * Remainder is appended with unique `cp_*` ids and `at` values strictly after
 * the prior max. When skip-matching left this-run assistant text unmatched
 * against a prior that ends on a tool card, the remainder is one concatenated
 * assistant row rather than last-round-only. Empty incoming keeps prior.
 * Empty prior keeps incoming. Never throws.
 */
export function mergeCheckpointOntoPrior(
  prior: ReadonlyArray<CheckpointSnapshotMessage>,
  incoming: ReadonlyArray<CheckpointSnapshotMessage>,
): CheckpointSnapshotMessage[] {
  if (prior.length === 0) return incoming.slice();
  if (incoming.length === 0) return prior.slice();
  let overlap = 0;
  let skippedAssistant = false;
  outer: for (let k = incoming.length; k > 0; k--) {
    for (let pStart = 0; pStart < prior.length; pStart++) {
      const hit = flexMatchExact(prior, pStart, incoming, k);
      if (hit.matched) {
        overlap = k;
        skippedAssistant = hit.skippedAssistant;
        break outer;
      }
    }
  }
  let appended: CheckpointSnapshotMessage[] = incoming.slice(overlap);
  if (shouldFoldSkippedAssistants(prior, incoming, overlap, appended, skippedAssistant)) {
    appended = foldIncomingAssistants(incoming);
  }
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

/** Host-only roles that live in the DOM snapshot but not the worker checkpoint. */
const HOST_ONLY_ROLES = new Set<SessionRole>(['skill_attached', 'system', 'error']);

function isHostOnlyRole(role: SessionRole): boolean {
  return HOST_ONLY_ROLES.has(role);
}

/** Last non-host-only role in `rows`, walking from the tail. */
function lastKeptRole(
  rows: ReadonlyArray<CheckpointSnapshotMessage>,
): SessionRole | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (!r || isHostOnlyRole(r.role)) continue;
    return r.role;
  }
  return undefined;
}

/**
 * Mid-turn host card (prior ends on `tool_run`): skipped per-round assts sat
 * inside the matched prefix and would otherwise be dropped. Fold when a
 * this-run tool was overlapped AND the winning match skipped an incoming
 * assistant against a prior `tool_run` (host card / host-card coalesce),
 * including a full-prefix match with no remainder (empty last-round
 * assistant dropped). A worker 1:1 prior of the same checkpoint (persist
 * retry) does not skip, so it stays no-append. Covering concat is excluded
 * by `lastKeptRole !== 'tool_run'`.
 */
function shouldFoldSkippedAssistants(
  prior: ReadonlyArray<CheckpointSnapshotMessage>,
  incoming: ReadonlyArray<CheckpointSnapshotMessage>,
  overlap: number,
  appended: ReadonlyArray<CheckpointSnapshotMessage>,
  skippedAssistant: boolean,
): boolean {
  if (overlap === 0) return false;
  if (!skippedAssistant) return false;
  if (lastKeptRole(prior) !== 'tool_run') return false;
  if (!appended.every((m) => m.role === 'assistant')) return false;
  if (!incoming.slice(0, overlap).some((m) => m.role === 'tool_run')) return false;
  return incoming.some((m) => m.role === 'assistant');
}

/** One assistant row: `+=` of this-run assistant texts (host `done.text`). */
function foldIncomingAssistants(
  incoming: ReadonlyArray<CheckpointSnapshotMessage>,
): CheckpointSnapshotMessage[] {
  const texts: string[] = [];
  let first: CheckpointSnapshotMessage | undefined;
  for (const m of incoming) {
    if (m.role !== 'assistant' || m.text.length === 0) continue;
    if (!first) first = m;
    texts.push(m.text);
  }
  if (!first || texts.length === 0) return [];
  return [{ id: first.id, role: 'assistant', text: texts.join(''), at: first.at }];
}


/** Skip a prior host-only row unless incoming is that same role+text. */
function shouldSkipPriorRow(
  prior: CheckpointSnapshotMessage,
  incoming: CheckpointSnapshotMessage,
): boolean {
  if (!isHostOnlyRole(prior.role)) return false;
  if (prior.role === incoming.role && prior.text === incoming.text) return false;
  return true;
}

/**
 * Incoming prefix `incoming[0..prefixLen)` flex-matches `prior[pStart..end)`
 * exactly (both fully consumed, after host-only skips and coalesced tool runs).
 * `skippedAssistant` is true only when this match skipped an incoming
 * assistant against a prior `tool_run` (host card path).
 */
function flexMatchExact(
  prior: ReadonlyArray<CheckpointSnapshotMessage>,
  pStart: number,
  incoming: ReadonlyArray<CheckpointSnapshotMessage>,
  prefixLen: number,
): { matched: boolean; skippedAssistant: boolean } {
  let pi = pStart;
  let ii = 0;
  let matchedTool = false;
  let skippedAssistant = false;
  while (ii < prefixLen) {
    while (
      pi < prior.length &&
      prior[pi] &&
      incoming[ii] &&
      shouldSkipPriorRow(prior[pi]!, incoming[ii]!)
    ) {
      pi += 1;
    }
    // Worker per-round assistants are not in the mid-turn host snapshot
    // (bridge-only until terminal done.text). Skip them so they cannot
    // zero overlap against a host tool card.
    while (
      ii < prefixLen &&
      incoming[ii]?.role === 'assistant' &&
      prior[pi]?.role === 'tool_run'
    ) {
      skippedAssistant = true;
      ii += 1;
    }
    if (ii >= prefixLen) break;
    const p = prior[pi];
    const n = incoming[ii];
    if (!p || !n) return { matched: false, skippedAssistant: false };
    const afterToolAssistant =
      matchedTool && p.role === 'assistant' && n.role === 'assistant';
    if (afterToolAssistant) {
      if (!assistantCovers(p.text, n.text)) {
        return { matched: false, skippedAssistant: false };
      }
    } else if (!snapshotRowOverlaps(p, n)) {
      return { matched: false, skippedAssistant: false };
    }
    pi += 1;
    ii += 1;
    if (p.role === 'tool_run') {
      matchedTool = true;
      const nextP = prior[pi];
      if (!nextP || nextP.role !== 'tool_run') {
        // Host coalesced card (no later prior tool in this suffix): consume
        // this-run tools, skipping interleaved per-round assistants.
        // Worker interleaved `[t1, asst, t2]` has a later prior tool → 1:1.
        if (hasLaterRole(prior, pi, prior.length, 'tool_run')) {
          while (ii < prefixLen && incoming[ii]?.role === 'tool_run') {
            ii += 1;
          }
        } else {
          while (ii < prefixLen) {
            const n = incoming[ii];
            if (n?.role === 'tool_run') {
              ii += 1;
              continue;
            }
            if (
              n?.role === 'assistant' &&
              hasLaterRole(incoming, ii + 1, prefixLen, 'tool_run')
            ) {
              skippedAssistant = true;
              ii += 1;
              continue;
            }
            break;
          }
        }
      }
    }
    if (afterToolAssistant) {
      const nextP = prior[pi];
      if (!nextP || nextP.role !== 'assistant') {
        while (ii < prefixLen && incoming[ii]?.role === 'assistant') {
          ii += 1;
        }
      }
    }
  }
  while (pi < prior.length && prior[pi] && isHostOnlyRole(prior[pi]!.role)) {
    pi += 1;
  }
  // Persist retry onto a covering concat / mid-turn fold: the incoming prefix
  // is fully consumed after a this-run tool match, but prior still has the
  // folded `done.text` assistant (empty last-round dropped it from incoming).
  // One leftover assistant that covers `+=` of this-run assts is this run
  // already on the pointer — skip it (and trailing host-only). Consecutive
  // prior assistants stay 1:1 (do not consume a run). Different replies
  // fail `assistantCovers` and still append.
  if (ii === prefixLen && matchedTool) {
    const leftover = prior[pi];
    if (leftover?.role === 'assistant') {
      const folded = foldIncomingAssistants(incoming.slice(0, prefixLen));
      const foldText = folded[0]?.text ?? '';
      if (foldText.length > 0 && assistantCovers(leftover.text, foldText)) {
        pi += 1;
        while (pi < prior.length && prior[pi] && isHostOnlyRole(prior[pi]!.role)) {
          pi += 1;
        }
      }
    }
  }
  const matched = pi === prior.length && ii === prefixLen;
  return { matched, skippedAssistant: matched && skippedAssistant };
}

/** Host tool cards encode a payload; worker checkpoint rows are raw results. */
function snapshotRowOverlaps(
  prior: CheckpointSnapshotMessage,
  incoming: CheckpointSnapshotMessage,
): boolean {
  if (prior.role !== incoming.role) return false;
  if (prior.role === 'tool_run') return true;
  return prior.text === incoming.text;
}

function hasLaterRole(
  rows: ReadonlyArray<CheckpointSnapshotMessage>,
  from: number,
  end: number,
  role: SessionRole,
): boolean {
  for (let i = from; i < end; i++) {
    if (rows[i]?.role === role) return true;
  }
  return false;
}

/**
 * Trailing-assistant cover after a this-run tool match: equal, or prior text
 * ends with the incoming text (host concatenated `done.text` vs last-round
 * checkpoint). Reverse `incoming.endsWith(prior)` is not a cover — a longer
 * new reply that happens to end with a previous short ack must append.
 * Empty strings never cover — `String.prototype.endsWith('')` is true for
 * every haystack.
 */
function assistantCovers(priorText: string, incomingText: string): boolean {
  if (priorText.length === 0 || incomingText.length === 0) return false;
  return priorText === incomingText || priorText.endsWith(incomingText);
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

