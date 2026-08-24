/**
 * backend-agents B10 (#804): execute-one-tool helper (no `"use workflow"`).
 *
 * The extractable one-tool core for the tool half of the agent loop: ONE tool
 * name + one args object → re-resolve the named tool in the assembled registry
 * (sandbox `createAgentTools` results + `extraTools` from the caller) → run
 * **that** tool's `execute` → `{ result, freshnessDelta }`.
 *
 * Deliberately standalone and non-wired: `/api/agent` and `runAgentStream` stay
 * untouched this row (B12 shells over this core as `toolExecuteStep`). No
 * `"use workflow"` / `"use step"` anywhere in this file.
 *
 * Business errors are VALUES, not throws:
 *   - a tool in this seam soft-fails by RETURNING a string (never throwing for a
 *     business error) — that returned value rides as `result`;
 *   - unknown tool → `{ ok:false, code:'tool_not_found' }`;
 *   - abort → `{ ok:false, code:'cancelled' }`.
 * Infra/transient failures (daemon unreachable / runner transport / an actual
 * `execute` throw) are **re-thrown** so the SDK's retry applies only there — a
 * business error never burns `3× exec` / `3× DeepSeek`.
 *
 * The helper constructs no I/O in-body — the registry (with bound runners) and
 * the file-freshness ledger are injected (di-gate clean).
 */

import { serializeRunFileFreshness, type RunFileFreshness } from './fileFreshness';
import { redactSecrets, truncateForModel } from './redact';
import { TOOL_RESULT_MAX_CHARS } from '../sandbox/config';

/** One tool-call input: exactly one tool name + one args object. */
export type ExecuteToolInput = {
  toolName: string;
  args?: unknown;
};

/**
 * Fail-closed result (mirror B9 `GenerateOneRoundResult`):
 *  - `ok:true` → `result` is the tool's returned value, redacted + bounded; a
 *    tool's own soft-fail string rides here (it returned, it didn't throw);
 *    `freshnessDelta` is the B5 serialized run-file-freshness ledger.
 *  - `ok:false` → a business error as a value (never an uncaught throw).
 * Infra/transient failures are re-thrown (this function rejects there).
 */
export type ExecuteToolResult =
  | { ok: true; result: string; freshnessDelta: string }
  | {
      ok: false;
      code:
        | 'tool_not_found'
        | 'sandbox_error'
        | 'http_error'
        | 'mcp_error'
        | 'violation'
        | 'cancelled';
      error: string;
    };

/** Injected dependencies (same seam as `runAgent`/`runAgentStream` — no in-body I/O). */
export type ExecuteToolDeps = {
  /**
   * Assembled one-tool registry: sandbox tools (`createAgentTools(...)`) merged
   * with the caller's `extraTools` (http/MCP runners) — exactly the dict the
   * route builds before passing to `runAgent`/`runAgentStream`. Each entry is
   * an AI-SDK `tool({ execute })` closure (runners already bound at create time).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: Record<string, any>;
  /** Run-scoped file-freshness ledger — the delta source (B5). */
  freshness: RunFileFreshness;
  /** Redaction + bound for `result`, resolved by the caller. */
  secrets?: Array<string | undefined | null>;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
};

/**
 * Run exactly ONE tool by name. Re-resolves the named tool in the injected
 * registry (unknown → `tool_not_found`), then runs its `execute(args)`.
 *
 * Business errors are returned as values; abort → `{ ok:false, code:'cancelled' }`.
 * Infra/transient throws are re-thrown (SDK retry applies only there).
 */
export async function executeTool(
  deps: ExecuteToolDeps,
  input: ExecuteToolInput,
): Promise<ExecuteToolResult> {
  const registry = deps.registry ?? {};
  const secrets = deps.secrets ?? [];
  const tool = registry[input.toolName];

  if (!tool || typeof tool.execute !== 'function') {
    return {
      ok: false,
      code: 'tool_not_found',
      error: `Tool not found: ${input.toolName}`,
    };
  }

  if (deps.signal?.aborted) {
    return { ok: false, code: 'cancelled', error: 'Request cancelled.' };
  }

  let raw: unknown;
  try {
    raw = await tool.execute(input.args);
  } catch (err) {
    if (deps.signal?.aborted || isAbortErr(err)) {
      return { ok: false, code: 'cancelled', error: 'Request cancelled.' };
    }
    // Infra/transient (daemon unreachable / runner transport / a real throw) —
    // re-throw so the SDK's retry applies only here. A business error never
    // burns `3× exec` / `3× DeepSeek`.
    throw err;
  }

  // Redact + bound exactly like the tools' own `finalize` (idempotent, so a
  // tool that already finalized is untouched; an `extraTools` raw result or a
  // fake-sandbox value is still guaranteed redacted + capped).
  const result = truncateForModel(
    redactSecrets(String(raw ?? ''), secrets),
    TOOL_RESULT_MAX_CHARS,
  );

  return {
    ok: true,
    result,
    freshnessDelta: serializeRunFileFreshness(deps.freshness),
  };
}

function isAbortErr(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'ResponseAborted')
  );
}
