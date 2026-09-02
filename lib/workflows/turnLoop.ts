/**
 * backend-agents B12 (#806) — `"use workflow"` turn orchestrator loop core.
 *
 * The pure, testable while-loop that drives one prompt run. Per the umbrella
 * (#794) Architecture lock, ONE run = ONE prompt, and ONE step boundary = one
 * model round OR one tool **batch** (the round's toolCalls) OR one persist. The loop lives in workflow
 * context; it calls the three thin `'use step'` wrappers
 * (`modelGenerateStep` / `toolExecuteStep` / `persistStep`) which each re-resolve
 * the world in-step from serializable args.
 *
 * **Deliberately directive-free** (no `"use workflow"` / `"use step"` in this
 * file) so the whole matrix runs under plain vitest without the Vercel-Workflows
 * transform. The `'use workflow'` entry (`turnWorkflow.ts`) is the directive
 * carrier that adapts `'use step'` write/close wrappers and calls this core.
 *
 * Lock discipline (B11 #805, deploy-gate):
 *  - Step I/O = **deltas** (`{text,toolCalls,usage,finishReason,reasoning?}` /
 *    `{results[], freshnessDelta}` / terminal persist status), never the full
 *    transcript.
 *  - Tokens ride `getWritable()`. Live `reasoning_delta` / `text_delta` /
 *    `tool_start` are written inside `modelGenerateStep`. Live `tool_result`
 *    is written inside `toolExecuteStep` (one held writer for the batch —
 *    plan #880). This core still writes loop-owned `done` / `error` and
 *    wrap-up skipped-tool `tool_result`. Transcript/checkpoint live in Blob.
 *  - The writable is closed **exactly once** on every terminal path — success,
 *    model/provider refusal, step-cap wrap-up, or cancel. Persist `{ok:false}`
 *    of **any** code does **not** fail the turn. Tool item failures are tool
 *    results for the next model round, not a turn-end.
 *  - Tool business errors are **values**, not throws: a step returning
 *    `{ok:false}` (or a batch item `{ok:false}`) is a tool result for the
 *    next model round. Only user cancel ends the turn from the tool path.
 *    Never retried 3× by the SDK.
 *  - No `/api/agent` fallback, no wrapping `runAgentStream` in one step.
 *
 * Messages are reconstructed **on replay** from the step deltas this core
 * records in `deltas` (that is the orchestrator-local transcript the loop is
 * allowed to keep — never the full transcript, which is Blob; see B13).
 */

import type { PersistStepFold } from './persistStep';
// Pure, dependency-free tool-result parsers (extracted from `agentStream.ts` so
// this directive-free core can derive cwd / activeSandboxId from THIS run's
// tool rows without dragging in that module's closure — adversarial round-2 L1).
import { changeDirSuccessCwd, metaSandboxSwitchActiveId } from '../agent/toolResultParsers';
import { formatTurnSse } from './turnSseFormat';
import {
  isProviderRefusalFinish,
  truncatedFinishError,
  STEP_BUDGET_ERROR,
  STEP_BUDGET_WRAPUP,
  TURN_WALL_CLOCK_ERROR,
  TURN_WALL_CLOCK_WRAPUP,
} from '../agent/modelFinish';
import { TURN_WALL_CLOCK_MAX_MS } from '../sessionCloudCaps';
import { logTurnLoop } from './turnLog';

/**
 * Local structural model-round delta. Defined here (NOT imported from
 * `generateOneRound`) so this directive-free core carries zero static coupling
 * to that file — its own closure stays deploy-gate clean (plan #805 lock) and
 * the loop needs only the shape, not the B9 implementation. Structurally
 * identical to `generateOneRound.OneRoundDelta`; `modelGenerateStep` (the
 * wrapper) is the only module that bridges this core to the B9 implementation.
 */
export type TurnLoopDelta = {
  text: string;
  toolCalls: TurnToolCallDelta[];
  /** Provider usage for this model round (B9 `OneRoundDelta.usage`, optional). */
  usage?: unknown;
  finishReason?: string;
  /**
   * Optional accumulated thinking from the model step. The loop **must not**
   * copy this onto the SSE wire (live `reasoning_delta` is written inside the
   * model step). It is also omitted from persist/`messages`.
   */
  reasoning?: string;
  /** Sanitized Gateway-resolved provider slug (plan #906). Last round wins. */
  resolvedProvider?: string;
};

export type TurnToolCallDelta = {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
};

/**
 * NEW workflow-scoped cap (plan #806 Caps table): max workflow **steps** per
 * prompt run, where EVERY step boundary counts ONE (each model round + each
 * tool execution + **each persist**, mid-turn included). This is a STEP bound,
 * not a round bound (adversarial L6): a per-round tool fanout is **one**
 * tool-batch step (plan #880 / #872), so N calls cannot blow the budget.
 * Rough worst case is `model + user-line persist + 1*(batch+persist) +
 * later model + terminal` ≪ 2k-event slow-replay line (Vercel: 25k events/run,
 * 2 GB entity). Addressable under `MAX_AGENT_MAX_STEPS`
 * (`lib/sandbox/config.ts`, 1_000_000, unchanged — no existing-cap change, no
 * human gate). Original lock was 256; human-approved raise to 512 (plan #878).
 * Wrap-up after cap (tools off) is extra and not counted against this budget.
 */
