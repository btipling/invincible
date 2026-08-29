/**
 * backend-agents B12 (#806) / plan #880 — `toolExecuteStep`: the **tool** half
 * of the durable turn loop, as one `'use step'` boundary.
 *
 * Thin directive shell over the B10 core `executeTool`. One model round's
 * `toolCalls` run in **this** step: assemble the tool world once, split waves
 * at bind-mutators, `Promise.all` inside a wave, live-write `tool_result` on
 * one held Workflows writer. `executeTool` stays one-call.
 *
 * In **production** the tool world is assembled IN-STEP via the shared
 * `assembleDurableToolWorld` helper (same path as `modelGenerateStep`). The
 * route MUST NOT wire the module-level resolver — Vercel step VMs don't share
 * the route's module state. `setToolWorldResolver` is a TEST-ONLY override:
 * when set (tests), it wins; when unset (prod), the step uses the shared helper.
 *
 * After a successful `meta_sandbox_switch`, the step re-assembles before the
 * next wave (FS execute closures are bound to the previous sandbox client).
 * `change_dir` mutates in-memory `cwdState` — no re-assemble.
 *
 * **Zero non-serializable step args:** the ONLY args are plain serializable
 * values. Closures / AbortSignal / bound runners can never pass the step
 * boundary. MCP/HTTP/sandbox handles are closed in a `finally` block.
 *
 * Business errors are **values**, not throws. Infra/transient failures re-throw
 * so the SDK's 3× retry applies only there.
 */

import {
  executeTool,
  type ExecuteToolDeps,
  type ExecuteToolResult,
} from '../agent/executeTool';
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
  return {
    ok: false,
    toolName: call.toolName,
    ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}),
    code: r.code,
    error: r.error,
  };
}

function sseFor(item: ToolBatchItem): string {
  if (item.ok) {
    const cwd = changeDirSuccessCwd(item.result);
    const sid = metaSandboxSwitchActiveId(item.result);
    return formatLiveToolResultSse({
      name: item.toolName,
      ok: true,
      summary: item.result,
      ...(cwd ? { changeDirCwd: cwd } : {}),
      ...(sid ? { activeSandboxId: sid } : {}),
    });
  }
  return formatLiveToolResultSse({
    name: item.toolName,
    ok: false,
    summary: item.error,
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
 * bind-mutators. Live `tool_result` on one held writer.
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

    await withDefaultStreamWriter(async (write) => {
      let writeChain = Promise.resolve();
      const writeSafe = (line: string): Promise<void> => {
        const p = writeChain.then(() => write(line));
        writeChain = p.then(
          () => undefined,
          () => undefined,
        );
        return p;
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
        await writeSafe(sseFor(item));
        return item;
      };

      for (const wave of splitToolWaves(calls)) {
        const ran = wave.parallel
          ? await Promise.all(wave.calls.map((c) => runOne(c)))
          : [await runOne(wave.calls[0]!)];
        for (const item of ran) {
          results.push(item);
          if (item.ok) freshnessDelta = item.freshnessDelta;
          bind = overlayBind(bind, item);
        }
        if (results.some((i) => !i.ok && i.code === 'cancelled')) {
          break;
        }
        const only = wave.calls[0];
        if (
          !wave.parallel &&
          only?.toolName === 'meta_sandbox_switch' &&
          ran[0]?.ok
        ) {
          const seed = ran[0].ok ? ran[0].freshnessDelta : freshnessDelta;
          await closeHandles(world);
          world = undefined;
          const next = await openWorld(bind, seed);
          if (!next.ok) {
            results.push({
              ok: false,
              toolName: only.toolName,
              ...(only.toolCallId ? { toolCallId: only.toolCallId } : {}),
              code: 'sandbox_error',
              error: next.error,
            });
            break;
          }
          world = next.world;
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
    return { ok: true, results, freshnessDelta };
  } finally {
    await closeHandles(world);
  }
}
