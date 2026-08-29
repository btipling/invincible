/**
 * backend-agents B12 (#806) / plan #880 — `toolExecuteStep`: the **tool** half
 * of the durable turn loop, as one `'use step'` boundary.
 *
 * Thin directive shell over the B10 core `executeTool`. One model round's
 * `toolCalls` run in **this** step: assemble the tool world once, split waves
 * at serial separators (bind-mutators + FS editors). Independent calls
 * `Promise.all` inside a wave; a hard `{ok:false}` skips later waves
 * (sequential main stopped the round there). Live-write `tool_result` on one
 * held Workflows writer. `executeTool` stays one-call.
 *
 * In **production** the tool world is assembled IN-STEP via the shared
 * `assembleDurableToolWorld` helper (same path as `modelGenerateStep`). The
 * route MUST NOT wire the module-level resolver — Vercel step VMs don't share
 * the route's module state. `setToolWorldResolver` is a TEST-ONLY override:
 * when set (tests), it wins; when unset (prod), the step uses the shared helper.
 *
 * After a successful `meta_sandbox_switch` (result parses to an
 * `activeSandboxId` — not a soft `ERROR …` string), the step re-assembles
 * before the next wave (FS execute closures are bound to the previous
 * sandbox client). `change_dir` mutates in-memory `cwdState` — no re-assemble.
 * `write_file` / `str_replace` are serial separators so `assertCanEdit` sees
 * preceding `read_file` grants (adversarial #881 round-4) — no re-assemble.
 *
 * **Zero non-serializable step args:** the ONLY args are plain serializable
 * values. Closures / AbortSignal / bound runners can never pass the step
 * boundary. MCP/HTTP/sandbox handles are closed in a `finally` block.
 *
 * Business errors are **values**, not throws. Infra/transient failures on a
 * **1-call** batch retry in-process (4 attempts = Workflows' 1+3 budget) then
 * re-throw. `maxRetries = 0` so a timeout/kill cannot platform-replay a
 * batch that already mutated (adversarial #881 round-6). A throw with a
 * successful sibling is caught (allSettled) so Workflows cannot retry the
 * whole batch and re-apply writes. The batch freshness seed is always
 * snapshotted from the **live** ledger after the wave — never last-item-wins.
 */

import {
  executeTool,
  type ExecuteToolDeps,
  type ExecuteToolResult,
} from '../agent/executeTool';
import {
  serializeRunFileFreshness,
  type RunFileFreshness,
} from '../agent/fileFreshness';
import type { HttpFetchRunner } from '../agent/httpFetchTypes';
import {
  changeDirSuccessCwd,
  metaSandboxSwitchActiveId,
} from '../agent/toolResultParsers';
import type { PersistRunBind, ToolBatchItem, TurnToolCallDelta } from './turnLoop';
import { formatLiveToolResultSse } from './turnSseFormat';
import { withDefaultStreamWriter } from './turnSseWrite';
import { splitToolWaves } from './toolWaves';

/** Serialized `toolExecuteStep` step args — plain values only. */
export interface ToolExecuteStepArgs {
  /** This model round's toolCalls. One step regardless of length. */
  calls: ReadonlyArray<TurnToolCallDelta>;
  /** B5-serialized file-freshness ledger seed to hydrate in-step (optional). */
  freshnessSeed?: string;
  /**
   * Serializable session scope for in-step world construction (prod path).
   */
  scope?: { tenantId: string; userId: string; sessionId: string };
  /**
   * Running sandbox bind (cwd, activeSandboxId) — passed to the shared helper
   * for FS tool assembly + sandbox resolution.
   */
  persistRunBind?: PersistRunBind;
}

/** Fail-closed step result (batch). */
export type ToolExecuteStepResult =
  | { ok: true; results: ToolBatchItem[]; freshnessDelta: string }
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
      results?: ToolBatchItem[];
    };

