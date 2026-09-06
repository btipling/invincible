/**
 * Compaction primitives (plan #948, source #552 — A4 compaction engine,
 * phase 1 of parent #947). Pure, server/client-safe, no I/O, never throws;
 * `TextEncoder` byte math — no Node `Buffer` (the Workflows canvas has no
 * `Buffer` global; #939 canvas lesson).
 *
 * What phase 1 owns (parent #947 phase map):
 *  - the **cut walk**: walk back from the newest row to the newest `user`
 *    boundary whose retained tail fits the token/row/byte budget — the rows
 *    before that boundary are the compaction span. The cut NEVER lands
 *    between an assistant `toolCalls` row and its `tool` result rows: both
 *    sides are re-paired with `rePairModelMessages` (the locked #937
 *    invariant, reused unmodified — never a fork).
 *  - the **checkpoint builder**: the typed `{ summary, filesTouched,
 *    retainedTail }` object (parent architectural-decision lock), with the
 *    `COMPACTION_SUMMARY_MAX_CHARS` / `COMPACTION_FILES_TOUCHED_MAX` caps
 *    enforced here (truncate + explicit marker, never a silent drop).
 *  - the **honesty renderer** (parent Goal 4): the summary row is a
 *    `user`-role row labeled `Summary of earlier session (compacted, not
 *    live assistant prose):` — compaction text is never framed as live
 *    assistant prose, and the canvas paints nothing new (server-only row).
 *
 * What phase 1 does NOT own (out of scope): the persist seam
 * (`meta.compactionPointer` → phase 2 #949), the route trigger + summarizer
 * step (phase 3 #950), docs (phase 5 #952).
 *
 * The window/budget source is #944's (`getJoinedWindowMap` /
 * `foldBudgetTokens` / `estimateTokens`) — consumed, never re-implemented.
 */
import {
  COMPACTION_CHECKPOINT_MAX_BYTES,
  COMPACTION_FILES_TOUCHED_MAX,
  COMPACTION_START_MAX_BYTES,
  COMPACTION_SUMMARY_MAX_CHARS,
  CONTEXT_CHARS_PER_TOKEN,
  MODEL_MSG_SEED_MAX_BYTES,
  MODEL_MSG_SEED_MAX_ROWS,
} from '../sessionCloudCaps';
import {
  type ModelMessageRow,
  rePairModelMessages,
  trimModelMessagesToBudget,
} from './modelMessages';


export type { ModelMessageRow };

/** The summary text rides in the labeled summary row (char-capped here). */
export type CompactionSummaryInput = {
  summary: string;
  filesTouched: string[];
};

/**
 * The typed checkpoint object (parent #947 architectural-decision lock —
 * the OpenCode `session_message type:"compaction"` / Codex `Compacted`
 * shape). `retainedTail` starts AFTER the compaction span (Pi).
 */
export type CompactionCheckpoint = {
  summary: string;
  filesTouched: string[];
  retainedTail: ModelMessageRow[];
};

/** Result of a successful cut walk. */
export type CompactionCut = {
  /** Index of the first row of the retained tail (a `user` boundary). */
  cutIndex: number;
  /** Rows BEFORE the boundary — the span the summarizer will summarize. */
  span: ModelMessageRow[];
  /** Rows from the boundary to the end — the retained tail. */
  tail: ModelMessageRow[];
};

const encoder = new TextEncoder();
const utf8Bytes = (s: string): number => encoder.encode(s).length;

/** Explicit truncation marker appended after a bounded summary (never silent). */
const SUMMARY_TRUNCATION_MARKER = '… [summary truncated]';

/** The honesty label (parent #947 Goal 4 — locked copy, phase 1 renders it). */
export const COMPACTION_SUMMARY_LABEL =
  'Summary of earlier session (compacted, not live assistant prose):';

/** The files line prefix rendered under the summary in the labeled row. */
const FILES_TOUCHED_PREFIX = 'Files read/modified:';

/** Suffix `boundSummary` appends after a dropped code point. */
const TRUNCATION_SUFFIX = `\n${SUMMARY_TRUNCATION_MARKER}`;

