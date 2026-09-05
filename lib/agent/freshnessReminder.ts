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
  /**
   * Count of paths dropped by the row/byte cap (adversarial-review #943).
   * Present on the persisted Blob when > 0 so the next-turn renderer can
   * emit the honest `… N earlier paths omitted` marker — `serialize` used
   * to drop this, so the production persist→read→render path never showed
   * it. Omitted from the JSON when 0 (`{paths}` only) so existing empty /
   * under-cap blobs stay byte-equal.
   */
  omitted?: number;
};

/** The orchestrator-local message rows the loop stores (loose for replay). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReminderMessages = ReadonlyArray<any>;

/** UTF-8 byte length — client/canvas-safe (NO Node `Buffer` here). */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Control chars (C0, DEL, line/paragraph separators) in a path would split
 * the rendered `- ${p}` list into extra lines and can smuggle a fake
 * omitted marker or `Error:` sentence into the trailing user message
 * (adversarial-review #943 Minor L2). Drop the path rather than collapse
 * it into a fake name the gate would not recognize.
 */
function sanitizeReminderPath(raw: string): string | undefined {
  const p = raw.trim();
  if (!p) return undefined;
  if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(p)) return undefined;
  return p;
}

/** Extract a non-empty string `path` from a tool-call `args` object. */
function pathFromArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const raw = (args as { path?: unknown }).path;
  if (typeof raw !== 'string') return undefined;
  return sanitizeReminderPath(raw);
}

/**
 * Persistable `{paths}` / `{paths, omitted}` JSON. `omitted` is included
 * only when > 0 so under-cap bodies stay `{paths}` (byte-equal with the
 * original shape).
 */
function encodeReminderBody(paths: string[], omitted: number): string {
  // Empty list folds nothing next turn — omit the marker (a marker with no
  // surviving names cannot render). Under-cap bodies stay `{paths}` only.
  if (paths.length === 0 || omitted <= 0) return JSON.stringify({ paths });
  return JSON.stringify({ paths, omitted });
}

/**
 * Bound the path list to the Caps table: at most `FRESHNESS_REMINDER_MAX_PATHS`
 * entries (drop the OLDEST, keep the newest) and the serialized body under
 * `FRESHNESS_REMINDER_MAX_BYTES` (drop the oldest paths deterministically
 * until it fits — the newest paths always win, mirroring the row cap's
 * keep-newest discipline). Returns the bound list + the count of dropped
 * paths for the honest truncation marker. Byte math uses the SAME encoder
 * `serializeFreshnessReminder` writes (including `omitted` when > 0) so a
 * marker-bearing body cannot exceed the persist seam's `writeSegment`
 * ceiling. Never throws.
 */
function boundPaths(paths: string[]): { paths: string[]; omitted: number } {
  let rows = [...paths];
  let omitted = 0;
  // Row cap: drop the oldest until at the cap.
  if (rows.length > FRESHNESS_REMINDER_MAX_PATHS) {
    omitted += rows.length - FRESHNESS_REMINDER_MAX_PATHS;
    rows = rows.slice(rows.length - FRESHNESS_REMINDER_MAX_PATHS);
  }
  // Byte cap (serialized body): drop the oldest until it fits. The newest
  // paths survive (same keep-newest discipline as the row cap); a single
  // giant path that exceeds the whole cap is dropped with everything
  // before it (the loop exits with rows possibly empty).
  while (
    rows.length > 0 &&
    utf8ByteLength(encodeReminderBody(rows, omitted)) > FRESHNESS_REMINDER_MAX_BYTES
  ) {
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
 * unbounded list still gets a bounded string.
 *
 * `persistedOmitted` (adversarial-review #943): count of paths already
 * dropped at serialize time. Added to any further boundPaths drop so the
 * production persist→read→render path can emit the honest marker (the Blob
 * stores the trimmed list + this count; calling render on the trimmed list
 * alone would report omitted=0).
 *
 * Never carries mtimes, sizes, hashes, or file bodies. Never throws.
 */
export function renderFreshnessReminder(
  paths: ReadonlyArray<string>,
  persistedOmitted = 0,
): string | undefined {
  if (paths.length === 0 && !(persistedOmitted > 0)) return undefined;
  const cleaned: string[] = [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const s = sanitizeReminderPath(p);
    if (s) cleaned.push(s);
  }
  const extra =
    typeof persistedOmitted === 'number' &&
    Number.isFinite(persistedOmitted) &&
    persistedOmitted > 0
      ? Math.floor(persistedOmitted)
      : 0;
  const { paths: bounded, omitted: boundOmitted } = boundPaths(cleaned);
  const omitted = extra + boundOmitted;
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
 * keep the newest). When the cap drops paths, the body is
 * `{paths, omitted}` so the next-turn renderer can emit the honest marker
 * (adversarial-review #943). Under-cap / empty stays `{paths}` only. This is
 * the exact body the persist seam writes as its own Blob object
 * (`writeSegment maxBytes`); trimming here first keeps the seam's
 * fail-closed byte ceiling a belt-and-suspenders check, not a runtime path.
 * Pure, never throws.
 */
export function serializeFreshnessReminder(projection: FreshnessReminderPaths): string {
  const { paths, omitted } = boundPaths(projection.paths);
  return encodeReminderBody(paths, omitted);
}