export const MAX_WORKFLOW_STEPS = 512;

/** Minimal writable surface the loop needs — a `WritableStream`-like carve. */
export interface TurnWritable {
  write(line: string): void | Promise<void>;
  close(): void | Promise<void>;
}

/** Serialized SSE event — `AgentStreamEvent` field names (D17 host / plan #842). */
export type TurnSseLine =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_start'; name: string; id?: string }
  | {
      type: 'tool_result';
      name: string;
      ok: boolean;
      summary: string;
      id?: string;
      changeDirCwd?: string;
      activeSandboxId?: string;
    }
  | { type: 'done'; text: string; finishReason?: string; cwd?: string; activeSandboxId?: string; resolvedProvider?: string }
  | { type: 'error'; error: string };

/** Model-step wrapper contract (eventually `modelGenerateStep`). */
export interface ModelStepFn {
  (args: {
    messages: ReadonlyArray<unknown>;
    /**
     * Cap wrap-up: no tool schemas. The model must see the error and answer,
     * not emit more toolCalls.
     */
    disableTools?: boolean;
    /**
     * Which cap fold this wrap-up round is — `'steps'` (512-step budget,
     * plan #806/#878) vs `'wall'` (1-hour wall clock, plan #923). Threaded to
     * `modelGenerateStep`, which picks the wrap-up SYSTEM (the loop never
     * passes a system string — it stays a serializable tag). The `'wall'`
     * wrap-up is DEADLINE-EXEMPT: it runs after the deadline elapsed and must
     * complete once so the model can tell the user what happened.
     */
    wrapUp?: 'steps' | 'wall';
    /**
     * RUNNING sandbox bind (cwd, activeSandboxId) threaded from the loop.
     * Initialised from `deps.persistRunBind` (start snapshot); updated after
     * every successful `change_dir` / `meta_sandbox_switch` tool. The step
     * passes this into `assembleDurableToolWorld` so the model sees FS tools
     * for the CURRENT sandbox + cwd, not the stale start snapshot.
     */
    persistRunBind?: PersistRunBind;
  }): Promise<
    | { ok: true; delta: TurnLoopDelta }
    | {
        ok: false;
        code: 'model_error' | 'write_error' | 'cancelled' | 'wall_clock';
        error: string;
      }
  >;
}

/** One item in a tool-batch step result (plan #880). */
export type ToolBatchItem =
  | {
      ok: true;
      toolName: string;
      toolCallId?: string;
      result: string;
      freshnessDelta: string;
    }
  | {
      ok: false;
      toolName: string;
      toolCallId?: string;
      code:
        | 'tool_not_found'
        | 'sandbox_error'
        | 'http_error'
        | 'mcp_error'
        | 'violation'
        | 'cancelled'
        | 'wall_clock';
      error: string;
    };

/** Tool-step wrapper contract (`toolExecuteStep` — one round's toolCalls). */
export interface ToolStepFn {
  (args: {
    /** Every toolCall from this model round. One step regardless of length. */
    calls: ReadonlyArray<TurnToolCallDelta>;
    /**
     * B5-serialized file-freshness ledger seed from the prior tool step(s) in
     * this run — threaded so read-before-edit grants survive across steps and
     * rounds (adversarial L1). A plain string, never a closure.
     */
    freshnessSeed?: string;
    /**
     * RUNNING sandbox bind (cwd, activeSandboxId) threaded from the loop, same
     * pattern as `freshnessSeed`. Initialised from `deps.persistRunBind` (start
     * snapshot); updated after every successful `change_dir` /
     * `meta_sandbox_switch`. The step passes this into `assembleDurableToolWorld`
     * so FS tool assembly and sandbox resolution use the CURRENT bind, not the
     * stale start snapshot.
     */
    persistRunBind?: PersistRunBind;
  }): Promise<
    | { ok: true; results: ToolBatchItem[]; freshnessDelta: string }
    | {
        ok: false;
        code:
          | 'tool_not_found'
          | 'sandbox_error'
          | 'http_error'
          | 'mcp_error'
          | 'violation'
          | 'cancelled'
          | 'wall_clock';
        error: string;
        /** Present when some calls ran before the fail (don't silently drop). */
        results?: ToolBatchItem[];
      }
  >;
}

/** Persist-step wrapper contract (eventually `persistStep`). */
export interface PersistStepFn {
  (args: {
    turnRunId: string;
    deltas: ReadonlyArray<unknown>;
    /** Run final-state fold (B13) — plain serializable values only. */
    fold?: PersistStepFold;
    /**
     * Default true. Mid-turn writes pass false so B8 overlays `running`.
     */
    terminal?: boolean;
  }): Promise<
    | { ok: true; status: 'completed' | 'running'; turnRunId: string }
    | { ok: false; code: string; error: string }
  >;
}