/**
 * Honesty suffix `buildCheckpoint` bakes into `summary` when files overflow
 * (checkpoint shape has no `omitted` field). `$` so only a trailing bake is
 * peeled — a summarizer that mentioned the phrase mid-text is left alone.
 */
const FILES_OMITTED_SUFFIX_RE = new RegExp(
  `\\n${FILES_TOUCHED_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} … \\((\\d+) earlier paths omitted\\)$`,
);

/**
 * Peel decorations THIS module baked onto `summary` so a second
 * `buildCheckpoint` (phase-2 read-seam re-validation) recaps the HEAD and
 * re-applies honesty, instead of treating the omitted/truncation suffixes as
 * summary overflow (adversarial #954). Suffix-only; never throws.
 */
function peelCheckpointDecorations(summary: string): {
  head: string;
  wasTruncated: boolean;
  priorOmitted: number;
} {
  let s = summary;
  let priorOmitted = 0;
  const omittedMatch = s.match(FILES_OMITTED_SUFFIX_RE);
  if (omittedMatch) {
    const n = Number.parseInt(omittedMatch[1] ?? '', 10);
    if (Number.isFinite(n) && n > 0) priorOmitted = n;
    s = s.slice(0, s.length - omittedMatch[0].length);
  }
  let wasTruncated = false;
  if (s.endsWith(TRUNCATION_SUFFIX)) {
    wasTruncated = true;
    s = s.slice(0, s.length - TRUNCATION_SUFFIX.length);
  }
  return { head: s, wasTruncated, priorOmitted };
}

/**
 * Bound the summary to `COMPACTION_SUMMARY_MAX_CHARS` by whole code points
 * (never split a surrogate pair), appending an explicit marker when a
 * code point was actually dropped. Trim, don't omit — truncate, never drop.
 * UTF-16 `.length <= cap` is a valid fast path (code-point count cannot
 * exceed UTF-16 length). The overflow path walks code points so an
 * astral-heavy summary whose code-point count is still ≤ cap is not
 * stamped with a lying truncation marker (adversarial #953). Pure, never
 * throws.
 */
function boundSummary(summary: string): string {
  const max = COMPACTION_SUMMARY_MAX_CHARS;
  if (summary.length <= max) return summary;
  let units = 0;
  let cps = 0;
  for (const ch of summary) {
    if (cps === max) {
      return `${summary.slice(0, units)}${TRUNCATION_SUFFIX}`;
    }
    units += ch.length;
    cps += 1;
  }
  return summary;
}

/**
 * Drop paths that cannot sit on a single `Files read/modified:` line without
 * breaking Goal 4 honesty (adversarial #953). Same C0 / DEL / U+2028 / U+2029
 * class as `sanitizeReminderPath` (#943). Trim; empty after trim → drop.
 * Invalid paths are dropped, not counted as cap-omitted.
 */
function sanitizeCompactionPath(raw: string): string | undefined {
  const p = raw.trim();
  if (!p) return undefined;
  if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(p)) return undefined;
  return p;
}

/**
 * Bound the files-touched list to `COMPACTION_FILES_TOUCHED_MAX` entries —
 * keep the NEWEST paths (last occurrence wins so a re-read is not dropped;
 * adversarial #953), drop the oldest, skip non-string / empty / control-char
 * entries. Returns the bound list + the omitted count for the honest marker.
 * Pure.
 */
function boundFilesTouched(paths: readonly unknown[]): {
  paths: string[];
  omitted: number;
} {
  // Unique by last occurrence, preserving last-seen order.
  const clean: string[] = [];
  const seen = new Set<string>();
  for (let i = paths.length - 1; i >= 0; i--) {
    const p = paths[i];
    if (typeof p !== 'string') continue;
    const s = sanitizeCompactionPath(p);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    clean.push(s);
  }
  clean.reverse();
  if (clean.length <= COMPACTION_FILES_TOUCHED_MAX) {
    return { paths: clean, omitted: 0 };
  }
  const kept = clean.slice(clean.length - COMPACTION_FILES_TOUCHED_MAX);
  return { paths: kept, omitted: clean.length - COMPACTION_FILES_TOUCHED_MAX };
}

