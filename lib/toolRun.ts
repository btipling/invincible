/**
 * Tool-run aggregation payload (protocol v10, bridge kind 6).
 *
 * The host owns the reachable `/api/agent` SSE and knows the structured
 * `tool_result.ok`, so it aggregates each uninterrupted tool streak into ONE
 * display-only transcript message (`MessageKind.ToolRun`, session role
 * `tool_run`). The Wasm harness decodes this versioned, delimiter-encoded
 * payload and paints an expandable "N tools called" control.
 *
 * Format (protocol v10 / TOOL_RUN_VERSION 1):
 *
 *   toolrun\t1\t{ok}/{fail}/{pending}     header: ok/fail/pending counts (total = sum)
 *   {id}\t{status}\t{name}\t{brief}\t{detail}
 *   ...
 *
 * `status ∈ running | ok | fail`. Fields `name`/`brief`/`detail` are escaped for
 * `\t`, `\n`, `\\`; decode fails open (returns null) on a bad header or unknown
 * version so the caller renders the raw body as plain text and never crashes.
 *
 * See also `native/harness/src/rich/toolrun.zig` (mirror decoder, host-tested).
 */

export const TOOL_RUN_VERSION = 1 as const;

/**
 * Max items stored in a single `tool_run` group; when a group would exceed this
 * the host rolls a new group (counts stay exact across groups). Separately, the
 * whole group is encoded into ONE bridge message that must stay under
 * `TOOL_RUN_MSG_HARD_MAX` (Wasm `MAX_MSG_LEN` = 262 144), so `addToolResult` /
 * `buildTraceGroups` also enforce a whole-group encoded-`detail` budget
 * (`TOOL_RUN_GROUP_DETAIL_ENC_MAX`) that clips or omits previews so a multi-item
 * streak carrying several large previews can never overflow the ring/cloud cap.
 */
export const TOOL_RUN_ITEMS_MAX = 200 as const;

/**
 * Hard cap for a single encoded `tool_run` payload — matches the Wasm ring
 * `MAX_MSG_LEN` and the cloud `262 144`-byte-per-msg cap. `encodeToolRun` never
 * emits a payload longer than this.
 */
export const TOOL_RUN_MSG_HARD_MAX = 262_144;

/**
 * Whole-group budget (in TLS-escaped chars) for the summed `detail` fields of a
 * group. The encoded payload also carries the header, per-item `name`/`brief`,
 * the tab/newline separators, and escape inflation, so this value leaves
 * `262 144 − 229 376 = 32 768` bytes of headroom for that overhead. When a
 * group's accumulated details would exceed this, later previews
 * are clipped to the remaining budget (with an explicit `…`) or omitted entirely
 * (static label) — never a silent mid-payload clip.
 */
export const TOOL_RUN_GROUP_DETAIL_ENC_MAX = 229_376;

export type ToolRunStatus = 'running' | 'ok' | 'fail';

export interface ToolRunItem {
  /** 1-based id within the group — stable key for per-item expand state. */
  id: number;
  status: ToolRunStatus;
  name: string;
  /** One-liner level-1 preview (single line, ≤ BRIEF_PREVIEW_MAX chars). */
  brief: string;
  /** Level-2 detail — the bounded, redacted `preview` head/tail (stream path)
   * or the one-line summary (JSON fallback) when it meaningfully enriches
   * `brief`; empty for short single-line results (Wasm paints a static label,
   * no blank expander). Subject to the whole-group encode budget. */
  detail: string;
}

/**
 * Level-1 preview cap. Level-2 `detail` is the bounded server-side `preview`
 * (stream) or the one-line summary (JSON fallback) when it genuinely exceeds
 * this one-liner, so the expand-to-detail tier adds real content; the collapsed
 * `brief` is a collapse-whitespace preview. Empty/all-whitespace summaries fall
 * back to a name+status one-liner.
 */
export const BRIEF_PREVIEW_MAX = 64 as const;

function compactPreview(s: string): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > BRIEF_PREVIEW_MAX ? `${t.slice(0, BRIEF_PREVIEW_MAX)}…` : t;
}