export type ToolWorldResolver = (args: ToolExecuteStepArgs) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: Record<string, any>;
  secrets?: Array<string | undefined | null>;
  signal?: AbortSignal;
  freshness?: unknown;
  mcpClose?: () => Promise<void>;
  httpRunner?: HttpFetchRunner;
  sandboxClientClose?: () => Promise<void>;
};

let resolveToolWorld: ToolWorldResolver = () => {
  throw new Error(
    'toolExecuteStep: no tool-world resolver wired — call setToolWorldResolver (tests) or pass scope for prod in-step assembly.',
  );
};

/** Wire the run-scoped tool-world resolver (TEST override). */
export function setToolWorldResolver(fn: ToolWorldResolver): void {
  resolveToolWorld = fn;
}

type WorldHandles = {
  registry: Record<string, unknown>;
  secrets: Array<string | undefined | null>;
  signal: AbortSignal;
  freshness: unknown;
  mcpClose?: () => Promise<void>;
  httpRunner?: HttpFetchRunner;
  sandboxClientClose?: () => Promise<void>;
};

type FailCode = Extract<ToolBatchItem, { ok: false }>['code'];

async function closeHandles(w: WorldHandles | undefined): Promise<void> {
  if (!w) return;
  if (w.mcpClose) {
    try { await w.mcpClose(); } catch { /* ignore */ }
  }
  if (w.httpRunner) {
    try { await w.httpRunner.close(); } catch { /* ignore */ }
  }
  if (w.sandboxClientClose) {
    try { await w.sandboxClientClose(); } catch { /* ignore */ }
  }
}

function liveFreshnessDelta(freshness: unknown, fallback: string): string {
  if (
    freshness &&
    typeof freshness === 'object' &&
    typeof (freshness as RunFileFreshness).snapshot === 'function'
  ) {
    return serializeRunFileFreshness(freshness as RunFileFreshness);
  }
  return fallback;
}

function failItem(
  call: TurnToolCallDelta,
  code: FailCode,
  error: string,
): ToolBatchItem {
  return {
    ok: false,
    toolName: call.toolName,
    ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
    code,
    error,
  };
}

function toItem(call: TurnToolCallDelta, r: ExecuteToolResult): ToolBatchItem {
  if (r.ok) {
    return {
      ok: true,
      toolName: call.toolName,
      ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
      result: r.result,
      freshnessDelta: r.freshnessDelta,
    };
  }
  return failItem(call, r.code, r.error);
}

function sseFor(item: ToolBatchItem): string {
  if (item.ok) {
    const cwd = changeDirSuccessCwd(item.result);
    const sid = metaSandboxSwitchActiveId(item.result);
    return formatLiveToolResultSse({
      name: item.toolName,
      ok: true,
      summary: item.result,
      ...(item.toolCallId ? { id: item.toolCallId } : {}),
      ...(cwd ? { changeDirCwd: cwd } : {}),
      ...(sid ? { activeSandboxId: sid } : {}),
    });
  }
  return formatLiveToolResultSse({
    name: item.toolName,
    ok: false,
    summary: item.error,
    ...(item.toolCallId ? { id: item.toolCallId } : {}),
  });
}

function overlayBind(
  bind: PersistRunBind | undefined,
  item: ToolBatchItem,
): PersistRunBind | undefined {
  if (!item.ok) return bind;
  const cwd = changeDirSuccessCwd(item.result);
  const sid = metaSandboxSwitchActiveId(item.result);
  if (cwd === undefined && sid === undefined) return bind;
  return {
    ...bind,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(sid !== undefined ? { activeSandboxId: sid } : {}),
  };
}

/**
 * Run this round's toolCalls as one workflow step. Assemble once. Waves at
 * serial separators (bind-mutators + FS editors). Live `tool_result` on one
 * held writer.
 */