/**
 * Build the typed compaction checkpoint (plan #948). Enforces the caps table:
 *  - `summary` → `COMPACTION_SUMMARY_MAX_CHARS` (code-point-safe head +
 *    explicit `… [summary truncated]` marker),
 *  - `filesTouched` → `COMPACTION_FILES_TOUCHED_MAX` entries (keep NEWEST
 *    by last occurrence, non-strings / control-char paths dropped) — the
 *    omitted count is stored on `summary` (checkpoint shape has no `omitted`
 *    field) so it survives a seed that does not go through `renderSummaryRow`,
 *  - `retainedTail` → re-paired with `rePairModelMessages` (the cut never
 *    leaves an orphan tool-result / open call on the tail either).
 * Pure, never throws. A planted/hostile tail is still row-typed here; the
 * phase-2 read seam re-validates + re-pairs on read (parent edge-case lock).
 * **Idempotent on its own output** (adversarial #954): a second call peels
 * the baked truncation / omitted-count suffixes, re-caps the head, and
 * re-applies honesty (`omitted = filesOverflow ? n : peeledPrior`) so a
 * persist→seed round-trip cannot drop `… (N earlier paths omitted)` or
 * stamp a lying `… [summary truncated]` on an at-cap head whose extra
 * bytes were the honesty suffix.
 */
export function buildCheckpoint(
  input: CompactionSummaryInput,
  tail: ReadonlyArray<ModelMessageRow>,
): CompactionCheckpoint {
  const { paths, omitted } = boundFilesTouched(input.filesTouched);
  const peeled = peelCheckpointDecorations(input.summary);
  let summary = boundSummary(peeled.head);
  // At-cap heads do not re-grow the truncation marker (`boundSummary` only
  // stamps when a code point was dropped THIS call). Re-apply a peeled
  // marker so a prior overflow stays honest.
  if (peeled.wasTruncated && !summary.endsWith(TRUNCATION_SUFFIX)) {
    summary = `${summary}${TRUNCATION_SUFFIX}`;
  }
  const retainedTail = rePairModelMessages([...tail]);
  // Files already at the cap (a previous `buildCheckpoint` output) report
  // `omitted=0`; keep the peeled count. A live overflow wins so a planted
  // over-cap list still bakes the true drop.
  const omitCount = omitted > 0 ? omitted : peeled.priorOmitted;
  const summaryWithFiles =
    omitCount > 0
      ? `${summary}\n${FILES_TOUCHED_PREFIX} … (${omitCount} earlier paths omitted)`
      : summary;
  return { summary: summaryWithFiles, filesTouched: paths, retainedTail };
}

/**
 * Render the labeled model-facing summary row (parent #947 Goal 4 honesty
 * lock, plan #948): a `user`-role row whose content is
 * `Summary of earlier session (compacted, not live assistant prose):
 * <summary>` followed by a `Files read/modified:` line listing
 * `filesTouched`. NEVER an assistant row; the canvas paints nothing new
 * (server-only row). Control-char / blank paths are dropped (adversarial
 * #953) so a summarizer-invented path cannot split the files line or smuggle
 * a second honesty label. The overflow marker `… (N earlier paths omitted)` is
 * NOT computed here — `buildCheckpoint` bakes it into `checkpoint.summary`
 * because the locked checkpoint shape has no omitted field. Empty summary
 * still renders the label (an honest empty summary, never prose).
 * Pure, never throws.
 */
export function renderSummaryRow(
  summary: string,
  filesTouched: readonly string[],
): ModelMessageRow {
  const lines: string[] = [`${COMPACTION_SUMMARY_LABEL} ${summary}`];
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const p of filesTouched) {
    const s = sanitizeCompactionPath(p);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    cleaned.push(s);
  }
  if (cleaned.length > 0) {
    lines.push(`${FILES_TOUCHED_PREFIX} ${cleaned.join(', ')}`);
  }
  return { role: 'user', content: lines.join('\n\n') };
}