/** Injected dependencies for the loop core — steps + the SSE writable. */
export interface TurnLoopDeps {
  modelStep: ModelStepFn;
  toolStep: ToolStepFn;
  persistStep: PersistStepFn;
  writable: TurnWritable;
  /** Cap override for tests. Defaults to {@link MAX_WORKFLOW_STEPS}. */
  maxSteps?: number;
  /**
   * Absolute epoch deadline (ms) for the 1-hour wall-clock cap (plan #923).
   * Derived ONCE in the `'use workflow'` entry from the SDK-pinned
   * `getWorkflowMetadata().workflowStartedAt` + `TURN_WALL_CLOCK_MAX_MS` — a
   * plain serializable number (never a signal/closure/Date across a step
   * boundary). When omitted the wall cap is inert (tests/legacy callers).
   */
  deadlineAt?: number;
  /** Workflow run id — NEVER a session id (plan lock). */
  turnRunId: string;
  /**
   * Run **bind** state (B13): the sandbox `activeSandboxId` + workspace cwd the
   * run is bound to. Supplied by the engine (C14) at start — this is pre-run
   * sandbox bind, NOT "last deltas" (those do not exist at `start()`). The
   * per-turn projections (checkpoint + usage) are **derived** by the loop at
   * the persist call from this run's reconstructed `messages`/last model delta.
   * Optional for tests/in-memory seams.
   */
  persistRunBind?: PersistRunBind;
}

/** B13 run-bind state the engine knows at `start()` (serializable values only).
 *  Distinct from the derived per-turn fold: cwd/activeSandboxId are sandbox bind,
 *  checkpoint/usage are this-run projections the loop computes at persist time. */
export type PersistRunBind = {
  activeSandboxId?: string;
  cwd?: string;
};

/** Loop input: the user turn (orchestrator-local starting message). */
export interface TurnLoopInput {
  userMessage: string;
}

/** Terminal result + the delta log for replay reconstruction (roundtrip). */
export interface TurnLoopResult {
  status: 'completed' | 'capped' | 'cancelled' | 'failed';
  /**
   * Replay-reconstruction source: every step delta in wire order. The loop is
   * allowed to keep these (orchestrator-local) — never the full transcript.
   */
  deltas: unknown[];
  /** Reconstructed `[user, *assistant/tool deltas]` on replay. */
  messages: unknown[];
  rounds: number;
  /**
   * Total workflow steps executed (model + each tool-batch + persist, each == 1).
   * Bounded by {@link MAX_WORKFLOW_STEPS} — the cap counts STEPS, not rounds
   * (adversarial L6). A per-round tool fanout is one batch step (plan #880).
   */
  steps: number;
  error?: string;
  /**
   * Cap reason when `status === 'capped'` — `'steps'` (512-step budget,
   * plan #806/#878) vs `'wall'` (1-hour wall clock, plan #923). The operator
   * log + docs distinguish the two bounds. Omitted on non-capped results.
   */
  reason?: 'steps' | 'wall';
}

/** Always-serializable writable guard: close exactly once, fail-soft. */
export function onceWritable(writable: TurnWritable): TurnWritable {
  let closed = false;
  return {
    write: (line) => writable.write(line),
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      try {
        return Promise.resolve(writable.close());
      } catch {
        return Promise.resolve();
      }
    },
  };
}

/**
 * Bounded wall-clock elapsed for the additive `invincible.turn.loop` log row
 * (plan #923): `deadlineAt` is `startedAt + TURN_WALL_CLOCK_MAX_MS`, so
 * `now - (deadlineAt - MAX)` is the run's elapsed. Clamped to `[0, 2×cap]` so a
 * hostile/desynced clock can never log a nonsense large value (the loop can
 * overrun at most ~one wave + one wrap-up round past the deadline).
 */
function boundedElapsedMs(deadlineAt: number): number {
  const startedAt = deadlineAt - TURN_WALL_CLOCK_MAX_MS;
  const elapsed = Date.now() - startedAt;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.max(0, Math.min(Math.floor(elapsed), TURN_WALL_CLOCK_MAX_MS * 2));
}

const sse = (line: TurnSseLine): string => formatTurnSse(line);

function doneLine(
  text: string,
  bind: PersistRunBind | undefined,
  finishReason?: string,
  resolvedProvider?: string,
): TurnSseLine {
  return {
    type: 'done',
    text,
    ...(finishReason ? { finishReason } : {}),
    ...(bind?.cwd ? { cwd: bind.cwd } : {}),
    ...(bind?.activeSandboxId ? { activeSandboxId: bind.activeSandboxId } : {}),
    ...(resolvedProvider ? { resolvedProvider } : {}),
  };
}

function toolResultLine(
  toolName: string,
  ok: boolean,
  raw: string | undefined,
  id?: string,
): TurnSseLine {
  const ev: Extract<TurnSseLine, { type: 'tool_result' }> = {
    type: 'tool_result',
    name: toolName,
    ok,
    summary: raw ?? '',
    ...(id ? { id } : {}),
  };
  if (ok && raw) {
    const cwd = changeDirSuccessCwd(raw);
    const sandboxId = metaSandboxSwitchActiveId(raw);
    if (cwd) ev.changeDirCwd = cwd;
    if (sandboxId) ev.activeSandboxId = sandboxId;
  }
  return ev;
}

