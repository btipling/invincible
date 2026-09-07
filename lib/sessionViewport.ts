/** Disposable display windows. Never use these rows as a transcript replacement or model seed. */
import type { AgentStreamEvent } from './agent/agentStream';
import type { SessionMessage, SessionRole } from './sessionStore';
import { sanitizeUsageSummary, decodeUsageMetaString } from './agent/usageSummary';
import {
  HARNESS_SESSION_MAX_MSG_BYTES, VIEWPORT_RESPONSE_MAX_BYTES,
  isRedisSafeOpaqueId, normalizeSessionCwd, parseAttachedSkills,
  sanitizeModelId, sanitizeReasoningEffort, sanitizeResolvedProvider,
  sanitizeTurnRunId, sanitizeTurnStatus, HARNESS_SESSION_MAX_META_BYTES,
  HARNESS_SESSION_MAX_ATTACHED_SKILLS, SKILL_SLUG_RE,
} from './sessionCloudCaps';
import { HARNESS_RING_MAX } from './sessionWindow';
import { sanitizeQueue } from './turnQueue';
import { addToolStart, addToolResult, createToolRunGroup, encodeToolRun, toolRunIsFull } from './toolRun';

const encoder = new TextEncoder();
export const VIEWPORT_HISTORY_NOTE = 'Recent history only; some earlier activity may be omitted.';
export const byteLength = (s: string): number => encoder.encode(s).byteLength;
export const objectRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** Bound before encoding; keep newest text and don't split UTF-8 code points. */
export function viewportExcerpt(text: string, max = HARNESS_SESSION_MAX_MSG_BYTES): string {
  const suffix = text.slice(-max);
  const bytes = encoder.encode(suffix);
  if (text.length === suffix.length && bytes.length <= max) return text;
  const marker = '[Earlier text omitted]\n';
  let start = Math.max(0, bytes.length - Math.max(0, max - byteLength(marker)));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return marker + new TextDecoder().decode(bytes.subarray(start));
}

const roles = new Set<SessionRole>(['user', 'assistant', 'system', 'error', 'tool_run', 'skill_attached']);
export function parseViewportRow(value: unknown, index: number): SessionMessage | undefined {
  const o = objectRecord(value);
  if (!o || !roles.has(o.role as SessionRole) || typeof o.text !== 'string') return;
  return {
    id: isRedisSafeOpaqueId(o.id) ? o.id : `view_${index}`,
    role: o.role as SessionRole, text: viewportExcerpt(o.text),
    at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
  };
}

export type ViewportCarriers = {
  cwd?: string; activeSandboxId?: string; selectedModel?: string; reasoningEffort?: string;
  resolvedProvider?: string; personaId?: string; attachedSlugs?: string[];
  usage?: ReturnType<typeof sanitizeUsageSummary>; turnRunId?: string;
  turnStatus?: ReturnType<typeof sanitizeTurnStatus>; queue?: string[];
};
export function viewportCarriers(meta: unknown, queue?: unknown): ViewportCarriers {
  const m = objectRecord(meta) ?? {};
  return {
    cwd: normalizeSessionCwd(m.logicalCwd),
    activeSandboxId: isRedisSafeOpaqueId(m.activeSandboxId) ? m.activeSandboxId : undefined,
    selectedModel: sanitizeModelId(m.selectedModel), reasoningEffort: sanitizeReasoningEffort(m.reasoningEffort),
    resolvedProvider: sanitizeResolvedProvider(m.resolvedProvider),
    personaId: isRedisSafeOpaqueId(m.personaId) ? m.personaId : undefined,
    attachedSlugs: typeof m.attachedSkills === 'string' && m.attachedSkills.length <= HARNESS_SESSION_MAX_META_BYTES
      ? parseAttachedSkills(m.attachedSkills).slice(0, HARNESS_SESSION_MAX_ATTACHED_SKILLS) : undefined,
    usage: typeof m.usage === 'string' ? decodeUsageMetaString(m.usage) : undefined,
    turnRunId: sanitizeTurnRunId(m.turnRunId), turnStatus: sanitizeTurnStatus(m.turnStatus),
    queue: sanitizeQueue(queue),
  };
}

export type ViewportView = {
  version: 1; sessionId: string; rows: SessionMessage[]; replace: boolean;
  source: 'stream_tail' | 'stored_head' | 'unavailable';
  historyComplete: false; incomplete: true; gap: boolean; hasEarlier: boolean;
  carriers: ViewportCarriers;
};

/** Linear row accounting; final caller supplies its actual serialized control scaffold. */
export function fitViewportRows(rows: readonly SessionMessage[], scaffold: object): SessionMessage[] {
  let remaining = VIEWPORT_RESPONSE_MAX_BYTES - byteLength(JSON.stringify(scaffold));
  const kept: SessionMessage[] = [];
  for (let i = rows.length - 1; i >= 0 && kept.length < HARNESS_RING_MAX; i--) {
    const row = rows[i];
    const size = byteLength(JSON.stringify(row)) + (kept.length > 0 ? 1 : 0);
    if (size > remaining) break;
    kept.push(row); remaining -= size;
  }
  return kept.reverse();
}

/** Parse ONE decoded stored frame, with an allowlist (never forward arbitrary JSON properties). */
export function parseViewportEvent(text: string): AgentStreamEvent | undefined {
  const normalized = text.replace(/\r\n/g, '\n');
  const blocks = normalized.trim().split('\n\n');
  if (blocks.length !== 1) return;
  const data = blocks[0].split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
  let raw: unknown;
  try { raw = JSON.parse(data); } catch { return; }
  return validateViewportEvent(raw);
}

