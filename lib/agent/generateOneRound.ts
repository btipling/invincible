/**
 * backend-agents B9 (#803): generate-one-round helper (no `"use workflow"`).
 *
 * The extractable one-round core factored out of `runAgentStream`'s multi-step
 * loop: exactly ONE LLM round with tool SCHEMAS only (never `execute`), emitting
 * the existing `AgentStreamEvent` wire to an injected writable, returning a
 * normalized DELTA `{ text, toolCalls, usage, finishReason, reasoning? }` — not
 * the full transcript.
 *
 * Deliberately standalone and non-wired: `/api/agent` and `runAgentStream` stay
 * untouched this row (B12 shells over this core as `modelGenerateStep`). No
 * `"use workflow"` / `"use step"` anywhere in this file.
 *
 * Errors are business-error-as-value: the helper RETURNS `{ ok:false, ... }`
 * (never throws into an orchestrator) and never constructs I/O in-body — the
 * model impl + event writable are injected (di-gate clean).
 */

import { streamText } from 'ai';
import type { AgentStreamEvent } from './agentStream';
import { mapFullStreamPart } from './agentStream';
import { mapProviderUsage, type UsageSummary } from './usageSummary';
import { redactSecrets } from './redact';
import { resolveAgentReasoning } from './reasoningConfig';
import { resolveAgentStopWhen } from './stopWhen';
import { extractResolvedProvider } from './resolvedProvider';
import { sanitizeResolvedProvider } from '../sessionCloudCaps';

/** One captured tool-call delta (schemas only — never executed here). */
export type ToolCallDelta = {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
};

/**
 * The normalized first-step delta. `usage` is the round's aggregate provider
 * usage after the single call (never per-`finish-step`). `finishReason` is
 * forwarded as the provider reported it. `reasoning` is the accumulated
 * thinking text for this round (already redacted); omitted when empty.
 */
export type OneRoundDelta = {
  text: string;
  toolCalls: ToolCallDelta[];
  usage?: UsageSummary;
  finishReason?: string;
  reasoning?: string;
  /** Sanitized Gateway-resolved provider slug (plan #906). */
  resolvedProvider?: string;
};

/**
 * Fail-closed result. On a completed model round this is `{ ok:true, delta }`;
 * on a model-slice / event-writable / abort failure it is `{ ok:false, ... }` —
 * a return value, never an uncaught throw into the orchestrator.
 */
export type GenerateOneRoundResult =
  | { ok: true; delta: OneRoundDelta }
  | {
      ok: false;
      code: 'model_error' | 'write_error' | 'cancelled';
      error: string;
    };

/** Injected dependencies (same seam as `runAgentStream` — no in-body I/O). */
export type GenerateOneRoundDeps = {
  /** Required server-resolved model id (request-scoped BYOK). */
  modelId: string;
  /** Optional system prompt (already resolved by the caller). */
  system?: string;
  /** Request-scoped Gateway BYOK (forwarded verbatim). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerOptions?: any;
  /** Inject for tests — same shape as `streamText` from `ai`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  streamTextImpl?: (args: any) => any;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
  /** Redaction list (secrets + root server secrets), resolved by the caller. */
  secrets?: Array<string | undefined | null>;
  /**
   * Optional request/start-arg reasoning token (plan #897). Passed to
   * `resolveAgentReasoning` as `request` — wins over env / product default.
   */
  reasoning?: string;
  /**
   * Optional BYOK pin slug (already known before the round). Emitted as a
   * live `provider` event before the model stream so Busy can paint. Overlay
   * from generation `providerMetadata` wins when different.
   */
  providerHint?: string;
};

/** One-round input: messages + tool SCHEMAS only, plus the event writable. */
export type GenerateOneRoundInput = {
  /**
   * Messages for this single round. Caller owns the shape (reconstructed on
   * replay in B12); a permissive array keeps this quartile-independent of the
   * AI SDK's exact `UIMessage` union across provider versions.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: ReadonlyArray<any>;
  /**
   * Tool schemas ONLY — names/bodies, NEVER `execute`. Keys are tool names.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;
  /** Injected event writable — existing `AgentStreamEvent`s, in wire order. */
  onEvent: (event: AgentStreamEvent) => void | Promise<void>;
};

/**
 * Run exactly ONE LLM round: `streamText` with `stopWhen` capped at one step,
 * tool schemas only (never executed), emitting `AgentStreamEvent`s to the
 * injected writable, returning the normalized first-step delta.
 *
 * Never throws into an orchestrator:
 *  - model / stream-slice failure → `{ ok:false, code:'model_error' }`
 *  - event-writable failure → `{ ok:false, code:'write_error' }` (fail-closed)
 *  - abort → `{ ok:false, code:'cancelled' }`
 */