/**
 * The colored status glyph column is the single symbol status channel for a
 * tool row (adversarial review #358 Major). The tool summary still embeds a
 * `✓`/`✗` mark (`name · ✓ ok · …`) — those code points are NOT in the Noto text
 * faces the L1 expander label and L2 detail body paint with (only the mark
 * column uses the DejaVu Sans Symbols face that covers them), so leaving them in
 * `brief`/`detail` rendered `.notdef` tofu right beside the real glyph. Rewrite
 * the deterministic `· ✓ ok` / `· ✗ failed` token to its ASCII letters only; the
 * symbol glyph lives in the mark column alone.
 */
export function asciiStatus(s: string): string {
  return s
    .replace(/·\s*✓\s*ok/g, '· ok')
    .replace(/·\s*✗\s*failed/g, '· failed');
}

/**
 * The L1 expander label is painted by dvui as a SINGLE Noto run — it has no
 * per-glyph symbol fallback the way the L2 body does (`mixed_text.addTextMixed`
 * routes symbols/emoji to a DejaVu symbols / OpenMoji face). So beyond the
 * `✓`/`✗` status marks, the collapsed `brief` must not carry any symbol the Noto
 * heading face lacks. The deterministic summary uses `→` (http_get lines), which
 * is NOT in Noto — map it to ASCII for the collapsed preview only. The expanded
 * L2 detail keeps the real glyph (rendered by the symbols-aware body).
 */
function briefSafe(s: string): string {
  return s.replace(/→/g, '->');
}

export type ToolRunCounts = {
  ok: number;
  fail: number;
  pending: number;
};

export interface ToolRunPayload {
  ok: number;
  fail: number;
  pending: number;
  items: ToolRunItem[];
}

/** Mutable in-turn aggregation state (host `harnessChat.runHarnessTurn`). */
export interface ToolRunGroup {
  items: ToolRunItem[];
  /** Running TLS-escaped-char total of all items' `detail` fields (group budget). */
  detailEncUsed: number;
}

export function createToolRunGroup(): ToolRunGroup {
  return { items: [], detailEncUsed: 0 };
}

/** True once a group stores TOOL_RUN_ITEMS_MAX items (roll to a new group). */
export function toolRunIsFull(group: ToolRunGroup): boolean {
  return group.items.length >= TOOL_RUN_ITEMS_MAX;
}

/**
 * True when the group already has a `running` item with this name. Used to
 * decide whether a `tool_result` grows the group (no running match → new item).
 */
export function hasRunningTool(group: ToolRunGroup, name: string): boolean {
  for (let i = group.items.length - 1; i >= 0; i--) {
    const it = group.items[i];
    if (it && it.status === 'running' && it.name === name) return true;
  }
  return false;
}

export function addToolStart(group: ToolRunGroup, name: string): void {
  group.items.push({
    id: group.items.length + 1,
    status: 'running',
    name,
    brief: `${name} · running…`,
    detail: storeDetail(group, ''),
  });
}

/**
 * Clip `s` so its TLS-encoded length (`esc`) fits within `budget`, keeping a
 * leading prefix plus a visible `…` marker. Bounded by the group encode budget —
 * never a silent mid-payload clip. `'…'` is not escaped by `esc()`, so it
 * counts 1 char.
 */
function clipToEncBudget(s: string, budget: number): string {
  if (budget < 2) return '';
  const keep = budget - 1; // room for the marker
  let enc = 0;
  let cut = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const inc = c === '\\' || c === '\n' || c === '\t' ? 2 : 1;
    if (enc + inc > keep) break;
    enc += inc;
    cut = i + 1;
  }
  if (cut === 0) return '…';
  return `${s.slice(0, cut)}…`;
}

/**
 * Store an item's `detail` against the group's encoded-detail budget
 * (`TOOL_RUN_GROUP_DETAIL_ENC_MAX`). Returns the value to persist: the full
 * `detail` when it and the existing items fit, a clipped prefix (with `…`) when
 * only part fits, or `''` when no room remains → Wasm paints a static label (no
 * pretend expand, never a silent overflow past `TOOL_RUN_MSG_HARD_MAX`).
 * `prevDetail` lets an in-place replacement (completing a running item, or the
 * JSON-path overwrite) release the old bytes before charging the new ones.
 */