export function validateViewportEvent(raw: unknown): AgentStreamEvent | undefined {
  const o = objectRecord(raw);
  if (!o) return;
  const str = (key: string): string | undefined => typeof o[key] === 'string' ? o[key] as string : undefined;
  switch (o.type) {
    case 'text_delta': case 'reasoning_delta':
      return typeof o.text === 'string' ? { type: o.type, text: o.text } : undefined;
    case 'tool_start':
      return typeof o.name === 'string' ? { type: o.type, name: o.name, id: str('id') } : undefined;
    case 'tool_result':
      return typeof o.name === 'string' && typeof o.ok === 'boolean' && typeof o.summary === 'string'
        ? { type: o.type, name: o.name, ok: o.ok, summary: o.summary, preview: str('preview'), id: str('id'),
          changeDirCwd: normalizeSessionCwd(o.changeDirCwd),
          activeSandboxId: isRedisSafeOpaqueId(o.activeSandboxId) ? o.activeSandboxId : undefined } : undefined;
    case 'provider': {
      const provider = sanitizeResolvedProvider(o.provider);
      return provider ? { type: o.type, provider } : undefined;
    }
    case 'usage': {
      const usage = sanitizeUsageSummary(o.usage);
      return usage ? { type: o.type, usage } : undefined;
    }
    case 'done': return typeof o.text === 'string' ? {
      type: o.type, text: o.text, finishReason: str('finishReason'), cwd: normalizeSessionCwd(o.cwd),
      activeSandboxId: isRedisSafeOpaqueId(o.activeSandboxId) ? o.activeSandboxId : undefined,
      sandboxId: isRedisSafeOpaqueId(o.sandboxId) ? o.sandboxId : undefined,
      usage: sanitizeUsageSummary(o.usage), resolvedProvider: sanitizeResolvedProvider(o.resolvedProvider),
    } : undefined;
    case 'error': return typeof o.error === 'string' ? { type: o.type, error: o.error,
      ...(typeof o.status === 'number' && Number.isInteger(o.status) ? { status: o.status } : {}) } : undefined;
    case 'skill_attached': return typeof o.slug === 'string' && SKILL_SLUG_RE.test(o.slug) &&
      (o.action === 'attach' || o.action === 'detach') && typeof o.ok === 'boolean'
      ? { type: o.type, slug: o.slug, action: o.action, ok: o.ok, reason: str('reason'),
        ...(Array.isArray(o.attachedSlugs) ? { attachedSlugs: o.attachedSlugs
          .slice(0, HARNESS_SESSION_MAX_ATTACHED_SKILLS).filter((s): s is string => typeof s === 'string' && SKILL_SLUG_RE.test(s)) } : {}) } : undefined;
    default: return;
  }
}

/** Bounded recent display accumulator; reasoning never retained, done is not a duplicate append. */
export class ViewportReducer {
  private rows: SessionMessage[] = [];
  private sizes: number[] = [];
  private bytes = 0;
  private serial = 0;
  private group = createToolRunGroup();
  private lastKind = '';
  private sawAssistant = false;
  private row(role: SessionRole, text: string, replace = false): void {
    if (replace && this.rows.length) {
      this.rows.pop(); this.bytes -= this.sizes.pop() ?? 0;
    }
    const row = { id: `view_${this.serial++}`, role, text: viewportExcerpt(text), at: 0 };
    const size = byteLength(JSON.stringify(row)) + 1;
    this.rows.push(row); this.sizes.push(size); this.bytes += size;
    while (this.bytes > VIEWPORT_RESPONSE_MAX_BYTES || this.rows.length > HARNESS_RING_MAX) {
      this.rows.shift(); this.bytes -= this.sizes.shift() ?? 0;
    }
  }
  apply(ev: AgentStreamEvent): void {
    if (ev.type === 'reasoning_delta') { this.lastKind = ''; return; }
    if (ev.type === 'text_delta') {
      const grow = this.lastKind === 'assistant' && this.rows.at(-1)?.role === 'assistant';
      this.row('assistant', (grow ? this.rows.at(-1)!.text : '') + viewportExcerpt(ev.text), grow);
      this.lastKind = 'assistant'; this.sawAssistant = true;
    } else if (ev.type === 'tool_start' || ev.type === 'tool_result') {
      const matches = ev.id ? this.group.items.filter(i => i.status === 'running' && i.callId === ev.id) : [];
      // No name-only pairing across a missing/ambiguous sample start.
      const reuse = this.lastKind === 'tool' && this.rows.at(-1)?.role === 'tool_run' &&
        !toolRunIsFull(this.group) && (ev.type === 'tool_start' || matches.length === 1);
      if (!reuse) this.group = createToolRunGroup();
      if (ev.type === 'tool_start') addToolStart(this.group, viewportExcerpt(ev.name), ev.id ? viewportExcerpt(ev.id) : undefined);
      else addToolResult(this.group, viewportExcerpt(ev.name), ev.ok, viewportExcerpt(ev.summary),
        ev.preview ? viewportExcerpt(ev.preview) : undefined, ev.id ? viewportExcerpt(ev.id) : undefined);
      this.row('tool_run', encodeToolRun(this.group) ?? 'Tool activity (incomplete)', reuse);
      this.lastKind = 'tool';
    } else if (ev.type === 'error') { this.row('error', ev.error); this.lastKind = ''; }
    else if (ev.type === 'done' && !this.sawAssistant && ev.text) {
      this.row('assistant', ev.text); this.sawAssistant = true; this.lastKind = '';
    }
  }
  snapshot(): SessionMessage[] { return this.rows.slice(); }
}