/** Synthetic tool rows for assistant toolCalls that never ran (cap mid-fanout).
 *  Providers reject a user message after open tool_calls — wrap-up would never
 *  reach the model without these pairs. `skipError` distinguishes the wall-cap
 *  wrap-up (`skipped: turn wall clock exceeded`) from the step-budget one. */
function unpairedToolRows(
  messages: ReadonlyArray<unknown>,
  skipError: string,
): Array<{
  role: 'tool';
  toolName: string;
  toolCallId: string;
  ok: false;
  error: string;
}> {
  const answered = new Set<string>();
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const row = m as { role?: unknown; toolCallId?: unknown };
    if (row.role === 'tool' && typeof row.toolCallId === 'string' && row.toolCallId) {
      answered.add(row.toolCallId);
    }
  }
  const skipped: Array<{
    role: 'tool';
    toolName: string;
    toolCallId: string;
    ok: false;
    error: string;
  }> = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const row = m as { role?: unknown; delta?: { toolCalls?: TurnToolCallDelta[] } };
    if (row.role !== 'assistant') continue;
    for (const call of row.delta?.toolCalls ?? []) {
      if (!call.toolCallId || answered.has(call.toolCallId)) continue;
      answered.add(call.toolCallId);
      skipped.push({
        role: 'tool',
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        ok: false,
        error: `skipped: ${skipError}`,
      });
    }
  }
  return skipped;
}

/** Map a reconstructed message row to a bounded `{role, content}` checkpoint row.
 *  The loop keeps `[user, assistant-delta, tool-result, persist]` rows; the
 *  checkpoint projection wants plain text content per role (B6 bounds it further). */
function checkpointRow(m: unknown): { role: string; content: string } | undefined {
  if (!m || typeof m !== 'object') return undefined;
  const o = m as { role?: unknown; content?: unknown; delta?: unknown; result?: unknown; error?: unknown };
  if (typeof o.role !== 'string' || o.role.length === 0) return undefined;
  // Wrap-up `{ role: 'error' }` is model-only (STEP_BUDGET_WRAPUP is not canvas
  // copy). Persist/F5 must not paint it as an EMBER row.
  if (o.role === 'error') return undefined;
  if (typeof o.content === 'string') return { role: o.role, content: o.content };
  if (o.role === 'assistant') {
    const d = o.delta as { text?: unknown } | undefined;
    if (d && typeof d.text === 'string') return { role: 'assistant', content: d.text };
  }
  if (o.role === 'tool') {
    const text = typeof o.result === 'string' ? o.result : typeof o.error === 'string' ? o.error : '';
    return { role: 'tool', content: text };
  }
  return undefined;
}

/**
 * Accumulate provider usage across model rounds into a single `UsageSummary`-
 * shaped aggregate. B9 usage is per-round (`OneRoundDelta.usage`), so the FIRST
 * round's total must not be clobbered by the last round (adversarial round-2
 * L1): the terminal `fold.usage` must be the TURN total, matching the host
 * context-slot aggregate-on-finish semantics. Numeric fields are summed; a
 * round reporting no usable usage contributes nothing. Source stays `'provider'`.
 */
function accumulateUsage(acc: unknown, next: unknown): unknown {
  const asRec = (v: unknown): Record<string, number> => {
    if (!v || typeof v !== 'object') return {};
    const r = v as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const k of ['prompt', 'completion', 'total', 'cached'] as const) {
      const n = r[k];
      if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
    }
    return out;
  };
  const a = asRec(acc);
  const b = asRec(next);
  if (Object.keys(a).length === 0 && Object.keys(b).length === 0) return undefined;
  const sum: Record<string, number> = { ...a };
  for (const k of Object.keys(b) as Array<keyof typeof b>) {
    sum[k] = (sum[k] ?? 0) + b[k]!;
  }
  return { source: 'provider', ...sum };
}

/** Scan a reconstructed tool row for its derived cwd / activeSandboxId. */
function toolRowBind(m: unknown): { cwd?: string; activeSandboxId?: string } {
  if (!m || typeof m !== 'object') return {};
  const o = m as { role?: unknown; toolName?: unknown; result?: unknown };
  if (o.role !== 'tool' || typeof o.toolName !== 'string') return {};
  const result = typeof o.result === 'string' ? o.result : undefined;
  if (o.toolName === 'change_dir') {
    const cwd = changeDirSuccessCwd(result);
    return cwd !== undefined ? { cwd } : {};
  }
  if (o.toolName === 'meta_sandbox_switch') {
    const id = metaSandboxSwitchActiveId(result);
    return id !== undefined ? { activeSandboxId: id } : {};
  }
  return {};
}

/**
 * Derive the B13 terminal persist fold **at persist time** from this run's
 * reconstructed `messages` + accumulated usage (adversarial L1 — the fold is NOT
 * a start-of-run arg: the last deltas do not exist at `start()`, only here).
 *
 * cwd / activeSandboxId come from THIS run's tool rows — the LAST successful
 * `change_dir` / `meta_sandbox_switch` wins (adversarial round-2 L1). We NEVER
 * overlay a pre-run `persistRunBind` snapshot over a mid-turn tool write (that
 * would clobber the envelope write the tool just made); the bind is only a
 * fallback for a key the run never touched. usage is the ACCUMULATED turn total
 * (not the last round). checkpoint is this run's rebuilt `{role, content}[]`.
 */
