/**
 * backend-agents B12 — `compactionStep` (plan #950, source #552 — A4 compaction
 * phase 3 of parent #947): the pre-loop **summarizer** `'use step'`.
 *
 * Runs ONCE, before the first model round, when the route trigger decided to
 * compact (parent #947 Goal 1 — trigger, then summarize, then loop). The
 * summarizer is a plain model round over the compaction SPAN only:
 *  - re-resolves BYOK in-step (same seam as `modelGenerateStep` — the route
 *    never passes credentials),
 *  - no tools (schemas-only absent — a summarizer must never call tools),
 *  - honesty system prompt (parent Goal 4: the output is persisted as a
 *    labeled `user` row — "compacted, not live assistant prose" — never
 *    framed as live prose),
 *  - output text is bounded by `COMPACTION_SUMMARY_MAX_CHARS` at
 *    `buildCheckpoint` time (phase 1) — the step returns the raw delta text
 *    and never truncates itself (no second cap, no silent drop).
 *
 * Serializable-only args (adversarial L1, same discipline as every step):
 * `span` is the plain row array from the route-side cut walk, `modelId` the
 * requested model. Model/BYOK/empty failure → `{ ok:false, code:'summarize_failed' }`
 * — the WORKFLOW treats that as fail-open (turn proceeds uncompacted). G22
 * Stop (`'cancelled'`) and the 1h wall (`'wall_clock'`) are forwarded, never
 * remapped to fail-open (adversarial #955 follow-up 16). Compaction must
 * never 5xx the turn (parent edge-case lock) and must never swallow Stop.
 *
 * Static graph: this file is a `'use step'` leaf — its import closure is the
 * B9 core (`generateOneRound`) + DI (in-step BYOK resolve) + the loop log,
 * nothing banned (the staticGraph walker records step files as leaves; the
 * entry-side closure is unaffected because the workflow entry reaches this
 * file only as its own step import — same pattern as `modelGenerateStep`).
 */
import { withDefaultStreamWriter } from './turnSseWrite';
import { logTurnModel } from './turnLog';
import { deadlineSignal, isDeadlineElapsed } from './turnDeadline';
import { toModelMessages } from './toModelMessages';
import { TURN_WALL_CLOCK_ERROR } from '../agent/modelFinish';
import {
  generateOneRound,
  type OneRoundDelta,
} from '../agent/generateOneRound';

/**
 * Honesty system prompt for the summarizer round (parent #947 Goal 4). The
 * model is told its text becomes the persisted compaction summary row —
 * named truthfully, never framed as live assistant prose. No tools exist in
 * this round (no tool schemas are passed), so the prompt also forbids
 * pretending to run them.
 */
export const COMPACTION_SUMMARIZER_SYSTEM =
  'You are the Invincible session summarizer. Write a dense summary of the conversation excerpt you are given so an agent can resume work from it alone. Include: the user goal, decisions made, files read or modified and what changed, current state, and concrete next steps. Do not call tools (you have none). Be concise and factual; the text is stored verbatim as "Summary of earlier session (compacted, not live assistant prose)".';

/** Serialized `compactionStep` step args — plain values only. */
export interface CompactionStepArgs {
  /** Requested model id (the session's selected model). */
  modelId: string;
  /**
   * The compaction SPAN rows (route-side `findCompactionCut().span`) — the
   * plain serializable row array to summarize. Plain values only; the
   * summarizer never sees the retained tail or the current ask.
   */
  span: ReadonlyArray<unknown>;
  /** Serializable session scope for in-step BYOK seam construction. */
  scope: { tenantId: string; userId: string; sessionId: string };
  /**
   * Absolute epoch deadline (ms) for the 1-hour wall-clock cap (plan #923).
   * The summarizer runs inside the turn's deadline: fail closed with the
   * dedicated sentinel when already elapsed, same as `modelGenerateStep`.
   */
  deadlineAt?: number;
}

/** Fail-closed step result. `summarize_failed` is fail-open upstream. */
export type CompactionStepResult =
  | { ok: true; summary: string }
  | { ok: false; code: 'summarize_failed' | 'wall_clock' | 'cancelled'; error: string };

function isAbortErr(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name.toLowerCase();
  return name === 'aborterror' || name === 'responseaborted' || name === 'cancelled';
}

