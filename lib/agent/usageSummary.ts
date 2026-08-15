/**
 * Phase 3 (plan #539 / #327) — bounded provider-usage summary.
 *
 * Capture provider token usage from inference completions (chat + agent, JSON +
 * stream `done`) and carry a small, honest, bounded summary on
 * `RunAgentResult` / `AgentSuccess` / the stream `done` event / the chat JSON
 * result. Absolute provider tokens ONLY — never client-side tokenizer math and
 * never a guessed denominator.
 *
 * Honesty invariants (locked in the plan):
 *  - `source` is always `'provider'`. There is no `'estimated'` source in v1
 *    and none may be invented without an explicit *labeled* client-side source.
 *    A read-side summary whose `source` is not `'provider'` is treated as
 *    **absent** (the context slot hides) — never presented as API truth.
 *  - Usage is only available AFTER the stream/JSON completion resolves. A
 *    mid-stream / aborted / cancelled turn has NO completion → no usage is
 *    emitted and the slot keeps its prior honest value.
 *  - Values are clamped to `USAGE_TOKEN_MAX` and the serialized summary is
 *    bounded at `USAGE_SUMMARY_MAX_BYTES`; an oversized carrier is **omitted**
 *    (never breaks the turn, never truncated into a lie).
 */

/** Byte cap on the serialized usage summary (Caps table, plan #539 — NEW). */
export const USAGE_SUMMARY_MAX_BYTES = 96;

/**
 * Clamp ceiling for a single token count. Far above any real model window, but
 * keeps a hostile/pathological provider value from ballooning the wire.
 */
export const USAGE_TOKEN_MAX = 1_000_000_000_000;

/** Honest, bounded, provider-sourced token summary. */
export type UsageSummary = {
  /** Provenance — always `'provider'`; anything else is treated as absent. */
  source: 'provider';
  /** Input (prompt) tokens, when the provider reported them. */
  prompt?: number;
  /** Output (completion) tokens, when the provider reported them. */
  completion?: number;
  /** Total tokens, when the provider reported them. */
  total?: number;
  /** Cached input (prompt) tokens read, when the provider reported them. */
  cached?: number;
};

const utf8Bytes = new TextEncoder();

/** Clamp any value to a non-negative integer ≤ `USAGE_TOKEN_MAX`, or undefined. */
function cleanTokenCount(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return Math.min(Math.max(0, Math.floor(v)), USAGE_TOKEN_MAX);
}

/** UTF-8 byte length of the serialized summary (`JSON.stringify`). */
export function usageSummaryByteLength(s: UsageSummary): number {
  return utf8Bytes.encode(JSON.stringify(s)).length;
}

/**
 * Map a raw provider / AI SDK usage shape into a bounded `UsageSummary`, or
 * `undefined` when the provider reported no usable token counts.
 *
 * Accepts two shapes for portability:
 *  - AI SDK v6/v7 `LanguageModelUsage`: `inputTokens`, `outputTokens`,
 *    `totalTokens`, `inputTokenDetails.cacheReadTokens`.
 *  - AI SDK v5 `LanguageModelUsage`: `promptTokens`, `completionTokens`,
 *    `totalTokens`, `cachedInputTokens`.
 *
 * Provably bounded: every count is clamped to `USAGE_TOKEN_MAX`, and a summary
 * whose serialized form exceeds `USAGE_SUMMARY_MAX_BYTES` is **omitted** (the
 * turn never breaks; an over-cap carrier is dropped, not truncated into a lie).
 */
export function mapProviderUsage(raw: unknown): UsageSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const inputTokenDetails =
    rec.inputTokenDetails && typeof rec.inputTokenDetails === 'object'
      ? (rec.inputTokenDetails as Record<string, unknown>)
      : {};

  const prompt =
    cleanTokenCount(rec.inputTokens) ?? cleanTokenCount(rec.promptTokens);
  const completion =
    cleanTokenCount(rec.outputTokens) ?? cleanTokenCount(rec.completionTokens);
  const total = cleanTokenCount(rec.totalTokens);
  const cached =
    cleanTokenCount(inputTokenDetails.cacheReadTokens) ??
    cleanTokenCount(rec.cachedInputTokens);

  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined; // provider gave us nothing usable — no fake numbers
  }

  const summary: UsageSummary = { source: 'provider' };
  if (prompt !== undefined) summary.prompt = prompt;
  if (completion !== undefined) summary.completion = completion;
  if (total !== undefined) summary.total = total;
  if (cached !== undefined) summary.cached = cached;

  // Bounded carrier: an oversize serialized summary is omitted, never shipped.
  if (usageSummaryByteLength(summary) > USAGE_SUMMARY_MAX_BYTES) return undefined;
  return summary;
}

/**
 * Read-side validation of a summary-shaped object (the host parsing of a wire
 * `usage` field, and the session-store/localStorage load). Fail-closed:
 * a non-`provider` source, a non-object, or poisoned/non-finite numbers all
 * yield `undefined` → the context slot HIDES rather than paint a lie.
 */
export function sanitizeUsageSummary(value: unknown): UsageSummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  if (rec.source !== 'provider') return undefined;
  const prompt = cleanTokenCount(rec.prompt);
  const completion = cleanTokenCount(rec.completion);
  const total = cleanTokenCount(rec.total);
  const cached = cleanTokenCount(rec.cached);
  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }
  const summary: UsageSummary = { source: 'provider' };
  if (prompt !== undefined) summary.prompt = prompt;
  if (completion !== undefined) summary.completion = completion;
  if (total !== undefined) summary.total = total;
  if (cached !== undefined) summary.cached = cached;
  if (usageSummaryByteLength(summary) > USAGE_SUMMARY_MAX_BYTES) return undefined;
  return summary;
}

/** Compact human token abbreviation (absolute tokens, no fake denominator). */
export function formatTokenCount(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v < 1000) return `${v}`;
  if (v < 1_000_000) {
    const k = v / 1000;
    const s = k >= 100 ? `${Math.round(k)}` : k.toFixed(1).replace(/\.0$/, '');
    return `${s}k`;
  }
  const m = v / 1_000_000;
  const s = m >= 100 ? `${Math.round(m)}` : m.toFixed(1).replace(/\.0$/, '');
  return `${s}M`;
}

/**
 * Build the host status-slot display string for a context/usage summary:
 * absolute tokens only (`N in · M out · T tok`), or `undefined` for a hidden
 * slot (absent usage / non-provider source / a summary with nothing to show).
 * Never a `% of window` — no model max-context is known in v1.
 */
export function formatUsageSummary(usage: UsageSummary | undefined): string | undefined {
  if (!usage || usage.source !== 'provider') return undefined;
  const parts: string[] = [];
  if (usage.prompt !== undefined) parts.push(`${formatTokenCount(usage.prompt)} in`);
  if (usage.completion !== undefined) parts.push(`${formatTokenCount(usage.completion)} out`);
  if (usage.total !== undefined) parts.push(`${formatTokenCount(usage.total)} tok`);
  if (usage.cached !== undefined && usage.cached > 0) {
    parts.push(`${formatTokenCount(usage.cached)} cached`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
