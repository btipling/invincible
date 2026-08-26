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
import {
  createAiSdkExecutionGuard,
  createAiSdkExecutionLock,
} from 'prefix-safe-json';
import type { AgentStreamEvent } from './agentStream';
import { mapFullStreamPart } from './agentStream';
import { mapProviderUsage, type UsageSummary } from './usageSummary';
import { redactSecrets } from './redact';
import { resolveAgentReasoning } from './reasoningConfig';
import { resolveAgentStopWhen } from './stopWhen';

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

  let lockedTools: Record<string, unknown>;
  let executionGuard: ReturnType<typeof createAiSdkExecutionGuard>;
  try {
    lockedTools = toolsWithoutExecutors(input.tools);
    executionGuard = createAiSdkExecutionGuard({
      schemas: schemasForExecutionGuard(input.tools),
    });
  } catch (err) {
    return failClosed('model_error', err, secrets);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamArgs: any = {
    model: deps.modelId,
    system: deps.system,
    messages: input.messages,
    // Execution-locked schemas only. A real AI SDK stream would otherwise be
    // able to invoke `execute` and input lifecycle callbacks before raw stream
    // evidence has earned authority. Manual execution remains downstream of
    // the one-shot guard decision below.
    tools: lockedTools,
    stopWhen: resolveAgentStopWhen(1),
    abortSignal: deps.signal,
  };
  if (deps.providerOptions !== undefined) {
    streamArgs.providerOptions = deps.providerOptions;
  }
  const reasoningOpt = resolveAgentReasoning(deps.modelId);
  if (reasoningOpt) {
    streamArgs.reasoning = reasoningOpt;
  }

  let result: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result = stream(streamArgs) as any;
  } catch (err) {
    return failClosed('model_error', err, secrets);
  }

  let finishReason: string | undefined;
  let reasoningAcc = '';

  try {
    for await (const part of result.fullStream) {
      // The guard consumes the AI SDK's raw tool-input lifecycle. In
      // particular, it never trusts the SDK's repaired `tool-call.input`
      // projection as execution authority.
      executionGuard.push(part);
      if (part && typeof part === 'object' && part.type === 'finish') {
        if (
          part.finishReason != null &&
          typeof part.finishReason === 'string' &&
          part.finishReason.length > 0
        ) {
          finishReason = part.finishReason;
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

  const reasoning = reasoningAcc.trim();
  const toolCalls: ToolCallDelta[] = [];
  const settled = executionGuard.finish();
  for (const observed of settled.decisions) {
    // One-shot authority: unknown/rejected/retried calls and duplicate takes
    // all return undefined. Also require the authorized raw name to exist in
    // this exact model-visible registry before handing it to the durable loop.
    const authority = executionGuard.takeDecision(observed.internalId);
    if (
      !authority ||
      !Object.prototype.hasOwnProperty.call(input.tools, authority.name)
    ) {
      continue;
    }
    toolCalls.push({
      toolName: authority.name,
      ...(authority.toolCallId !== undefined
        ? { toolCallId: String(authority.toolCallId) }
        : {}),
      args: authority.value,
    });
  }

  return {
    ok: true,
    delta: {
      text,
      toolCalls,
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(reasoning ? { reasoning } : {}),
    },
  };
}

/**
 * Lock the tool schema dict against every AI SDK-owned caller-code hook. Schema
 * fields (`description`, `parameters`, `inputSchema`, etc.) are preserved;
 * `execute` and input lifecycle callbacks are removed and approval is forced.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolsWithoutExecutors(tools: Record<string, any>): Record<string, any> {
  return createAiSdkExecutionLock(tools as Record<string, object>);
}

/** Reuse the AI SDK tool definitions' concrete JSON Schemas in the guard. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function schemasForExecutionGuard(tools: Record<string, any>): Record<string, any> {
  const schemas: Record<string, any> = {};
  for (const [name, definition] of Object.entries(tools)) {
    if (!definition || typeof definition !== 'object') continue;
    // AI SDK 7 uses `inputSchema`; `parameters` supports older/internal mocks.
    const holder = definition.inputSchema ?? definition.parameters;
    const schema = holder?.jsonSchema ?? holder;
    if (schema && typeof schema === 'object') schemas[name] = schema;
  }
  return schemas;
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