function storeDetail(
  group: ToolRunGroup,
  detail: string,
  prevDetail = '',
): string {
  const prevEnc = esc(prevDetail ?? '').length;
  const base = Math.max(0, group.detailEncUsed - prevEnc);
  if (!detail) {
    group.detailEncUsed = base;
    return '';
  }
  const remaining = TOOL_RUN_GROUP_DETAIL_ENC_MAX - base;
  if (remaining <= 0) {
    group.detailEncUsed = base;
    return '';
  }
  const enc = esc(detail).length;
  if (enc <= remaining) {
    group.detailEncUsed = base + enc;
    return detail;
  }
  const clipped = clipToEncBudget(detail, remaining);
  group.detailEncUsed = base + esc(clipped).length;
  return clipped;
}

/**
 * Level-2 `detail` for a tool row. Prefers the bounded `preview` (real
 * command/output detail from the backend tool_result) when it is meaningfully
 * richer than the collapsible L1 `brief`; otherwise returns empty so the Wasm
 * paints a static label instead of a duplicate-of-L1 blank expander (phase 3
 * #353 / parent #352 decision C).
 */
export function meaningfulDetail(
  summary: string,
  preview: string | undefined,
): string {
  const line = asciiStatus((summary ?? '').trim());
  const p = (preview ?? '').replace(/\r\n/g, '\n').trim();
  if (!p) return '';
  // No summary but a real preview → keep the preview (the backend only emits a
  // preview when it is richer than an L1 one-liner, so there is no pretend
  // expand and no silently dropped body — review #359 Minor).
  if (!line) return p;
  // Compare against the sanitized L1 brief (arrows already ASCII in brief) so a
  // `→`-bearing preview is not mistaken for the identical one-liner.
  const brief = briefSafe(compactPreview(line));
  // Identical to the collapsed one-liner (or the full summary) → no pretend expand.
  if (p === brief || p === line) return '';
  return p;
}

export function addToolResult(
  group: ToolRunGroup,
  name: string,
  ok: boolean,
  summary: string,
  preview?: string,
): void {
  const line = asciiStatus((summary ?? '').trim());
  const detail = meaningfulDetail(summary, preview);
  // Complete the most recent running item with the same name (in place), else
  // append a done item (e.g. a result for a start we never observed).
  for (let i = group.items.length - 1; i >= 0; i--) {
    const it = group.items[i];
    if (it && it.status === 'running' && it.name === name) {
      it.status = ok ? 'ok' : 'fail';
      it.brief = briefSafe(compactPreview(line)) || `${name} · ${ok ? 'ok' : 'failed'}`;
      it.detail = storeDetail(group, detail, it.detail);
      return;
    }
  }
  group.items.push({
    id: group.items.length + 1,
    status: ok ? 'ok' : 'fail',
    name,
    brief: briefSafe(compactPreview(line)) || `${name} · ${ok ? 'ok' : 'failed'}`,
    detail: storeDetail(group, detail),
  });
}

export function countToolRunItems(items: ToolRunItem[]): ToolRunCounts {
  let ok = 0;
  let fail = 0;
  let pending = 0;
  for (const it of items) {
    if (it.status === 'ok') ok++;
    else if (it.status === 'fail') fail++;
    else pending++;
  }
  return { ok, fail, pending };
}

/**
 * Build tool-run groups from a non-stream `agentResult.toolTrace`, chunking by
 * `TOOL_RUN_ITEMS_MAX`. Void/empty → empty array.
 */
export function buildTraceGroups(
  trace: { name: string; ok: boolean; summary: string }[] | undefined,
): ToolRunGroup[] {
  if (!trace?.length) return [];
  const groups: ToolRunGroup[] = [];
  let cur = createToolRunGroup();
  for (const entry of trace) {
    const name = entry.name || 'tool';
    const line = asciiStatus((entry.summary ?? '').trim());
    const runningMatch = cur.items.find(
      (it) => it.status === 'running' && it.name === name,
    );
    if (!runningMatch && cur.items.length >= TOOL_RUN_ITEMS_MAX) {
      groups.push(cur);
      cur = createToolRunGroup();
    }
    if (runningMatch) {
      runningMatch.status = entry.ok ? 'ok' : 'fail';
      runningMatch.brief =
        briefSafe(compactPreview(line)) || `${name} · ${entry.ok ? 'ok' : 'failed'}`;
      runningMatch.detail = storeDetail(cur, line, runningMatch.detail);
    } else {
      cur.items.push({
        id: cur.items.length + 1,
        status: entry.ok ? 'ok' : 'fail',
        name,
        brief:
          briefSafe(compactPreview(line)) || `${name} · ${entry.ok ? 'ok' : 'failed'}`,
        detail: storeDetail(cur, line),
      });
    }
  }
  if (cur.items.length > 0) groups.push(cur);
  return groups;
}

