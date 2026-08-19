/**
 * Agent SSE event contract (docs/agent-stream.md).
 * Maps AI SDK streamText fullStream parts → redacted host-facing events.
 */

import type { ToolTraceEntry } from './runAgent';
import { mapProviderUsage, type UsageSummary } from './usageSummary';
import { flattenToolResultText } from './toolResultText';
import { redactSecrets, truncateSummary } from './redact';

export type AgentStreamEvent =
  | { type: 'tool_start'; name: string; id?: string }
  | {
      type: 'tool_result';
      name: string;
      ok: boolean;
      summary: string;
      preview?: string;
      /**
       * Confirmed `change_dir` cwd carried as a TYPED field, populated from the
       * raw (untruncated) tool result. Persistence must never re-derive this from
       * `summary`, which is hard-truncated at `TOOL_LINE_SALIENT_MAX` and would
       * corrupt long targets (adversarial review #470 Major).
       */
      changeDirCwd?: string;
      /**
       * Phase 2 (#627 / #625): successful `meta_sandbox_switch` target id
       * carried as a TYPED field from the raw (untruncated) tool result text.
       * The host applies this LIVE on the result event (mid-turn bind change),
       * before `done`. Absent on ERROR / non-switch tools / truncated summary.
       */
      activeSandboxId?: string;
    }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | {
      /**
       * Protocol v12 / phase 2 (#517): display-only skill attach/detach outcome.
       * Carries ONLY the slug + outcome — never a skill body (bodies stay
       * server-side in the model's system context). Emitted by the server at the
       * START of a turn (before the model), or alone on a NO-MODEL `/unskill`.
       */
      type: 'skill_attached';
      slug: string;
      action: 'attach' | 'detach';
      ok: boolean;
      reason?: string;
      /**
       * Phase 2 (#517 / adversarial-review Nit L6): the FINAL attached-skill set
       * for the session, carried identically on EVERY skill_attached event of a
       * turn so the host applies it last-writes-wins (never treats a missing
       * field on event 1 as *clear*). `[]` = explicit detach-all; OMITTED = the
       * field is absent (host leaves its existing set untouched). The host's
       * `SessionSnapshot.attachedSlugs` mirrors this so a host PUT persists it
       * as the reserved `meta.attachedSkills`.
       */
      attachedSlugs?: string[];
    }
  | {
      type: 'done';
      text: string;
      toolTrace?: ToolTraceEntry[];
      cwd?: string;
      /** Resolved active sandbox bind the turn ran against (FS tools bound). */
      sandboxId?: string;
      /**
       * Post-turn EFFECTIVE active sandbox bind — the `meta_sandbox_switch`
       * target when the turn switched, else the pre-turn `sandboxId`. The host
       * folds THIS onto the session (blocker B1 fix): persisting the pre-turn
       * `sandboxId` would overwrite the envelope write the switch just made.
       */
      activeSandboxId?: string;
      /**
       * Phase 3 (plan #539 + #628) — bounded provider-usage summary. The
       * conclusive reconcile after any mid-stream `usage` events (carried
       * separately). Present on the final `done` when the provider reported
       * usable token counts; absent on abort/cancel or when the provider
       * reported none — the `done.usage` REPLACES (never falls back to the
       * last live mid-stream value), so a completed turn where the provider
       * reports no final usage clears the context slot.
       */
      usage?: UsageSummary;
    }
  | {
      /**
       * Phase 3 (plan #628) — live provider usage. Emitted mid-stream when the
       * AI SDK reports **aggregate** usage on a `finish` part (`totalUsage`,
       * or v7 `usage`). `finish-step` is never a source — its per-step counts
       * are not a turn total. Non-empty only (never a clear/flicker). The host
       * folds the context slot immediately; `done.usage` is the final reconcile.
       */
      type: 'usage';
      usage: UsageSummary;
    }
  | { type: 'error'; error: string; status?: number };

export const AGENT_STREAM_ACCEPT = 'text/event-stream';
export const AGENT_STREAM_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

/** @deprecated No host live-tool cap — kept for test import stability (Infinity). */
export const LIVE_TOOL_LINES_MAX = Number.POSITIVE_INFINITY;

export function wantsAgentStream(req: Request): boolean {
  const accept = req.headers.get('accept') ?? '';
  return accept
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .some((p) => p === 'text/event-stream' || p.startsWith('text/event-stream;'));
}