export function derivePersistFold(
  messages: ReadonlyArray<unknown>,
  usage: unknown,
  runBind?: PersistRunBind,
  resolvedProvider?: string,
): PersistStepFold | undefined {
  const checkpoint: Array<{ role: string; content: string }> = [];
  let cwd: string | undefined = runBind?.cwd;
  let activeSandboxId: string | undefined = runBind?.activeSandboxId;
  for (const m of messages) {
    const row = checkpointRow(m);
    if (row) checkpoint.push(row);
    const bind = toolRowBind(m);
    if (bind.cwd !== undefined) cwd = bind.cwd;
    if (bind.activeSandboxId !== undefined) activeSandboxId = bind.activeSandboxId;
  }
  if (
    checkpoint.length === 0 &&
    usage === undefined &&
    cwd === undefined &&
    activeSandboxId === undefined &&
    resolvedProvider === undefined
  ) {
    return undefined;
  }
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(activeSandboxId !== undefined ? { activeSandboxId } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(resolvedProvider !== undefined ? { resolvedProvider } : {}),
    ...(checkpoint.length > 0 ? { checkpoint } : {}),
  };
}

/**
 * Drive one prompt run: `model · (tool-batch)*` until the model returns no
 * tool calls or the 512-step cap is reached, writing delta-only SSE lines to
 * the writable, then persist. Mid-turn persists (user-line after a model that
 * returned tools, and after each successful **batch**) overlay `running`; the
 * no-tool model round persist overlays `completed`. Closes the writable on
 * EVERY terminal path.
 *
 * This core holds no closures that cross a step boundary: every arg passed to a
 * step is a plain serializable value (messages / calls[] / turnRunId +
 * deltas). Re-resolution of grants/model/sandbox happens inside the steps.
 */
