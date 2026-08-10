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
  /** One-liner (name + salient args / running marker). */
  brief: string;
  /** Already-truncated per-tool summary. */
  detail: string;
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

export function addToolResult(
  group: ToolRunGroup,
  name: string,
  ok: boolean,
  summary: string,
): void {
  const line = (summary ?? '').trim();
  // Complete the most recent running item with the same name (in place), else
  // append a done item (e.g. a result for a start we never observed).
  for (let i = group.items.length - 1; i >= 0; i--) {
    const it = group.items[i];
    if (it && it.status === 'running' && it.name === name) {
      it.status = ok ? 'ok' : 'fail';
      it.brief = line;
      it.detail = line;
      return;
    }
  }
  group.items.push({
    id: group.items.length + 1,
    status: ok ? 'ok' : 'fail',
    name,
    brief: line,
    detail: line,
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
    const line = (entry.summary ?? '').trim();
    const runningMatch = cur.items.find(
      (it) => it.status === 'running' && it.name === name,
    );
    if (!runningMatch && cur.items.length >= TOOL_RUN_ITEMS_MAX) {
      groups.push(cur);
      cur = createToolRunGroup();
    }
    if (runningMatch) {
      runningMatch.status = entry.ok ? 'ok' : 'fail';
      runningMatch.brief = line;
      runningMatch.detail = line;
    } else {
      cur.items.push({
        id: cur.items.length + 1,
        status: entry.ok ? 'ok' : 'fail',
        name,
        brief: line,
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
  const ok = Number(counts[0]);
  const fail = Number(counts[1]);
  const pending = Number(counts[2]);
  if (!Number.isInteger(ok) || !Number.isInteger(fail) || !Number.isInteger(pending)) {
    return null;
  }
  const items: ToolRunItem[] = [];
  for (let i = 1; i < lines.length; i++) {
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
  return { ok, fail, pending, items };
}
