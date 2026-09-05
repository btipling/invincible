/**
 * Per-turn freshness reminder projection (plan #941, source #693 — the
 * prompt-side sentence of the #693 law: persisted `tool_result` snapshots are
 * NOT live file views).
 *
 * A **pure** derivation over the durable loop's reconstructed orchestrator
 * `messages` rows — the SAME array `derivePersistFold` (plan #936's
 * `modelMessages` sibling) walks at persist time. Zero I/O, replay-
 * deterministic, abort-honest: a cancelled turn's already-committed
 * `read_file` rows are exactly what this projection reports.
 *
 * Two exports:
 *  - `buildFreshnessReminder(messages)` — pair every **committed ok**
 *    `{role:'tool', toolName:'read_file', toolCallId}` row with its assistant
 *    row's `toolCalls` entry (same `toolCallId`) and take `args.path`
 *    (non-empty string). Dedupe preserving first-seen order; cap per the Caps
 *    table (drop OLDEST, keep newest — the reads the model is most likely to
 *    edit next turn). Returns `{ paths }` — `[]` when the turn read nothing
 *    (the caller still persists the empty list: volatility — a zero-read turn
 *    must clear the prior turn's paths).
 *  - `renderFreshnessReminder(paths)` — the locked volatile copy (the
 *    `Error:` prefix is the `{role:'error'}` fold contract —
 *    `toModelMessages` maps it to a trailing `user` message). Empty list →
 *    `undefined` (no row). Over-cap → newest paths + an explicit omitted
 *    marker. Never carries mtimes / sizes / hashes / bodies — names only;
 *    freshness stays disk-side (#277).
 *
 * Caps: `FRESHNESS_REMINDER_MAX_PATHS` (row cap, drop-oldest + marker) and
 * `FRESHNESS_REMINDER_MAX_BYTES` (deterministic byte trim of the serialized
 * `{paths}` object — keeps the newest paths). UTF-8 byte math uses
 * `TextEncoder` — the Workflows canvas has **no Node `Buffer`** (the #939
 * lesson; regression: `modelMessages.test.ts` source-lock + the static-graph
 * Buffer scan in `turnLoop.test.ts`).
 *
 * Layer: server-side `lib/agent/*` only — no DOM, no Wasm, no Vercel route;
 * no I/O; never throws.
 */
import {
  FRESHNESS_REMINDER_MAX_BYTES,
  FRESHNESS_REMINDER_MAX_PATHS,
} from '../sessionCloudCaps';

/** The derived, persistable projection body (persist seam writes `{paths}`). */
export type FreshnessReminderPaths = {
  paths: string[];
};

/** The orchestrator-local message rows the loop stores (loose for replay). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReminderMessages = ReadonlyArray<any>;

/** UTF-8 byte length — client/canvas-safe (NO Node `Buffer` here). */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Extract a non-empty string `path` from a tool-call `args` object. */
function pathFromArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const raw = (args as { path?: unknown }).path;
  if (typeof raw !== 'string') return undefined;
  const p = raw.trim();
  return p ? p : undefined;
}

/**
 * Bound the path list to the Caps table: at most `FRESHNESS_REMINDER_MAX_PATHS`
 * entries (drop the OLDEST, keep the newest) and the `JSON.stringify({paths})`
 * body under `FRESHNESS_REMINDER_MAX_BYTES` (drop the oldest paths
 * deterministically until it fits — the newest paths always win, mirroring the
 * row cap's keep-newest discipline). Returns the bound list + the count of
 * dropped paths for the honest truncation marker. Never throws.
 */
function boundPaths(paths: string[]): { paths: string[]; omitted: number } {
  let rows = [...paths];
  let omitted = 0;
  // Row cap: drop the oldest until at the cap.
  if (rows.length > FRESHNESS_REMINDER_MAX_PATHS) {
    omitted += rows.length - FRESHNESS_REMINDER_MAX_PATHS;
    rows = rows.slice(rows.length - FRESHNESS_REMINDER_MAX_PATHS);
  }
  // Byte cap (serialized `{paths}` object body): drop the oldest until it
  // fits. The newest paths survive (same keep-newest discipline as the row
  // cap); a single giant path that exceeds the whole cap is dropped with
  // everything before it (the loop exits with rows possibly empty).
  while (rows.length > 0 && utf8ByteLength(JSON.stringify({ paths: rows })) > FRESHNESS_REMINDER_MAX_BYTES) {
    rows = rows.slice(1);
    omitted += 1;
  }
  return { paths: rows, omitted };
}