export function encodeSseData(event: AgentStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Host canvas tool lines only — never dump full tool payloads (read_file bodies,
 * exec stdout, http bodies). Model still receives full results via the tool path.
 */
export const TOOL_LINE_SALIENT_MAX = 320;

/**
 * Per-tool cap for the bounded, redacted L2 `preview` fed into the `toolrun` v1
 * `detail` field (plan #353 / parent #352 decision C + B-source). Mirrors
 * `TOOL_TRACE_SUMMARY_MAX_CHARS` (100k). This is the per-tool character cap, not
 * the per-message cap: the host enforces a whole-group encoded-detail budget
 * (`lib/toolRun.ts` `TOOL_RUN_GROUP_DETAIL_ENC_MAX` + encode-time hard clamp) so
 * a multi-item streak of large previews can never overflow the 262 144-byte
 * ring/cloud message cap (adversarial review #359 Major).
 */
export const TOOL_RUN_PREVIEW_MAX_CHARS = 100_000;

/** A preview shorter than this adds nothing beyond the L1 one-liner — omit it. */
export const TOOL_RUN_PREVIEW_MIN_LEN = TOOL_LINE_SALIENT_MAX;

/** Head/tail line window for bounding a long tool body in the L2 preview. */
export const TOOL_RUN_PREVIEW_HEAD_LINES = 40;
export const TOOL_RUN_PREVIEW_TAIL_LINES = 10;

/**
 * Per-side head/tail line window for a str_replace two-sided audit diff.
 * Each side (old / new) is windowed independently so the `-old_string` and
 * `+new_string` headers are always in their side's head — a 40/10 window on the
 * concatenated block would collapse the second-side header + content-start into
 * the middle gap for a normal function-sized replace (adversarial review #684
 * Major R1).
 */
export const STR_REPLACE_SIDE_HEAD_LINES = 20;
export const STR_REPLACE_SIDE_TAIL_LINES = 6;

/**
 * Apply a head/tail line window to the given lines, returning the joined string.
 * When the total fits, the full block is returned; otherwise head + `… (N more
 * lines)` + tail.
 */
function windowSideLines(lines: string[], head: number, tail: number): string {
  if (lines.length <= head + tail) return lines.join('\n');
  const headText = lines.slice(0, head).join('\n');
  const tailText = lines.slice(-tail).join('\n');
  const skipped = lines.length - head - tail;
  return `${headText}\n… (${skipped} more lines)\n${tailText}`;
}

/**
 * Build a preview for a str_replace tool result carrying a two-sided old→new
 * diff block. The body MUST have the shape:
 *
 *   str_replace <path> …<status>
 *   -old_string
 *   <old content>
 *   +new_string
 *   <new content>
 *
 * We window each side independently so both headers and the start of each
 * side's content are always visible, even when the concatenated block would
 * exceed the generic 40/10 window and drop the `+new_string` header into the
 * middle gap.
 */
function buildStrReplacePreview(body: string): string | undefined {
  const lines = body.split('\n');
  // Need at least: status line + -old_string + +new_string + something.
  if (lines.length < 4) return undefined;

  const oldMarker = lines.indexOf('-old_string');
  const newMarker = lines.indexOf('+new_string');
  // Markers must be present and in order: status (line 0) < oldMarker < newMarker.
  if (oldMarker < 1 || newMarker < oldMarker + 1) return undefined;

  const statusLine = lines[0]!;

  // Old side: lines after -old_string, before +new_string.
  const oldLines = lines.slice(oldMarker + 1, newMarker);
  const oldBlock = `-old_string\n${windowSideLines(oldLines, STR_REPLACE_SIDE_HEAD_LINES, STR_REPLACE_SIDE_TAIL_LINES)}`;

  // New side: lines after +new_string.
  const newLines = lines.slice(newMarker + 1);
  const newBlock = `+new_string\n${windowSideLines(newLines, STR_REPLACE_SIDE_HEAD_LINES, STR_REPLACE_SIDE_TAIL_LINES)}`;

  return `${statusLine}\n${oldBlock}\n${newBlock}`;
}

/**
 * Build the bounded, redacted L2 `preview` for a `tool_result` from already
 * flattened + redacted tool output. Head/tail are taken from the FULL output
 * (first `HEAD` lines / last `TAIL` lines) joined by `… (M more lines)` and only
 * then is the assembled preview char-capped at `TOOL_RUN_PREVIEW_MAX_CHARS` — so
 * the L2 "tail" is always the real end-of-output, never a slice of a truncated
 * prefix (adversarial review #359 Major). Returns `undefined` (not a
 * pretend-expand) when the output is a short single-line result that adds
 * nothing beyond the L1 one-liner — the host then keeps the static label path
 * (no blank expander). Never raw MCP envelopes.
 *
 * str_replace two-sided diffs get per-side windows (STR_REPLACE_SIDE_HEAD_LINES
 * / STR_REPLACE_SIDE_TAIL_LINES) so both `-old_string` and `+new_string` headers
 * are always visible — the generic 40/10 would collapse the second-side header
 * for a function-sized replace (adversarial review #684 Major R1).
 */
export function buildToolPreview(redacted: string): string | undefined {
  const norm = (redacted ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, '    ')
    .trim();
  if (!norm) return undefined;
  const lines = norm.split('\n');
  // Short single-line result adds nothing beyond the L1 one-liner — omit.
  if (lines.length === 1 && norm.length <= TOOL_RUN_PREVIEW_MIN_LEN) return undefined;

  // str_replace two-sided diff — per-side windows (see fn doc).
  if (
    lines.length >= 4 &&
    /^str_replace\s/.test(lines[0]!) &&
    lines.includes('-old_string') &&
    lines.includes('+new_string')
  ) {
    return buildStrReplacePreview(norm);
  }

  const HEAD = TOOL_RUN_PREVIEW_HEAD_LINES;
  const TAIL = TOOL_RUN_PREVIEW_TAIL_LINES;
  // Line-window fits — no middle collapse, just char-cap the whole block
  // (which ends on the real tail line; there is no mid-file "tail" here).
  if (lines.length <= HEAD + TAIL) {
    return capPrefix(norm, TOOL_RUN_PREVIEW_MAX_CHARS);
  }

  // Collapse on the FULL output: real first HEAD lines + real last TAIL lines.
  const headText = lines.slice(0, HEAD).join('\n');
  const tailText = lines.slice(-TAIL).join('\n');
  const skipped = lines.length - HEAD - TAIL;
  const sep = `\n… (${skipped} more lines)\n`;
  const body = `${headText}${sep}${tailText}`;
  if (body.length <= TOOL_RUN_PREVIEW_MAX_CHARS) return body;

  // Head+tail text alone exceeds the cap (a few huge lines). Keep the TRUE tail
  // and fold the head down to fit (each side caps with an explicit `…`); never
  // show a "tail" that is really a sliced prefix.
  const tailBudget = Math.max(0, TOOL_RUN_PREVIEW_MAX_CHARS - sep.length);
  const keptTail = capPrefix(tailText, tailBudget);
  const remaining = TOOL_RUN_PREVIEW_MAX_CHARS - sep.length - keptTail.length;
  const keptHead = capPrefix(headText, remaining);
  return `${keptHead}${sep}${keptTail}`;
}

/** Keep the leading part of `s` within `max` chars, appending an explicit `…`. */
function capPrefix(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Extract short, tool-aware highlights for the harness System line.
 * Full `resultText` is for the model; this is display-only.
 */
export function salientToolBits(name: string, resultText: string): string {
  const text = (resultText ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  // Errors / timeouts: first line only (no body after ERROR).
  if (/^ERROR\b/i.test(text) || /\bTIMED_OUT\b/.test(text.split('\n')[0] ?? '')) {
    return text.split('\n')[0]!.replace(/\s+/g, ' ').trim();
  }

  // change_dir target: ok cwd=...
  const cdM = text.match(/^change_dir\s+(\S+):\s+ok\s+cwd=(\S+)/i);
  if (cdM || name === 'change_dir') {
    if (cdM) return `${cdM[1]} · cwd=${cdM[2]}`;
    return text.replace(/\s+/g, ' ').trim().slice(0, TOOL_LINE_SALIENT_MAX);
  }

  // pwd: path
  const pwdM = text.match(/^pwd:\s+(\S+)/i);
  if (pwdM || name === 'pwd') {
    if (pwdM) return pwdM[1]!;
    return text.replace(/\s+/g, ' ').trim().slice(0, TOOL_LINE_SALIENT_MAX);
  }

  // read_file path (truncated)? (cwd=...)?:\n<body>
  const readM = text.match(
    /^read_file\s+(\S+)((?:\s*\(truncated\))?)((?:\s+cwd=\S+)?)\s*:\s*\n?([\s\S]*)$/i,
  );
  if (readM || name === 'read_file' || /(^|_)read_file$/i.test(name)) {
    if (readM) {
      const path = readM[1]!;
      const trunc = (readM[2] ?? '').includes('truncated') ? ' truncated' : '';
      const cwdBit = (readM[3] ?? '').trim();
      const body = readM[4] ?? '';
      const lineCount = body.length === 0 ? 0 : body.split('\n').length;
      const cwd = cwdBit ? ` · ${cwdBit}` : '';
      return `${path}${trunc}${cwd} · ${lineCount} lines · ${body.length} B`;
    }
    // Unknown shape — stats only
    const lineCount = text.split('\n').length;
    return `${lineCount} lines · ${text.length} B`;
  }

  // list_dir path (cwd=...)?: N entries — names…
  const listM = text.match(
    /^list_dir\s+(\S+)(?:\s+cwd=\S+)?:\s+(\d+)\s+entries(?:\s+[—\-]\s+([\s\S]*))?$/i,
  );
  if (listM || name === 'list_dir') {
    if (listM) {
      const path = listM[1]!;
      const n = listM[2]!;
      const names = (listM[3] ?? '').replace(/\s+/g, ' ').trim();
      if (names && names.length <= 72) return `${path}: ${n} entries — ${names}`;
      return `${path}: ${n} entries`;
    }
  }

  // write_file path (cwd=...)?: ok bytes=N
  const writeM = text.match(
    /^write_file\s+(\S+)(?:\s+cwd=\S+)?:\s+ok\s+bytes=(\d+)/i,
  );
  if (writeM || name === 'write_file') {
    if (writeM) return `${writeM[1]} · ${writeM[2]} B written`;
  }

  // str_replace path (cwd=...)?: ok replacements=N bytes=M
  const repM = text.match(
    /^str_replace\s+(\S+)(?:\s+cwd=\S+)?:\s+ok\s+replacements=(\d+)\s+bytes=(\d+)/i,
  );
  if (repM || name === 'str_replace') {
    if (repM) {
      const n = repM[2]!;
      const unit = n === '1' ? 'replacement' : 'replacements';
      return `${repM[1]} · ${n} ${unit} · ${repM[3]} B`;
    }
  }

  // exec cmd\nexit=N|TIMED_OUT\nstdout:\n…\nstderr:\n…
  if (/^exec\s+/i.test(text) || name === 'exec') {
    const head = (text.split('\n')[0] ?? 'exec').replace(/\s+/g, ' ').trim();
    const timedOut = /\bTIMED_OUT\b/.test(text);
    const exit = text.match(/\bexit=(-?\d+)/);
    const stdoutPart = text.includes('stdout:\n')
      ? text.split('stdout:\n')[1]?.split(/stderr:\n/)[0] ?? ''
      : '';
    const stderrPart = text.includes('stderr:\n')
      ? text.split('stderr:\n')[1] ?? ''
      : '';
    const outL = stdoutPart.trim() ? stdoutPart.replace(/\n$/, '').split('\n').length : 0;
    const errL = stderrPart.trim() ? stderrPart.replace(/\n$/, '').split('\n').length : 0;
    const bits: string[] = [head];
    if (timedOut) bits.push('TIMED_OUT');
    else if (exit) bits.push(`exit=${exit[1]}`);
    if (outL) bits.push(`stdout ${outL}L`);
    if (errL) bits.push(`stderr ${errL}L`);
    if (errL && exit && exit[1] !== '0') {
      const errFirst = stderrPart.trim().split('\n')[0]?.slice(0, 48);
      if (errFirst) bits.push(errFirst);
    }
    return bits.join(' · ');
  }

  // http_get URL → status flags\nbody
  const httpGet = text.match(
    /^http_get\s+(\S+)\s+→\s+(\d+)([^\n]*)\n?([\s\S]*)$/i,
  );
  if (httpGet || name === 'http_get') {
    if (httpGet) {
      let url = httpGet[1]!;
      if (url.length > 56) url = `${url.slice(0, 53)}…`;
      const status = httpGet[2]!;
      const flag = (httpGet[3] ?? '').trim();
      const body = httpGet[4] ?? '';
      return `${url} → ${status}${flag ? ` ${flag}` : ''} · ${body.length} B`;
    }
  }

  // http_head already one-line metadata
  if (/^http_head\b/i.test(text) || name === 'http_head') {
    return text.replace(/\s+/g, ' ').trim();
  }

  // Generic / MCP: no multi-line dumps — count + short first-line clip
  const lines = text.split('\n');
  if (lines.length > 1 || text.length > 100) {
    const first = lines[0]!.replace(/\s+/g, ' ').trim().slice(0, 72);
    const ellip = lines[0]!.replace(/\s+/g, ' ').trim().length > 72 ? '…' : '';
    return `${lines.length} lines · ${text.length} B · ${first}${ellip}`;
  }

  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extract the confirmed workspace-relative cwd from the RAW `change_dir` tool
 * result, only from a strict success marker. The tool emits
 * `change_dir <path>: ok cwd=<path>` on success and `ERROR change_dir: …` on
 * failure; any other shape → `undefined`. This is the structured carrier used to
 * attach the typed `tool_result.changeDirCwd` (stream) and `ToolTraceEntry.cwd`
 * (JSON) so host persistence never depends on the truncated display summary
 * (adversarial review #470 Major).
 */
export function changeDirSuccessCwd(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim();
  if (!t || /^ERROR\b/i.test(t)) return undefined;
  const m = t.match(/^change_dir\s+(\S+):\s*ok\s+cwd=(\S+)\s*$/i);
  if (!m) return undefined;
  return m[2];
}

/**
 * Parse a successful `meta_sandbox_switch` tool RESULT TEXT to the switched-to
 * id. The tool emits `switched active sandbox to id=<id> tools=[...]` only on a
 * persisted write; `undefined` on ERROR / any other shape.
 *
 * Defined here (pure, no server deps) so the client-side `agentStream.ts`
 * `mapFullStreamPart` can extract the typed `activeSandboxId` for the
 * `tool_result` event. `metaSandboxTools.ts` re-imports it for the JSON-path
 * step-result parser (`metaSandboxSwitchTargetId`).
 */
export function metaSandboxSwitchActiveId(
  raw: string | undefined,
): string | undefined {
  const t = (raw ?? '').trim();
  if (!t || /^ERROR\b/i.test(t)) return undefined;
  const m = t.match(/^switched active sandbox to id=(\S+)\s+tools=/i);
  if (!m) return undefined;
  return m[1];
}

export function summarizeToolLine(
  name: string,
  resultText: string,
  ok: boolean,
  secrets: Array<string | undefined | null> = [],
): string {
  // System kind only — do not use Error/EMBER for routine tool failures.
  const status = ok ? '✓ ok' : '✗ failed';
  const redacted = redactSecrets(resultText ?? '', secrets);
  const bits = salientToolBits(name, redacted);
  if (!bits) {
    return truncateSummary(`${name} · ${status}`, TOOL_LINE_SALIENT_MAX);
  }
  return truncateSummary(`${name} · ${status} · ${bits}`, TOOL_LINE_SALIENT_MAX);
}

function toolNameOf(part: { toolName?: unknown }): string {
  return typeof part.toolName === 'string' && part.toolName ? part.toolName : 'tool';
}

function toolIdOf(part: { toolCallId?: unknown }): string | undefined {
  return typeof part.toolCallId === 'string' && part.toolCallId
    ? part.toolCallId
    : undefined;
}

/**
 * Map one AI SDK fullStream part to zero or more agent events.
 * Reasoning: reasoning-delta / reasoning text parts → reasoning_delta.
 * reasoning-start / reasoning-end / reasoning-file are ignored (v1).
 */
export function mapFullStreamPart(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  part: any,
  secrets: Array<string | undefined | null> = [],
): AgentStreamEvent[] {
  if (!part || typeof part !== 'object') return [];
  const type = part.type;

  // Prefer tool-call (complete). tool-input-start is noisier and often duplicates.
  if (type === 'tool-call') {
    const name = toolNameOf(part);
    const id = toolIdOf(part);
    const ev: AgentStreamEvent = { type: 'tool_start', name: redactSecrets(name, secrets) };
    if (id) ev.id = id;
    return [ev];
  }

  if (type === 'tool-result') {
    const name = toolNameOf(part);
    const raw =
      part.output != null
        ? part.output
        : 'result' in part
          ? part.result
          : undefined;
    const asText = flattenToolResultText(raw);
    const redacted = redactSecrets(asText, secrets);
    const ok = !/^\s*ERROR\b/i.test(redacted) && !/\bTIMED_OUT\b/.test(redacted);
    const preview = buildToolPreview(redacted || '');
    const changeDirCwd =
      name === 'change_dir' && ok ? changeDirSuccessCwd(redacted) : undefined;
    const activeSandboxId =
      name === 'meta_sandbox_switch' && ok ? metaSandboxSwitchActiveId(redacted) : undefined;
    return [
      {
        type: 'tool_result',
        name: redactSecrets(name, secrets),
        ok,
        summary: summarizeToolLine(name, redacted || '', ok, secrets),
        ...(changeDirCwd !== undefined ? { changeDirCwd } : {}),
        ...(activeSandboxId !== undefined ? { activeSandboxId } : {}),
        ...(preview ? { preview } : {}),
      },
    ];
  }

  if (type === 'tool-error') {
    const name = toolNameOf(part);
    const raw =
      part.error != null
        ? part.error
        : part.output != null
          ? part.output
          : 'tool error';
    const asText = flattenToolResultText(raw);
    const redacted = redactSecrets(asText || 'ERROR tool-error', secrets);
    const preview = buildToolPreview(redacted);
    return [
      {
        type: 'tool_result',
        name: redactSecrets(name, secrets),
        ok: false,
        summary: summarizeToolLine(name, redacted, false, secrets),
        ...(preview ? { preview } : {}),
      },
    ];
  }

  if (type === 'reasoning-delta' || type === 'reasoning') {
    const text =
      typeof part.text === 'string'
        ? part.text
        : typeof part.delta === 'string'
          ? part.delta
          : '';
    if (!text) return [];
    return [{ type: 'reasoning_delta', text: redactSecrets(text, secrets) }];
  }

  if (type === 'text-delta') {
    const text =
      typeof part.text === 'string'
        ? part.text
        : typeof part.delta === 'string'
          ? part.delta
          : '';
    if (!text) return [];
    return [{ type: 'text_delta', text: redactSecrets(text, secrets) }];
  }

  // Phase 3 (plan #628) — live provider usage: emit a `usage` event when the
  // AI SDK reports aggregate usage on a `finish` part (the turn total).
  // `part.totalUsage` is the v6 name; v7 renames it to `part.usage` (scan
  // both). `finish-step` is NEVER emitted — its per-step counts are not a
  // turn aggregate and would flicker the context slot downward on multi-step
  // turns. Non-empty only → no clear/flicker when the provider reported no
  // usable token counts.
  if (type === 'finish') {
    const summary = mapProviderUsage(part.totalUsage ?? part.usage);
    if (summary) return [{ type: 'usage', usage: summary }];
    return [];
  }

  if (type === 'error') {
    const err = part.error;
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Stream error.';
    return [{ type: 'error', error: redactSecrets(msg, secrets) }];
  }

  return [];
}

/**
 * Consume fullStream + final text/steps into a complete event list (tests / collect).
 */
export async function collectAgentStreamEvents(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fullStream: AsyncIterable<any>;
  getFinalText: () => PromiseLike<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSteps?: () => PromiseLike<any[] | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  collectToolTrace: (result: { steps?: any[] }, secrets: Array<string | undefined | null>) => ToolTraceEntry[];
  secrets?: Array<string | undefined | null>;
}): Promise<AgentStreamEvent[]> {
  const secrets = opts.secrets ?? [];
  const events: AgentStreamEvent[] = [];
  try {
    for await (const part of opts.fullStream) {
      events.push(...mapFullStreamPart(part, secrets));
    }
    let text = redactSecrets(((await opts.getFinalText()) ?? '').trim(), secrets);
    const steps = opts.getSteps ? await opts.getSteps() : undefined;
    const toolTrace = opts.collectToolTrace({ steps }, secrets);
    events.push({
      type: 'done',
      text,
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'ResponseAborted')) {
      events.push({ type: 'error', error: 'Request cancelled.', status: 499 });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      events.push({ type: 'error', error: redactSecrets(msg, secrets) });
    }
  }
  return events;
}