export async function generateOneRound(
  deps: GenerateOneRoundDeps,
  input: GenerateOneRoundInput,
): Promise<GenerateOneRoundResult> {
  const stream = deps.streamTextImpl ?? streamText;
  const secrets = deps.secrets ?? [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamArgs: any = {
    model: deps.modelId,
    messages: input.messages,
    // Schemas ONLY — strip any `execute` executors before the SDK boundary. A
    // real `ai` `streamText` with `stopWhen: stepCountIs(1)` would otherwise run
    // tool `execute` as part of the single step (the exact `streamText`+`execute`
    // in one step the umbrella #794 architecture lock forbids). The caller may
    // pass a tool dict carrying executors; this helper must NOT forward them.
    tools: toolsWithoutExecutors(input.tools),
    stopWhen: resolveAgentStopWhen(1),
    abortSignal: deps.signal,
  };
  if (typeof deps.system === 'string') {
    streamArgs.system = deps.system;
  }
  if (deps.providerOptions !== undefined) {
    streamArgs.providerOptions = deps.providerOptions;
  }
  const reasoningOpt = resolveAgentReasoning(deps.modelId, {
    request: deps.reasoning,
  });
  if (reasoningOpt) {
    streamArgs.reasoning = reasoningOpt;
  }

  let resolvedProvider = sanitizeResolvedProvider(deps.providerHint);
  if (resolvedProvider) {
    try {
      await input.onEvent({ type: 'provider', provider: resolvedProvider });
    } catch (err) {
      return failClosed('write_error', err, secrets);
    }
  }

  let result: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result = stream(streamArgs) as any;
  } catch (err) {
    return failClosed('model_error', err, secrets);
  }

  const toolCalls: ToolCallDelta[] = [];
  let finishReason: string | undefined;
  let reasoningAcc = '';

  try {
    for await (const part of result.fullStream) {
      // Captured from raw parts (authoritative regardless of `steps` presence),
      // same `tool-call` complete parts `mapFullStreamPart` normalizes to
      // `tool_start`. Never executed — schemas only.
      if (part && typeof part === 'object' && part.type === 'tool-call') {
        const call: ToolCallDelta = {
          toolName: typeof part.toolName === 'string' ? part.toolName : 'tool',
        };
        if (part.toolCallId != null) call.toolCallId = String(part.toolCallId);
        // AI SDK 7.0.52 `TextStreamToolCallPart` uses `input`, not `args`.
        // Prefer `input`; fall back to `args` for older SDK shapes / test mocks.
        const input = (part as { input?: unknown }).input;
        if (input !== undefined) {
          call.args = input;
        } else if (part.args !== undefined) {
          call.args = part.args;
        }
        toolCalls.push(call);
      }
      if (part && typeof part === 'object' && part.type === 'finish') {
        if (
          part.finishReason != null &&
          typeof part.finishReason === 'string' &&
          part.finishReason.length > 0
        ) {
          finishReason = part.finishReason;
        }
      }
      const partMeta = (part as { providerMetadata?: unknown } | undefined)
        ?.providerMetadata;
      const fromPart = extractResolvedProvider(partMeta);
      if (fromPart && fromPart !== resolvedProvider) {
        resolvedProvider = fromPart;
        try {
          await input.onEvent({ type: 'provider', provider: fromPart });
        } catch (err) {
          return failClosed('write_error', err, secrets);
        }
      }
      for (const ev of mapFullStreamPart(part, secrets)) {
        if (ev.type === 'reasoning_delta' && ev.text) {
          // Concatenate mapped (already redacted) chunks as-is — do not trim
          // per chunk (would eat leading spaces). Final trim happens at return.
          reasoningAcc += ev.text;
        }
        try {
          await input.onEvent(ev);
        } catch (err) {
          // Event-writable failure — fail-closed return, never an uncaught
          // throw into an orchestrator (the live wire is down; no reason to
          // keep pulling the model stream).
          return failClosed('write_error', err, secrets);
        }
      }
    }
  } catch (err) {
    if (isAbortErr(err)) {
      return { ok: false, code: 'cancelled', error: 'Request cancelled.' };
    }
    // Model-slice failure (provider stream / part-map). Return value, never an
    // uncaught throw.
    return failClosed('model_error', err, secrets);
  }

  // Final settlement of the single round (conclusive reconcile, same as
  // `runAgentStream`'s `done`): text is the round text; usage is the stream
  // aggregate (`result.usage`), never per-`finish-step`.
  let text = '';
  let usage: UsageSummary | undefined;
  try {
    text = redactSecrets((((await result.text) ?? '') as string).trim(), secrets);
  } catch (err) {
    return failClosed('model_error', err, secrets);
  }
  try {
    usage = mapProviderUsage(await Promise.resolve(result.usage));
  } catch {
    usage = undefined;
  }
  try {
    const meta = await Promise.resolve(result.providerMetadata);
    const fromSettle = extractResolvedProvider(meta);
    if (fromSettle && fromSettle !== resolvedProvider) {
      resolvedProvider = fromSettle;
      try {
        await input.onEvent({ type: 'provider', provider: fromSettle });
      } catch (err) {
        return failClosed('write_error', err, secrets);
      }
    }
  } catch {
    // Missing / rejected providerMetadata is a miss, not a failed round.
  }

  const reasoning = reasoningAcc.trim();
  return {
    ok: true,
    delta: {
      text,
      toolCalls,
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(resolvedProvider ? { resolvedProvider } : {}),
    },
  };
}

/**
 * Deep-ish clone of the tool schema dict WITHOUT any `execute` executor, so the
 * SDK never runs a tool as part of the single model round. Schema fields
 * (`description`, `parameters`, `inputSchema`, etc.) are preserved verbatim;
 * `execute` is always dropped. Unknown tool entries (non-objects) pass through.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolsWithoutExecutors(tools: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (tool && typeof tool === 'object') {
      const { execute: _dropped, ...schema } = tool as { execute?: unknown };
      out[name] = schema;
    } else {
      out[name] = tool;
    }
  }
  return out;
}

function isAbortErr(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'ResponseAborted')
  );
}

/** Map a raw error to a fail-closed `{ok:false}` result. */
function failClosed(
  code: 'model_error' | 'write_error' | 'cancelled',
  err: unknown,
  secrets: Array<string | undefined | null>,
):
  | { ok: false; code: 'model_error'; error: string }
  | { ok: false; code: 'write_error'; error: string }
  | { ok: false; code: 'cancelled'; error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, code, error: redactSecrets(msg, secrets) };
}