/**
 * Derive the freshness-reminder path list from the loop's reconstructed
 * orchestrator `messages` (the same array `buildModelMessages` walks upstream
 * of the persist fold). Collects the `args.path` of every committed
 * `read_file` call: an **ok** `{role:'tool', toolName:'read_file'}` row paired
 * (by `toolCallId`) with its assistant row's `toolCalls` entry. Failed reads
 * grant nothing; non-`read_file` rows, `persist`/`error` rows, and rows whose
 * `toolCallId` cannot pair contribute nothing. Dedupe preserves first-seen
 * order; the row cap drops the OLDEST (keeps newest). Windowed/truncated reads
 * count (they still observed bytes the model may trust). Pure, never throws,
 * no I/O.
 */
export function buildFreshnessReminder(
  messages: ReminderMessages,
): FreshnessReminderPaths {
  const paths: string[] = [];
  const seen = new Set<string>();
  // Pass 1: index every assistant row's toolCalls args (by toolCallId,
  // first-seen wins). Malformed rows are skipped, never thrown.
  const argsByCallId = new Map<string, unknown>();
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const row = m as { role?: unknown; delta?: unknown };
    if (row.role !== 'assistant') continue;
    const delta = row.delta;
    if (!delta || typeof delta !== 'object') continue;
    const toolCalls = (delta as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      const id = (tc as { toolCallId?: unknown }).toolCallId;
      if (typeof id !== 'string' || !id) continue;
      if (argsByCallId.has(id)) continue;
      argsByCallId.set(id, (tc as { args?: unknown }).args);
    }
  }
  // Pass 2: walk tool rows in order; collect ok `read_file` paths (dedupe
  // first-seen). A row that fails to pair contributes nothing (fail-closed).
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const row = m as { role?: unknown; toolName?: unknown; toolCallId?: unknown; ok?: unknown };
    if (row.role !== 'tool') continue; // user/assistant/persist/error skipped
    if (row.toolName !== 'read_file') continue;
    if (row.ok === false) continue; // a failed read grants nothing
    const tcId = row.toolCallId;
    if (typeof tcId !== 'string' || !tcId) continue;
    if (!argsByCallId.has(tcId)) continue; // no paired call → nothing
    const path = pathFromArgs(argsByCallId.get(tcId));
    if (path === undefined) continue;
    if (seen.has(path)) continue; // dedupe preserving first-seen order
    seen.add(path);
    paths.push(path);
  }
  return { paths };
}

/**
 * Render the volatile per-turn reminder block (plan #941 locked copy). Empty
 * list → `undefined` (the caller folds nothing). The `Error:` prefix is the
 * `{role:'error'}` fold contract (`toModelMessages` maps it to a trailing
 * `user` message with that exact prefix idiom). States the FULL-read rule
 * (a windowed/truncated read does NOT grant edit — plan-review Major #1) and
 * keeps the #563 escape hint (`limit>=totalLines` at offset 1). Over-cap input
 * is bounded here too (newest paths win + marker) so a caller that renders an
 * unbounded list still gets a bounded string. Never carries mtimes, sizes,
 * hashes, or file bodies. Never throws.
 */
export function renderFreshnessReminder(paths: ReadonlyArray<string>): string | undefined {
  if (paths.length === 0) return undefined;
  const { paths: bounded, omitted } = boundPaths([...paths]);
  if (bounded.length === 0) return undefined;
  const lines: string[] = [
    'Error: File-freshness law for this session (volatile, this turn only):',
    'the tool results in earlier turns are SNAPSHOTS of prior observations, not',
    'live file views. Files may have changed on disk since (later writes, exec,',
    'another tab, a human, another device on this sandbox). This turn is a new',
    'observation run with an empty freshness ledger: before editing any path with',
    'str_replace or write_file you MUST read_file it again THIS turn — a FULL read',
    '(offset 1 covering every line; for a long file, limit>=totalLines as the',
    'status line hints). A windowed/truncated read does NOT grant edit. Never',
    'rewrite or trust last turn\u2019s bytes as current.',
    'Paths read in the previous turn (re-read before editing):',
  ];
  for (const p of bounded) {
    lines.push(`- ${p}`);
  }
  if (omitted > 0) {
    lines.push(`(\u2026 ${omitted} earlier paths omitted)`);
  }
  return lines.join('\n');
}

/**
 * Serialize the projection to the persisted `{paths}` JSON body — bounded by
 * `FRESHNESS_REMINDER_MAX_BYTES` (drop the oldest paths deterministically,
 * keep the newest). This is the exact body the persist seam writes as its own
 * Blob object (`writeSegment maxBytes`); trimming here first keeps the seam's
 * fail-closed byte ceiling a belt-and-suspenders check, not a runtime path.
 * Pure, never throws.
 */
export function serializeFreshnessReminder(projection: FreshnessReminderPaths): string {
  const { paths } = boundPaths(projection.paths);
  return JSON.stringify({ paths });
}