/**
 * Cut walk (plan #948, parent #947 Cut-boundary decision (b) — turn boundary,
 * then re-pair). Walk back from the newest row to the newest `user` boundary
 * whose retained tail (that user row → end) fits ALL the rails:
 *  - the **token budget** (`budgetTokens`, the #944 `foldBudgetTokens`
 *    result — estimated over the serialized tail),
 *  - the **row rail** (`maxRows`, default `MODEL_MSG_SEED_MAX_ROWS`),
 *  - the **byte rail** (`maxBytes`, default `MODEL_MSG_SEED_MAX_BYTES` —
 *    the Workflow run-arg carrier bound),
 *  - optionally the **span byte rail** (`maxSpanBytes` — phase 3
 *    `COMPACTION_SPAN_MAX_BYTES`): a tail that fits every other rail whose
 *    span is over the cap is **skipped**, not returned. The walk continues
 *    to an older user boundary (smaller span, larger tail). Plan #950 Caps:
 *    over-cap span → keep a larger retained tail, never feed the summarizer
 *    an unbounded prompt and never yield to `#944` trim while a legal
 *    shorter-span cut still exists (adversarial #955 follow-up 5).
 *
 * Tail size is monotonic on every rail as the boundary moves earlier
 * (adversarial #953): if the newest (smallest) tail misses, no earlier tail
 * can fit — return `null` immediately; do not stringify older suffixes
 * (the #945 17s linear-drop class). A span-over-cap on a *fitting* tail
 * is not a miss — `continue`. A later tail miss still ends the walk.
 *
 * The tail must contain at least one row (the boundary `user` row itself)
 * and the span must be non-empty for a cut to exist: a cut whose span would
 * be empty (the whole projection already fits) or whose only boundary is
 * row 0 (no compactable history) returns `null` — no compact. When NO user
 * boundary yields a fitting tail (a single user turn heavier than the
 * budget), returns `null` — never fabricate a cut inside a turn.
 *
 * BOTH sides are re-paired with `rePairModelMessages` so the cut never
 * leaves an orphan tool-result / open assistant call on either side
 * (parent Goal 3). Token estimate uses `CONTEXT_CHARS_PER_TOKEN` (the #944
 * ratio — never a second estimator). Pure, never throws.
 */
export function findCompactionCut(
  rows: ReadonlyArray<ModelMessageRow>,
  budgetTokens: number,
  opts?: {
    maxRows?: number;
    maxBytes?: number;
    /** Override the estimator ratio (tests). Defaults to CONTEXT_CHARS_PER_TOKEN. */
    charsPerToken?: number;
    /**
     * Summarizer-input ceiling (plan #950 `COMPACTION_SPAN_MAX_BYTES`).
     * Absent / non-positive → no span rail (phase-1 tests unchanged).
     */
    maxSpanBytes?: number;
  },
): CompactionCut | null {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return null;
  const maxRows = opts?.maxRows ?? MODEL_MSG_SEED_MAX_ROWS;
  const maxBytes = opts?.maxBytes ?? MODEL_MSG_SEED_MAX_BYTES;
  const ratio =
    opts?.charsPerToken && opts.charsPerToken > 0
      ? opts.charsPerToken
      : CONTEXT_CHARS_PER_TOKEN;
  const maxSpanBytes =
    opts?.maxSpanBytes !== undefined &&
    Number.isFinite(opts.maxSpanBytes) &&
    opts.maxSpanBytes > 0
      ? opts.maxSpanBytes
      : undefined;

  const n = rows.length;
  if (n === 0) return null;

  // Candidate boundaries: indexes of `user` rows strictly inside the array
  // (index 0 is not a boundary — cutting there leaves an empty span).
  const boundaries: number[] = [];
  for (let i = 1; i < n; i++) {
    if (rows[i].role === 'user') boundaries.push(i);
  }
  if (boundaries.length === 0) return null;

  // Newest boundary whose tail fits every rail AND whose span fits the
  // optional span ceiling. Tail miss → null (monotonic). Span-over-cap on
  // a fitting tail → continue (older boundary, smaller span).
  for (let b = boundaries.length - 1; b >= 0; b--) {
    const cutIndex = boundaries[b];
    const tail = rows.slice(cutIndex);
    if (tail.length > maxRows) return null;
    const json = JSON.stringify(tail);
    if (Math.ceil(json.length / ratio) > budgetTokens) return null;
    if (utf8Bytes(json) > maxBytes) return null;
    const span = rePairModelMessages(rows.slice(0, cutIndex));
    if (
      maxSpanBytes !== undefined &&
      utf8Bytes(JSON.stringify(span)) > maxSpanBytes
    ) {
      continue;
    }
    return {
      cutIndex,
      span,
      tail: rePairModelMessages(tail),
    };
  }
  return null;
}