/**
 * Run the pre-loop summarizer as ONE workflow step: re-resolve BYOK in-step,
 * run a single tools-off model round over the span, return the delta text.
 * No SSE is written for the summarizer round — the summary becomes a
 * server-side row at seed time (the canvas paints nothing new; parent Goal
 * 4), so the delta text is returned as a value instead of streamed.
 */
export async function compactionStep(
  args: CompactionStepArgs,
): Promise<CompactionStepResult> {
  'use step';

  // Wall-clock cap (plan #923): an already-elapsed deadline cannot usefully
  // run the summarizer — fail closed with the wall sentinel (the loop treats
  // it like any wall-clock outcome, not a silent skip).
  if (args.deadlineAt !== undefined && Date.now() >= args.deadlineAt) {
    logTurnModel({ ok: false, code: 'wall_clock' });
    return { ok: false, code: 'wall_clock', error: 'compaction summarizer past deadline' };
  }

  let deps: Parameters<typeof generateOneRound>[0];
  try {
    // Same DI seam as modelGenerateStep — BYOK is re-resolved INSIDE the
    // step (the route never passes credentials through start() args).
    const services = (await import('../di/index')).createProdServices();
    const byok = await services.resolveInferenceForRequest.resolveByokForRequest(
      args.scope.userId,
      args.modelId,
    );
    if (!byok.ok) {
      logTurnModel({ ok: false, code: 'summarize_failed' });
      return { ok: false, code: 'summarize_failed', error: 'byok resolve failed for summarizer' };
    }
    deps = {
      modelId: byok.modelId,
      providerOptions: {
        gateway: {
          only: byok.only,
          byok: byok.byok,
        },
      },
      secrets: byok.secretsToRedact,
      system: COMPACTION_SUMMARIZER_SYSTEM,
      signal: deadlineSignal(args.deadlineAt),
      wallClockDeadlineAt: args.deadlineAt,
      reasoning: 'none',
    };
  } catch (err) {
    if (isAbortErr(err)) {
      const wall = isDeadlineElapsed(args.deadlineAt);
      const code = wall ? 'wall_clock' : 'cancelled';
      logTurnModel({ ok: false, code });
      return {
        ok: false,
        code,
        error: wall ? TURN_WALL_CLOCK_ERROR : 'Request cancelled.',
      };
    }
    logTurnModel({ ok: false, code: 'summarize_failed' });
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'summarize_failed', error };
  }

  // One tools-off model round over the span. Empty schemas — the
  // summarizer cannot call tools by construction (parent forbidden list).
  // No live SSE: the delta is returned, never streamed (see file doc).
  try {
    const result = await withDefaultStreamWriter(async () =>
      generateOneRound(deps, {
        // Same converter as `modelGenerateStep`: orchestrator-local
        // assistant/tool rows are not AI SDK `ModelMessage`s. A real overflow
        // span is assistant+tool (adversarial #955); passing it raw fail-opens
        // the summarizer.
        messages: toModelMessages(args.span),
        tools: {},
        onEvent: () => {},
      }),
    );
    if (!result.ok) {
      // G22 Stop and the 1h wall must not become fail-open (adversarial
      // #955 follow-up 16). Deadline-elapsed `'cancelled'` is `'wall_clock'`,
      // same as `modelGenerateStep`.
      const code =
        result.code === 'wall_clock' ||
        (result.code === 'cancelled' && isDeadlineElapsed(args.deadlineAt))
          ? 'wall_clock'
          : result.code === 'cancelled'
            ? 'cancelled'
            : 'summarize_failed';
      logTurnModel({ ok: false, code });
      return {
        ok: false,
        code,
        error:
          code === 'wall_clock'
            ? result.code === 'wall_clock'
              ? result.error
              : TURN_WALL_CLOCK_ERROR
            : result.error,
      };
    }
    const delta: OneRoundDelta = result.delta;
    logTurnModel({ ok: true, textChars: delta.text.length });
    return { ok: true, summary: delta.text };
  } catch (err) {
    if (isAbortErr(err)) {
      const wall = isDeadlineElapsed(args.deadlineAt);
      const code = wall ? 'wall_clock' : 'cancelled';
      logTurnModel({ ok: false, code });
      return {
        ok: false,
        code,
        error: wall ? TURN_WALL_CLOCK_ERROR : 'Request cancelled.',
      };
    }
    logTurnModel({ ok: false, code: 'summarize_failed' });
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'summarize_failed', error };
  }
}