export async function toolExecuteStep(
  args: ToolExecuteStepArgs,
): Promise<ToolExecuteStepResult> {
  'use step';

  const calls = args.calls ?? [];
  let world: WorldHandles | undefined;
  let bind: PersistRunBind | undefined = args.persistRunBind
    ? { ...args.persistRunBind }
    : undefined;

  const openWorld = async (
    nextBind: PersistRunBind | undefined,
    freshnessSeed: string | undefined,
  ): Promise<
    | { ok: true; world: WorldHandles }
    | { ok: false; code: 'sandbox_error'; error: string }
  > => {
    const stepArgs: ToolExecuteStepArgs = {
      calls,
      ...(freshnessSeed !== undefined ? { freshnessSeed } : {}),
      ...(args.scope ? { scope: args.scope } : {}),
      ...(nextBind ? { persistRunBind: nextBind } : {}),
    };
    try {
      const w = resolveToolWorld(stepArgs);
      return {
        ok: true,
        world: {
          registry: w.registry ?? {},
          secrets: w.secrets ?? [],
          signal: w.signal ?? new AbortController().signal,
          freshness: w.freshness,
          mcpClose: w.mcpClose,
          httpRunner: w.httpRunner,
          sandboxClientClose: w.sandboxClientClose,
        },
      };
    } catch {
      if (!args.scope) {
        throw new Error(
          'toolExecuteStep: no tool-world resolver wired and no scope provided — the route must pass scope on start() args.',
        );
      }
      const { assembleDurableToolWorld } = await import(
        './assembleDurableToolWorld'
      );
      const assembled = await assembleDurableToolWorld({
        scope: args.scope,
        persistRunBind: nextBind,
        freshnessSeed,
      });
      if (!assembled.ok) {
        return { ok: false, code: 'sandbox_error', error: assembled.error };
      }
      const { world: aw } = assembled;
      return {
        ok: true,
        world: {
          registry: aw.registry,
          secrets: aw.secrets,
          signal: aw.signal,
          freshness: aw.freshness,
          mcpClose: aw.mcpClose,
          httpRunner: aw.httpRunner,
          sandboxClientClose: aw.sandboxClientClose,
        },
      };
    }
  };

  try {
    const opened = await openWorld(bind, args.freshnessSeed);
    if (!opened.ok) {
      return { ok: false, code: 'sandbox_error', error: opened.error };
    }
    world = opened.world;

    const results: ToolBatchItem[] = [];
    let freshnessDelta = args.freshnessSeed ?? '[]';
    let assembleFail: string | undefined;

    await withDefaultStreamWriter(async (write) => {
      let writeChain = Promise.resolve();
      const writeSafe = (line: string): Promise<void> => {
        const p = writeChain.then(() => write(line));
        writeChain = p.then(
          () => undefined,
          () => undefined,
        );
        // Never reject — a live-paint fail must not fail/retry a completed
        // execute or drop sibling results (adversarial #881 round-3/4).
        return writeChain;
      };

      const runOne = async (call: TurnToolCallDelta): Promise<ToolBatchItem> => {
        const executeDeps: ExecuteToolDeps = {
          registry: world!.registry ?? {},
          freshness: (world!.freshness ?? {}) as ExecuteToolDeps['freshness'],
          secrets: world!.secrets,
          signal: world!.signal,
        };
        const r = await executeTool(executeDeps, {
          toolName: call.toolName,
          args: call.args,
        });
        const item = toItem(call, r);
        try {
          await writeSafe(sseFor(item));
        } catch {
          // Live paint failed. Do not fail/retry a completed execute
          // (adversarial #881 round-3 Minor: 1-call writer reject used to
          // rethrow → SDK 3× re-apply).
        }
        return item;
      };

      // allSettled: a throw from one call must not reject the wave (that would
      // drop sibling results and let Workflows retry the whole batch). A 1-call
      // batch retries in-process (4 attempts) then rethrows so a lone daemon
      // blip still recovers — without a platform replay of an N-call mutation
      // set (`maxRetries = 0`, adversarial #881 round-6).
      const runOneCaught = async (
        call: TurnToolCallDelta,
      ): Promise<ToolBatchItem> => {
        const attempts = calls.length === 1 ? 4 : 1;
        let lastErr: unknown;
        for (let i = 0; i < attempts; i++) {
          try {
            return await runOne(call);
          } catch (err) {
            lastErr = err;
            if (i + 1 < attempts) continue;
            if (calls.length === 1) throw err;
            const item = failItem(
              call,
              'sandbox_error',
              err instanceof Error ? err.message : String(err),
            );
            await writeSafe(sseFor(item));
            return item;
          }
        }
        throw lastErr;
      };

      for (const wave of splitToolWaves(calls)) {
        const ran = wave.parallel
          ? await Promise.all(wave.calls.map((c) => runOneCaught(c)))
          : [await runOneCaught(wave.calls[0]!)];
        for (const item of ran) {
          results.push(item);
          bind = overlayBind(bind, item);
        }
        freshnessDelta = liveFreshnessDelta(world?.freshness, freshnessDelta);
        // allSettled is per-wave (in-flight siblings finish). A hard fail must
        // not run later serial waves — sequential main stopped the round at the
        // first `{ok:false}` (adversarial #881 round-5). Remaining calls get
        // skip results below so hanging tool_starts close.
        if (results.some((i) => !i.ok)) {
          break;
        }
        const only = wave.calls[0];
        const switchResult =
          !wave.parallel &&
          only?.toolName === 'meta_sandbox_switch' &&
          ran[0]?.ok
            ? ran[0].result
            : undefined;
        if (
          switchResult !== undefined &&
          metaSandboxSwitchActiveId(switchResult)
        ) {
          const seed = liveFreshnessDelta(world?.freshness, freshnessDelta);
          await closeHandles(world);
          world = undefined;
          let next: Awaited<ReturnType<typeof openWorld>>;
          try {
            next = await openWorld(bind, seed);
          } catch (err) {
            next = {
              ok: false,
              code: 'sandbox_error',
              error: err instanceof Error ? err.message : String(err),
            };
          }
          if (!next.ok) {
            // Do not push a second row for the same toolCallId — the switch
            // itself succeeded; remaining calls get explicit skip results.
            assembleFail = next.error;
            break;
          }
          world = next.world;
        }
      }

      // Close hanging tool_starts for calls that never ran (cancel /
      // re-assemble / later-wave skip after a hard fail).
      if (results.length < calls.length) {
        const failed = results.find(
          (i): i is Extract<ToolBatchItem, { ok: false }> => !i.ok,
        );
        const code: FailCode = assembleFail
          ? 'sandbox_error'
          : failed?.code ?? 'sandbox_error';
        const error =
          assembleFail ?? failed?.error ?? 'tool batch stopped';
        for (const call of calls.slice(results.length)) {
          const item = failItem(call, code, error);
          results.push(item);
          await writeSafe(sseFor(item));
        }
      }
    });

    const cancelled = results.find((i) => !i.ok && i.code === 'cancelled');
    if (cancelled && !cancelled.ok) {
      return {
        ok: false,
        code: 'cancelled',
        error: cancelled.error,
        results,
      };
    }
    if (assembleFail) {
      return {
        ok: false,
        code: 'sandbox_error',
        error: assembleFail,
        results,
      };
    }
    return { ok: true, results, freshnessDelta };
  } finally {
    await closeHandles(world);
  }
}

/**
 * Workflows retries a failed `'use step'` 3× by default. A batch that already
 * applied serial writes must not be replayed on timeout/kill (adversarial
 * #881 round-6). 1-call infra throws retry in-process above (4 attempts) so a
 * lone daemon blip still recovers without a platform replay of N-call mutations.
 */
(toolExecuteStep as typeof toolExecuteStep & { maxRetries: number }).maxRetries = 0;