/**
 * Combined `start()` compact-args payload rail (adversarial #955 follow-up).
 * `span` + `retainedTail` is the full pre-trim seed; independently 2 MiB
 * rails compose to 4 MiB against the 4.5 MB Function ceiling. Pure, never
 * throws. `maxBytes` override is for tests.
 */
export function compactStartPayloadFits(
  compact: {
    span: unknown;
    retainedTail: unknown;
    filesTouched: unknown;
    budgetTokens: number;
  },
  maxBytes: number = COMPACTION_START_MAX_BYTES,
): boolean {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return false;
  try {
    return utf8Bytes(JSON.stringify(compact)) <= maxBytes;
  } catch {
    return false;
  }
}

/**
 * Live post-compact retained tail (adversarial #955 follow-up 3 / 5). Drop
 * the honesty-labeled summary row as the **leading** seed row, **not**
 * `findIndex` over the full live projection and not `slice(1)`.
 *
 * Compact success always pins the Goal 4 row at index 0. A this-turn user
 * whose prompt starts with `COMPACTION_SUMMARY_LABEL` is not the summary —
 * scanning the full array would drop that ask on a pin-miss projection
 * (adversarial #955 follow-up 5 Minor). When the label is absent from
 * `rows[0]`, the tail **is** the full live projection. Pure, never throws.
 */
export function livePostCompactTail(
  rows: ReadonlyArray<ModelMessageRow>,
): ModelMessageRow[] {
  const first = rows[0];
  if (
    first &&
    first.role === 'user' &&
    first.content.startsWith(COMPACTION_SUMMARY_LABEL)
  ) {
    return rows.slice(1);
  }
  return [...rows];
}

/**
 * Re-rail a live post-compact checkpoint so its JSON fits
 * `COMPACTION_CHECKPOINT_MAX_BYTES` (adversarial #955 follow-up). Drop-oldest
 * on `retainedTail` (keep newest = this turn) so the persist write succeeds
 * rather than fail-closing and leaving prefer-checkpoint on the prior
 * pointer (Goal 2 miss on re-compact). Pure, never throws.
 */
export function boundCheckpointForPersist(
  input: CompactionSummaryInput & { retainedTail: ReadonlyArray<ModelMessageRow> },
  maxBytes: number = COMPACTION_CHECKPOINT_MAX_BYTES,
): CompactionCheckpoint {
  const built = buildCheckpoint(input, input.retainedTail);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return built;
  const serialize = (tail: ReadonlyArray<ModelMessageRow>): string =>
    JSON.stringify({
      summary: built.summary,
      filesTouched: built.filesTouched,
      retainedTail: tail,
    });
  if (utf8Bytes(serialize(built.retainedTail)) <= maxBytes) return built;
  const envelope = utf8Bytes(serialize([]));
  const maxTailBytes = Math.max(1, maxBytes - envelope);
  const trimmed = trimModelMessagesToBudget(built.retainedTail, Number.MAX_SAFE_INTEGER, {
    maxBytes: maxTailBytes,
  });
  return {
    summary: built.summary,
    filesTouched: built.filesTouched,
    retainedTail: trimmed.rows,
  };
}

/**
 * The compaction-trigger helper module lives in `lib/agent/compactionBudget.ts`
 * (`shouldCompact`) — phase 1 ships it as its own unit (the plan's
 * implementation order step 3); it imports `estimateTokens` from #944's
 * `contextBudget`. `COMPACTION_RESERVE_TOKENS` is the Pi name for the
 * reserve already inside `foldBudgetTokens` — not subtracted again.
 */
export const __compactionModuleMarker = true;
