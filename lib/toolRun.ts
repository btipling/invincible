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
 * Max items stored in a single `tool_run` group. Keeps any one session message
 * well under the cloud `~262 KiB`/msg cap even for very long uninterrupted
 * agentic streaks; when a group would exceed this the host rolls a new group
 * (counts stay exact across groups).
 */
export const TOOL_RUN_ITEMS_MAX = 200 as const;

export type ToolRunStatus = 'running' | 'ok' | 'fail';

export interface ToolRunItem {
  /** 1-based id within the group — stable key for per-item expand state. */
  id: number;
  status: ToolRunStatus;
  name: string;
  /** One-liner level-1 preview (single line, ≤ BRIEF_PREVIEW_MAX chars). */
  brief: string;
  /** Full level-2 detail — the already-truncated per-tool summary (may be long). */
  detail: string;
}

/**
 * Level-1 preview cap. Level-2 `detail` keeps the full (already server-truncated)
 * tool summary; the collapsed `brief` is a collapse-whitespace preview so the
 * expand-to-detail tier genuinely adds the full text once a summary exceeds a
 * single short line. Empty/all-whitespace summaries fall back to a name+status
 * one-liner.
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
}

export function createToolRunGroup(): ToolRunGroup {
  return { items: [] };
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
    detail: '',
  });
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
  if (!line) return '';
  // Compare against the sanitized L1 brief (arrows already ASCII in brief) so a
  // `→`-bearing preview is not mistaken for the identical one-liner.
  const brief = briefSafe(compactPreview(line));
  const p = (preview ?? '').replace(/\r\n/g, '\n').trim();
  if (!p) return '';
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
      it.detail = detail;
      return;
    }
  }
  group.items.push({
    id: group.items.length + 1,
    status: ok ? 'ok' : 'fail',
    name,
    brief: briefSafe(compactPreview(line)) || `${name} · ${ok ? 'ok' : 'failed'}`,
    detail,
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
      runningMatch.detail = line;
    } else {
      cur.items.push({
        id: cur.items.length + 1,
        status: entry.ok ? 'ok' : 'fail',
        name,
        brief:
          briefSafe(compactPreview(line)) || `${name} · ${entry.ok ? 'ok' : 'failed'}`,
        detail: line,
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
  return lines.join('\n');
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