export async function runTurnLoop(
  deps: TurnLoopDeps,
  input: TurnLoopInput,
): Promise<TurnLoopResult> {
  const cap = Math.max(0, Math.floor(deps.maxSteps ?? MAX_WORKFLOW_STEPS));
  const writable = onceWritable(deps.writable);
  const deltas: unknown[] = [];
  const messages: unknown[] = [{ role: 'user', content: input.userMessage }];

  const fail = async (
    status: TurnLoopResult['status'],
    round: number,
    steps: number,
    error?: string,
    reason?: TurnLoopResult['reason'],
  ): Promise<TurnLoopResult> => {
    if (error) await writable.write(sse({ type: 'error', error }));
    await writable.close();
    const result: TurnLoopResult = {
      status,
      deltas,
      messages,
      rounds: round,
      steps,
      ...(error !== undefined ? { error } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    logTurnLoop({
      status: result.status,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      ...(deps.deadlineAt !== undefined
        ? { elapsedMs: boundedElapsedMs(deps.deadlineAt) }
        : {}),
    });
    return result;
  };

  let round = 0;
  let steps = 0;
  let assistantText = '';
  // ACCUMULATED provider usage across all model rounds (B13) — the usage
  // projection for the terminal fold, derived from THIS run's deltas at persist
  // time (adversarial L1: never a start-of-run arg) AND summed across rounds so
  // an earlier round's tokens aren't clobbered by the last (round-2 L1 — the
  // host context-slot aggregate is turn-total, not last-round).
  let usage: unknown;
  // Last sanitized Gateway-resolved provider slug this turn (plan #906).
  // Last model-round win; not accumulated like usage.
  let resolvedProvider: string | undefined;
  // Thread the B5 file-freshness ledger across tool steps — and across rounds.
  // Every tool step seeds from the accumulated serialized ledger and returns the
  // advanced delta, so read-before-edit grants survive the durable loop
  // (adversarial L1). A plain string, never a closure.
  let freshness: string | undefined;
  // Thread the RUNNING sandbox bind (cwd + activeSandboxId) across tool steps
  // (same pattern as freshness). Initialised from the start snapshot; updated
  // after every successful `change_dir` / `meta_sandbox_switch` tool so the
  // NEXT tool/model step gets the CURRENT bind (adversarial round-3 BLOCK).
  // A plain serializable value, never a closure.
  let bind: PersistRunBind | undefined = deps.persistRunBind
    ? { ...deps.persistRunBind }
    : undefined;
  // User-line persist fires once: after the first in-budget model delta that
  // returned tool calls. A no-tool first round skips it — that write IS the
  // terminal persist (`completed`).
  let didUserLinePersist = false;

  const persistNow = async (
    terminal: boolean,
  ): Promise<
    | { ok: true; status: 'completed' | 'running'; turnRunId: string }
    | { ok: false; code: string; error: string }
  > => {
    steps += 1;
    const fold = derivePersistFold(messages, usage, deps.persistRunBind, resolvedProvider);
    return deps.persistStep({
      turnRunId: deps.turnRunId,
      deltas,
      ...(fold !== undefined ? { fold } : {}),
      ...(terminal ? {} : { terminal: false }),
    });
  };

  const persistOnce = async (terminal: boolean): Promise<void> => {
    const persisted = await persistNow(terminal);
    if (persisted.ok) {
      deltas.push(persisted);
      messages.push({ role: 'persist', status: persisted.status });
      return;
    }
    messages.push({ role: 'persist', ok: false, code: persisted.code });
  };

  /**
   * Wall-clock cap check — the directive-free core is NOT a workflow function,
   * so `Date.now()` is truthful here (only the `'use workflow'` entry is
   * replay-pinned; it derives `deadlineAt` once from SDK `workflowStartedAt`).
   * `Infinity` when the caller never supplied a deadline (cap inert).
   */
  const deadlineElapsed = (): boolean => {
    if (deps.deadlineAt === undefined) return false;
    return deps.deadlineAt - Date.now() <= 0;
  };

  /**
   * Terminal wall-cap fold (plan #923): close unpaired tool rows with the
   * wall copy, one tools-off wrap-up round that SEES the wall error, terminal
   * persist, ONE SSE `error` `turn wall clock exceeded`, writable close once,
   * and `{status:'capped', reason:'wall'}`. Mirrors the step-budget path but
   * with distinct copy + an `error` (not `done`) terminal — a wall-cap is a
   * hard stop mid-work, honest as an error line. A wrap-up inference failure
   * is a real model error and still fails (`failed` + reason `wall`).
   */
  const wallWrapUp = async (
    round: number,
    steps: number,
  ): Promise<TurnLoopResult> => {
    const skipped = unpairedToolRows(messages, TURN_WALL_CLOCK_ERROR);
    for (const row of skipped) {
      messages.push(row);
      await writable.write(
        sse(toolResultLine(row.toolName, false, row.error, row.toolCallId)),
      );
    }
    const wrapMessages: unknown[] = [
      ...messages,
      { role: 'error', content: TURN_WALL_CLOCK_WRAPUP },
    ];
    let wrap: Awaited<ReturnType<ModelStepFn>>;
    try {
      wrap = await deps.modelStep({
        messages: wrapMessages,
        persistRunBind: bind,
        disableTools: true,
        wrapUp: 'wall',
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      wrap = { ok: false, code: 'model_error', error };
    }
    if (wrap.ok) {
      const wrapDelta: TurnLoopDelta = {
        text: wrap.delta.text,
        toolCalls: [], // ignore — wrap-up must not run more tools
        ...(wrap.delta.usage !== undefined ? { usage: wrap.delta.usage } : {}),
        ...(wrap.delta.finishReason !== undefined
          ? { finishReason: wrap.delta.finishReason }
          : {}),
        ...(typeof wrap.delta.resolvedProvider === 'string' &&
        wrap.delta.resolvedProvider.length > 0
          ? { resolvedProvider: wrap.delta.resolvedProvider }
          : {}),
      };
      deltas.push(wrapDelta);
      usage = accumulateUsage(usage, wrapDelta.usage);
      if (wrapDelta.resolvedProvider) {
        resolvedProvider = wrapDelta.resolvedProvider;
      }
      if (wrapDelta.text) assistantText += wrapDelta.text;
      messages.push({ role: 'assistant', delta: wrapDelta });
    }
    await persistOnce(true);
    if (!wrap.ok) {
      return fail('failed', round, steps, wrap.error, 'wall');
    }
    if (isProviderRefusalFinish(wrap.delta.finishReason)) {
      return fail(
        'failed',
        round,
        steps,
        truncatedFinishError(wrap.delta.finishReason),
        'wall',
      );
    }
    await writable.write(sse({ type: 'error', error: TURN_WALL_CLOCK_ERROR }));
    await writable.close();
    const result: TurnLoopResult = {
      status: 'capped',
      deltas,
      messages,
      rounds: round,
      steps,
      reason: 'wall',
    };
    logTurnLoop({
      status: result.status,
      reason: result.reason,
      ...(deps.deadlineAt !== undefined
        ? { elapsedMs: boundedElapsedMs(deps.deadlineAt) }
        : {}),
    });
    return result;
  };

  try {
    while (steps < cap) {
      round += 1;
      steps += 1; // this model round = one step boundary
      // Wall-clock boundary check (plan #923) — belt-and-suspenders; the
      // authoritative abort happens in-step via the deadline signal, this
      // catches the gap between an abort and the step returning. The wrap-up
      // fold is the SAME terminal as the step sentinel.
      if (deadlineElapsed()) {
        return wallWrapUp(round, steps);
      }
      // ONE model round — schemas only, never execute (B9 core). Delta return.
      // Pass the running bind so the model sees FS tools for the CURRENT sandbox
      // + cwd, not the stale start snapshot.
      const gen = await deps.modelStep({ messages, persistRunBind: bind });
      if (!gen.ok) {
        if (gen.code === 'wall_clock') {
          // Dedicated wall sentinel — the wall wrap-up terminal-persists +
          // closes + writes the SSE error itself (no double-persist here).
          return wallWrapUp(round, steps);
        }
        // Irrevocable inference: SSE error. Persist `completed` first so
        // refresh cannot attach after user-line persist left `running`.
        await persistOnce(true);
        return fail(gen.code === 'cancelled' ? 'cancelled' : 'failed', round, steps, gen.error);
      }
      const persistDelta: TurnLoopDelta = {
        text: gen.delta.text,
        toolCalls: gen.delta.toolCalls,
        ...(gen.delta.usage !== undefined ? { usage: gen.delta.usage } : {}),
        ...(gen.delta.finishReason !== undefined
          ? { finishReason: gen.delta.finishReason }
          : {}),
        ...(typeof gen.delta.resolvedProvider === 'string' &&
        gen.delta.resolvedProvider.length > 0
          ? { resolvedProvider: gen.delta.resolvedProvider }
          : {}),
      };
      deltas.push(persistDelta);
      usage = accumulateUsage(usage, persistDelta.usage);
      if (persistDelta.resolvedProvider) {
        resolvedProvider = persistDelta.resolvedProvider;
      }
      // Live reasoning_delta / text_delta / tool_start were written inside the
      // model step. Do **not** dump them again here (would double-paint).
      if (persistDelta.text) {
        assistantText += persistDelta.text;
      }
      messages.push({ role: 'assistant', delta: persistDelta });

      // No tool calls → this model round is terminal unless the provider
      // refused (`content-filter` / `error`). `length` is a cap, not a fail:
      // persist + `done` with the partial text.
      const calls: TurnToolCallDelta[] = gen.delta.toolCalls ?? [];
      if (calls.length === 0) {
        await persistOnce(true);
        if (isProviderRefusalFinish(gen.delta.finishReason)) {
          return fail('failed', round, steps, truncatedFinishError(gen.delta.finishReason));
        }
        await writable.write(
          sse(doneLine(assistantText, bind, gen.delta.finishReason, resolvedProvider)),
        );
        await writable.close();
        const completedResult: TurnLoopResult = {
          status: 'completed',
          deltas,
          messages,
          rounds: round,
          steps,
        };
        logTurnLoop({
          status: completedResult.status,
          ...(deps.deadlineAt !== undefined
            ? { elapsedMs: boundedElapsedMs(deps.deadlineAt) }
            : {}),
        });
        return completedResult;
      }

      // User-line persist: first model round that returned tools. Same "always
      // persist after this in-budget model" pattern as terminal (may increment
      // steps one past the cap). Once per run.
      if (!didUserLinePersist) {
        await persistOnce(false);
        didUserLinePersist = true;
      }

      // One tool-batch step for this round's toolCalls (plan #880 / #872).
      // Independent calls overlap inside the step; serial separators
      // (bind-mutators + FS editors) split waves.
      // Live tool_result SSE is written inside the step — do not dump here
      // (would reintroduce N writeTurnSse Fluid steps).
      if (steps >= cap) break;
      // Whole-batch wall boundary (plan #923): before dispatching the batch —
      // in-wave aborts of already-dispatched calls stay best-effort, but the
      // batch boundary + deadline signal covers the evidence case (long model
      // rounds) and the loop terminates ≤ one wave past the deadline.
      if (deadlineElapsed()) {
        return wallWrapUp(round, steps);
      }
      steps += 1;
      const batch = await deps.toolStep({
        calls,
        freshnessSeed: freshness,
        persistRunBind: bind,
      });
      const items: ToolBatchItem[] = batch.ok
        ? batch.results
        : (batch.results ?? []);
      if (batch.ok) {
        // Live ledger snapshot from the step — do NOT clobber with per-item
        // serialize-at-complete times (adversarial #881 Major: last-item-wins
        // under Promise.all drops earlier-finishing grants).
        freshness = batch.freshnessDelta;
      }

      for (const item of items) {
        if (item.ok) {
          deltas.push(item);
          messages.push({
            role: 'tool',
            toolName: item.toolName,
            toolCallId: item.toolCallId,
            result: item.result,
          });
          const rowBind = toolRowBind(messages[messages.length - 1]);
          if (rowBind.cwd !== undefined || rowBind.activeSandboxId !== undefined) {
            bind = { ...bind, ...rowBind };
          }
        } else {
          deltas.push(item);
          messages.push({
            role: 'tool',
            toolName: item.toolName,
            toolCallId: item.toolCallId,
            ok: false,
            error: item.error,
          });
        }
      }

      const cancelled =
        (!batch.ok && batch.code === 'cancelled') ||
        items.some((i) => !i.ok && i.code === 'cancelled');
      if (cancelled) {
        // Persist whatever ran so successes are not dropped, then fail.
        // Cancel used to skip this (adversarial #881 Major) — #871 persist
        // cadence was per-tool; the batch must persist-then-fail the same as
        // a dying turn. Do **not** gate on `steps < cap`: the batch is often
        // the last in-budget step (matrix 3b). Fail/cancel return before
        // wrap-up, so skipping here drops sibling results.
        if (items.length > 0) {
          await persistOnce(true);
        }
        const cancelledItem = items.find(
          (i): i is Extract<ToolBatchItem, { ok: false }> =>
            !i.ok && i.code === 'cancelled',
        );
        const err =
          !batch.ok && batch.code === 'cancelled'
            ? batch.error
            : cancelledItem?.error;
        return fail('cancelled', round, steps, err);
      }
      const wallStopped =
        (!batch.ok && batch.code === 'wall_clock') ||
        items.some((i) => !i.ok && i.code === 'wall_clock');
      if (wallStopped) {
        // Whole-batch / in-batch wall sentinel (plan #923): persist whatever
        // partial successes ran (siblings must not be dropped, same rule as the
        // cancelled-batch path), then the wall wrap-up terminal. The wrap-up
        // itself persists once more + closes + writes the SSE error.
        if (items.length > 0) {
          await persistOnce(true);
        }
        return wallWrapUp(round, steps);
      }
      if (!batch.ok && items.length === 0) {
        // Whole-step fail before any call (assemble / not-found with no
        // results). No live tool_result was written — emit one per call so
        // sibling model-step tool_starts are not left `running…`, and record
        // the errors so the next model round sees them (a tool miss is not
        // a turn-end).
        for (const call of calls) {
          messages.push({
            role: 'tool',
            toolName: call.toolName,
            toolCallId: call.toolCallId,
            ok: false,
            error: batch.error,
          });
          await writable.write(
            sse(toolResultLine(call.toolName, false, batch.error, call.toolCallId)),
          );
        }
      }

      if (steps < cap) {
        await persistOnce(false);
      }

    }

    // Step budget exhausted (model + tool step count hit the cap): never
    // infinite. Cap often lands with open tool_calls (mid-fanout, or the
    // last in-budget step was the user-line persist after a tools round).
    // Close those pairs first so the wrap-up user Error is a legal next
    // message — otherwise the provider rejects and the model never sees
    // the cap. Then one tools-off wrap-up so the model can tell the user
    // what completed. Terminal persist, then SSE `done` with the wrap-up
    // text — a loop bound is not a failed turn. A wrap-up inference failure
    // is a real model error and still fails.
    const skipped = unpairedToolRows(messages, STEP_BUDGET_ERROR);
    for (const row of skipped) {
      messages.push(row);
      await writable.write(sse(toolResultLine(row.toolName, false, row.error, row.toolCallId)));
    }
    // Wrap-up Error: instruction is model-only — pass a copy, do not push it
    // onto the loop transcript (checkpoint / Blob snapshot / F5).
    const wrapMessages: unknown[] = [
      ...messages,
      { role: 'error', content: STEP_BUDGET_WRAPUP },
    ];
    let wrap: Awaited<ReturnType<ModelStepFn>>;
    try {
      wrap = await deps.modelStep({
        messages: wrapMessages,
        persistRunBind: bind,
        disableTools: true,
        wrapUp: 'steps',
      });
    } catch (err) {
      // Same as `{ok:false}`: still terminal-persist. A throw must not skip
      // persistNow and leave the envelope running (F5 attach).
      const error = err instanceof Error ? err.message : String(err);
      wrap = { ok: false, code: 'model_error', error };
    }
    if (wrap.ok) {
      const wrapDelta: TurnLoopDelta = {
        text: wrap.delta.text,
        toolCalls: [], // ignore — wrap-up must not run more tools
        ...(wrap.delta.usage !== undefined ? { usage: wrap.delta.usage } : {}),
        ...(wrap.delta.finishReason !== undefined
          ? { finishReason: wrap.delta.finishReason }
          : {}),
        ...(typeof wrap.delta.resolvedProvider === 'string' &&
        wrap.delta.resolvedProvider.length > 0
          ? { resolvedProvider: wrap.delta.resolvedProvider }
          : {}),
      };
      deltas.push(wrapDelta);
      usage = accumulateUsage(usage, wrapDelta.usage);
      if (wrapDelta.resolvedProvider) {
        resolvedProvider = wrapDelta.resolvedProvider;
      }
      if (wrapDelta.text) assistantText += wrapDelta.text;
      messages.push({ role: 'assistant', delta: wrapDelta });
    }
    await persistOnce(true);
    if (!wrap.ok) {
      return fail('failed', round, steps, wrap.error);
    }
    if (isProviderRefusalFinish(wrap.delta.finishReason)) {
      return fail('failed', round, steps, truncatedFinishError(wrap.delta.finishReason));
    }
    await writable.write(sse(doneLine(assistantText, bind, wrap.delta.finishReason, resolvedProvider)));
    await writable.close();
    const cappedSteps: TurnLoopResult = {
      status: 'capped',
      deltas,
      messages,
      rounds: round,
      steps,
      reason: 'steps',
    };
    logTurnLoop({
      status: cappedSteps.status,
      reason: cappedSteps.reason,
      ...(deps.deadlineAt !== undefined
        ? { elapsedMs: boundedElapsedMs(deps.deadlineAt) }
        : {}),
    });
    return cappedSteps;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await persistOnce(true);
    } catch {
      // Persist must not skip the writable close on stream death.
    }
    return fail('failed', round, steps, message);
  }
}