function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function unesc(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 't') {
        out += '\t';
        i++;
        continue;
      }
      if (n === 'n') {
        out += '\n';
        i++;
        continue;
      }
      if (n === '\\') {
        out += '\\';
        i++;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** Encode a non-empty group; returns null when there are no items. */
export function encodeToolRun(group: ToolRunGroup): string | null {
  if (group.items.length === 0) return null;
  const c = countToolRunItems(group.items);
  const lines: string[] = [
    `toolrun\t${TOOL_RUN_VERSION}\t${c.ok}/${c.fail}/${c.pending}`,
  ];
  for (const it of group.items) {
    lines.push(
      `${it.id}\t${it.status}\t${esc(it.name)}\t${esc(it.brief)}\t${esc(it.detail)}`,
    );
  }
  let out = lines.join('\n');
  // Hard backstop (adversarial review #359 Major): never emit a payload over the
  // ring/cloud cap. In normal operation the aggregation-time group detail budget
  // keeps us far under it; this only fires for pathological `name`/`brief`
  // escape bloat. It drops `detail` from trailing items in place (rows stay
  // 5-field aligned, counts unchanged) until the payload fits — an explicit
  // degradation, never a silent mid-payload clip.
  if (out.length > TOOL_RUN_MSG_HARD_MAX) {
    for (let i = lines.length - 1; i >= 1; i--) {
      const cols = lines[i]!.split('\t');
      if (cols.length === 5 && cols[4] !== '') {
        cols[4] = '';
        lines[i] = cols.join('\t');
        out = lines.join('\n');
        if (out.length <= TOOL_RUN_MSG_HARD_MAX) break;
      }
    }
  }
  return out;
}

/**
 * Decode a tool-run payload. Returns null (fail-open) on a malformed header or
 * unknown version; tolerantly skips malformed item lines.
 */
export function decodeToolRun(text: string): ToolRunPayload | null {
  if (!text) return null;
  const lines = text.split('\n');
  if (lines.length === 0) return null;
  const head = lines[0].split('\t');
  if (head.length < 3) return null;
  if (head[0] !== 'toolrun') return null;
  if (Number(head[1]) !== TOOL_RUN_VERSION) return null;
  const counts = head[2].split('/');
  // Parsed for header validity only — recount from the kept items below so a
  // hostile/dense blob's header can never disagree with what actually decodes
  // after the TOOL_RUN_ITEMS_MAX cap (review Minor).
  if (
    counts.length !== 3 ||
    !counts.every((c) => c !== undefined && c !== '' && Number.isInteger(Number(c)))
  ) {
    return null;
  }
  const items: ToolRunItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    // Defensive cap mirroring the host grouping bound (a restored blob could
    // carry more than TOOL_RUN_ITEMS_MAX; stop reading so a hostile/dense
    // payload can't force unbounded decode).
    if (items.length >= TOOL_RUN_ITEMS_MAX) break;
    const row = lines[i];
    if (!row) continue;
    const p = row.split('\t');
    if (p.length < 5) continue;
    const id = Number(p[0]);
    const status = p[1] as ToolRunStatus;
    if (status !== 'running' && status !== 'ok' && status !== 'fail') continue;
    items.push({
      id: Number.isInteger(id) && id > 0 ? id : i,
      status,
      name: unesc(p[2]),
      brief: unesc(p[3]),
      detail: unesc(p[4]),
    });
  }
  // Recount from the kept items so the header display can never disagree with
  // the decoded list after the TOOL_RUN_ITEMS_MAX cap (review Minor).
  const c = countToolRunItems(items);
  return { ok: c.ok, fail: c.fail, pending: c.pending, items };
}
