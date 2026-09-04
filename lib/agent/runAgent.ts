import { generateText, streamText } from 'ai';
import {
  changeDirSuccessCwd,
  mapFullStreamPart,
  summarizeToolLine,
} from './agentStream';
import { mapProviderUsage, type UsageSummary } from './usageSummary';
import { resolveAgentReasoning } from './reasoningConfig';
import { resolveAgentMaxSteps } from '../sandbox/config';
import { type SandboxClient } from '../sandbox/client';
import type { ServerSecrets } from '../di';
import { createAgentTools, type CwdState } from './tools';
import type { SandboxInfoBind } from './sandboxInfo';
import {
  createRunFileFreshness,
  type RunFileFreshness,
} from './fileFreshness';
import { normalizeWorkspaceRel } from './workPath';
import { redactSecrets } from './redact';
import {
  flattenToolResultText,
  parseAndFlattenIfMcpEnvelope,
} from './toolResultText';
import { resolveSystem } from './agentSystem';
import { metaSandboxSwitchTargetId } from './metaSandboxTools';
import { resolveAgentStopWhen } from './stopWhen';

export type ToolTraceEntry = {
  name: string;
  ok: boolean;
  summary: string;
  /**
   * Confirmed `change_dir` cwd carried as a TYPED field from the raw tool result
   * (not re-derived from the truncated `summary`). Host persistence relies on
   * this, never on the display summary (adversarial review #470 Major).
   */
  cwd?: string;
};

export type RunAgentParams = {
  prompt: string;
  signal?: AbortSignal;
  /**
   * Optional step ceiling (tests / explicit override).
   * When omitted, uses `resolveAgentMaxSteps()` — `null` means model-ended loop.
   */
  maxSteps?: number | null;
  /**
   * Required server-resolved model id (request-scoped BYOK). No env fallback —
   * the route always resolves and supplies it.
   */
  modelId: string;
  system?: string;
  /** Request-scoped Gateway BYOK. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerOptions?: any;
  /** Inject for tests — same shape as `generateText` from `ai`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generateTextImpl?: (args: any) => Promise<any>;
  /** Inject for tests — same shape as `streamText` from `ai`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  streamTextImpl?: (args: any) => any;
  /**
   * Optional FS sandbox client. Per phase-2 DI, the caller resolves + constructs
   * it through the composition root (`createProdServices` service slicing) and
   * injects it here — runAgent never constructs a sandbox client itself. When
   * omitted and sandbox env is missing, FS tools are skipped (http-only / MCP-only
   * paths). Throws only when no tools at all would remain *and* no extraTools were
   * provided — callers that need a hard error should check config at the route layer.
   */
  sandboxClient?: SandboxClient;
  secrets?: Array<string | undefined | null>;
  /**
   * Server secrets resolved once at the composition root (phase 2 — #439); never
   * read from `process.env` in this module. Merged into the redaction list for
   * model-facing / client-facing strings.
   */
  serverSecrets?: ServerSecrets;
  /** Effective grant permissions; default full access when omitted. */
  permissions?: { canRead: boolean; canWrite: boolean };
  /**
   * Optional extra tools (e.g. MCP, builtin http) merged after sandbox tools.
   * Route builds these; tests inject pure maps.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraTools?: Record<string, any>;
  /**
   * When true, do not add FS tools even if a `sandboxClient` was injected (route
   * already decided FS tools are unavailable). Default false.
   */
  skipSandboxTools?: boolean;
  /**
   * Logical workspace cwd for this turn (workspace-root-relative).
   * Default `"."`. Host supplies session cwd; route validates via parseAgentBody.
   */
  initialCwd?: string;
  /**
   * Per-binding jail workspace root R for this turn (the route forwards
   * `resolved.value.workspaceRoot`). Forwarded to createAgentTools so in-jail
   * absolute tool paths canonicalize to the same workspace-relative freshness
   * key as their relative form (BYO + Vercel parity). Null on a faulting BYO
   * probe / pre-v2 daemon — absolute then fails closed while relative + cwd keep
   * working.
   */
  workspaceRoot?: string | null;
  /**
   * Optional inject of the run-scoped file freshness ledger (tests / advanced).
   * When omitted, a new ledger is created for this runAgent / runAgentStream call.
   */
  freshness?: RunFileFreshness;
  /**
   * The resolved active sandbox bind for this turn (route supplies
   * `resolved.value.sandboxId` after a successful resolve). Reflected back on
   * the result / `done` stream event so the host can reconcile the authoritative
   * bind. Omitted when no FS sandbox is bound (soft/MCP/http-only path).
   */
  sandboxId?: string;
  /**
   * Optional non-secret active-bind projection for `sandbox_info`.
   * Route supplies it from `resolved.value` after a successful resolve.
   */
  bind?: SandboxInfoBind;
  /**
   * Persona preamble. Server-resolved persona snapshot text, wrapped by
   * `resolveSystem` in a `<persona_standing_orders>` block after the base
   * system. Empty/whitespace is dropped. Pick-criteria for tools live on
   * each `tool.description`, not in this string.
   */
  personaPreamble?: string;
  /**
   * Skills preamble (phase 2, #517). Server-resolved attached-skill bodies,
   * appended after the persona preamble so the attached skill is the final
   * standing-order block the model sees. Skills are staff-of-work (re-resolved
   * each turn), so this is NOT a locked snapshot. Empty/whitespace is dropped.
   */
  skillsPreamble?: string;
  /**
   * Session working-notes block text (plan #938). The RAW block text from the
   * session envelope `meta.workingNotes`; `resolveSystem` wraps it in the
   * fixed `### Working notes (across turns)` frame between the persona and
   * the skills. Framed as unverified agent-authored working memory (never
   * standing orders). Empty/whitespace is dropped (block omitted entirely).
   */
  notesPreamble?: string;
  /**
   * Optional request reasoning-effort token (plan #897). Wins over env /
   * product default when set.
   */
  reasoning?: string;
};

export type RunAgentResult = {
  text: string;
  toolTrace: ToolTraceEntry[];
  /** Present when FS sandbox tools were active for the turn. */
  cwd?: string;
  /** Resolved active sandbox bind (present when FS sandbox tools were bound). */
  sandboxId?: string;
  /**
   * Post-turn EFFECTIVE active sandbox bind. When a `meta_sandbox_switch`
   * succeeded during the turn this is the switch target (the host must fold
   * THIS onto the session — not the pre-turn `sandboxId` — or it overwrites the
   * envelope write, blocker B1); otherwise it mirrors `sandboxId`. Present when
   * FS tools were bound, or when a switch target exists (soft/http/meta-only
   * path still folds a switch).
   */
  activeSandboxId?: string;
  /**
   * Phase 3 (plan #539 / #327) — bounded provider-usage summary captured at the
   * FINAL completion (JSON result / stream `done`). Absent when the provider
   * reported no usable token counts — never a client estimate.
   */
  usage?: UsageSummary;
};

export { DEFAULT_AGENT_SYSTEM } from './agentSystem';

// Re-export so existing consumers/tests importing `resolveAgentStopWhen` from
// `runAgent` keep working. The definition now lives in `./stopWhen` (hoisted to
// keep B9 `generateOneRound`'s static closure free of `runAgent` → B12 lock).
export { resolveAgentStopWhen } from './stopWhen';


function makeCwdState(initialCwd?: string): CwdState {
  try {
    return { current: normalizeWorkspaceRel(initialCwd ?? '.') };
  } catch {
    return { current: '.' };
  }
}

/** Redaction list = params.secrets + root-resolved server secrets (phase 2 DI). */
function resolveRunSecrets(
  params: RunAgentParams,
): Array<string | undefined | null> {
  return [
    ...(params.secrets ?? []),
    params.serverSecrets?.gatewayKey,
  ];
}

/**
 * Multi-step generateText + optional sandbox / extra tools.
 * Sandbox client is optional when extraTools (http / MCP) supply the tool surface.
 */
export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const maxSteps =
    params.maxSteps !== undefined ? params.maxSteps : resolveAgentMaxSteps();
  const modelId = params.modelId;
  const generate = params.generateTextImpl ?? generateText;

  // Always scrub known server secrets from model-facing and client-facing strings.
  // Secrets come injected (params.secrets + root serverSecrets) — no process.env.
  const secrets = resolveRunSecrets(params);

  let client = params.sandboxClient;
  let hasFsTools = false;

  if (!params.skipSandboxTools) {
    if (client) {
      hasFsTools = true;
    }
  } else if (client) {
    hasFsTools = true;
  }

  // Fail-fast: refuse to run a turn when the sandbox daemon is out of date,
  // rather than letting each tool soft-fail across multiple steps. Tools still
  // soft-fail as belt-and-suspenders if a race bumps expected mid-turn. Absent
  // on non-HTTP backends (Vercel Sandbox SDK), which have no daemonVersion.
  if (client && hasFsTools && typeof client.checkDaemonCurrent === 'function') {
    await client.checkDaemonCurrent();
  }

  const cwdState = makeCwdState(params.initialCwd);
  const freshness = params.freshness ?? createRunFileFreshness();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandboxTools: Record<string, any> = hasFsTools && client
    ? createAgentTools({
        client,
        freshness,
        secrets,
        signal: params.signal,
        permissions: params.permissions,
        cwdState,
        workspaceRoot: params.workspaceRoot,
        bind: params.bind,
      })
    : {};

  const tools = {
    ...sandboxTools,
    ...(params.extraTools ?? {}),
  };

  if (Object.keys(tools).length === 0) {
    // Preserve prior behavior when nothing is available (misconfigured call).
    throw new Error('Sandbox not configured');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const genArgs: any = {
    model: modelId,
    system: resolveSystem(params, hasFsTools),
    prompt: params.prompt,
    tools,
    stopWhen: resolveAgentStopWhen(maxSteps),
    abortSignal: params.signal,
  };
  if (params.providerOptions) {
    genArgs.providerOptions = params.providerOptions;
  }
  const reasoning = resolveAgentReasoning(modelId, {
    request: params.reasoning,
  });
  if (reasoning) {
    genArgs.reasoning = reasoning;
  }

  const result = await generate(genArgs);

  const toolTrace = collectToolTrace(result, secrets);
  let text = redactSecrets((result.text ?? '').trim(), secrets);
  // Pure MCP content-envelope assistant dumps → readable text (#129 / #133).
  const unwrapped = parseAndFlattenIfMcpEnvelope(text);
  if (unwrapped != null) {
    text = redactSecrets(unwrapped, secrets);
  }
  const activeSandboxId =
    metaSandboxSwitchTargetId(result) ??
    (hasFsTools ? params.sandboxId : undefined);
  // Phase 3 (plan #539) — provider usage is only available after `generateText`
  // resolves; capture the bounded summary off the completed result (absent when
  // the provider reported none).
  const usage = mapProviderUsage(result.usage);
  return {
    text,
    toolTrace,
    ...(hasFsTools ? { cwd: cwdState.current } : {}),
    ...(hasFsTools && params.sandboxId ? { sandboxId: params.sandboxId } : {}),
    ...(activeSandboxId !== undefined
      ? { activeSandboxId }
      : {}),
    ...(usage ? { usage } : {}),
  };
}

export type RunAgentStreamHandlers = {
  onEvent: (event: import('./agentStream').AgentStreamEvent) => void | Promise<void>;
};

/**
 * Multi-step streamText path — emits normalized AgentStreamEvents (SSE wire).
 * Caller owns http/MCP runner lifecycle around the full stream.
 */
export async function runAgentStream(
  params: RunAgentParams,
  handlers: RunAgentStreamHandlers,
): Promise<RunAgentResult> {
  const maxSteps =
    params.maxSteps !== undefined ? params.maxSteps : resolveAgentMaxSteps();
  const modelId = params.modelId;
  const stream = params.streamTextImpl ?? streamText;

  // Secrets injected via params + root serverSecrets (no process.env in body).
  const secrets = resolveRunSecrets(params);

  let client = params.sandboxClient;
  let hasFsTools = false;

  if (!params.skipSandboxTools) {
    if (client) {
      hasFsTools = true;
    }
  } else if (client) {
    hasFsTools = true;
  }

  // Fail-fast: refuse to run a turn when the sandbox daemon is out of date,
  // rather than letting each tool soft-fail across multiple steps. Tools still
  // soft-fail as belt-and-suspenders if a race bumps expected mid-turn. Absent
  // on non-HTTP backends (Vercel Sandbox SDK), which have no daemonVersion.
  if (client && hasFsTools && typeof client.checkDaemonCurrent === 'function') {
    await client.checkDaemonCurrent();
  }

  const cwdState = makeCwdState(params.initialCwd);
  const freshness = params.freshness ?? createRunFileFreshness();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandboxTools: Record<string, any> = hasFsTools && client
    ? createAgentTools({
        client,
        freshness,
        secrets,
        signal: params.signal,
        permissions: params.permissions,
        cwdState,
        workspaceRoot: params.workspaceRoot,
        bind: params.bind,
      })
    : {};

  const tools = {
    ...sandboxTools,
    ...(params.extraTools ?? {}),
  };

  if (Object.keys(tools).length === 0) {
    throw new Error('Sandbox not configured');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamArgs: any = {
    model: modelId,
    system: resolveSystem(params, hasFsTools),
    prompt: params.prompt,
    tools,
    stopWhen: resolveAgentStopWhen(maxSteps),
    abortSignal: params.signal,
  };
  if (params.providerOptions) {
    streamArgs.providerOptions = params.providerOptions;
  }
  const reasoning = resolveAgentReasoning(modelId, {
    request: params.reasoning,
  });
  if (reasoning) {
    streamArgs.reasoning = reasoning;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = stream(streamArgs);

  try {
    for await (const part of result.fullStream) {
      for (const ev of mapFullStreamPart(part, secrets)) {
        await handlers.onEvent(ev);
      }
    }

    let text = redactSecrets(((await result.text) ?? '').trim(), secrets);
    const unwrapped = parseAndFlattenIfMcpEnvelope(text);
    if (unwrapped != null) {
      text = redactSecrets(unwrapped, secrets);
    }
    const steps = result.steps != null ? await result.steps : undefined;
    const toolTrace = collectToolTrace({ steps }, secrets);
    const cwdOut = hasFsTools ? cwdState.current : undefined;
    const sandboxOut = hasFsTools ? params.sandboxId : undefined;
    const activeOut =
      metaSandboxSwitchTargetId({ steps }) ??
      (hasFsTools ? params.sandboxId : undefined);
    // Phase 3 (plan #539 + #628) — provider usage: mid-stream `usage` events
    // are emitted from `finish` parts (aggregate `totalUsage` / v7 `usage`)
    // when the provider reports counts — never from `finish-step` (per-step).
    // The final `done.usage` is the conclusive reconcile (the
    // authoritative aggregate after the stream resolves). Absent when the
    // provider reported none. Single read of `result.usage` (an awaitable
    // getter that consumes the stream): a missing value, a sync getter throw,
    // or a rejected usage read all OMIT usage — never a broken turn, never an
    // orphaned rejection.
    let usage: UsageSummary | undefined;
    try {
      usage = mapProviderUsage(await Promise.resolve(result.usage));
    } catch {
      usage = undefined;
    }
    await handlers.onEvent({
      type: 'done',
      text,
      ...(usage ? { usage } : {}),
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
      ...(cwdOut != null ? { cwd: cwdOut } : {}),
      ...(sandboxOut != null ? { sandboxId: sandboxOut } : {}),
      ...(activeOut !== undefined ? { activeSandboxId: activeOut } : {}),
    });
    return {
      text,
      toolTrace,
      ...(usage ? { usage } : {}),
      ...(cwdOut != null ? { cwd: cwdOut } : {}),
      ...(sandboxOut != null ? { sandboxId: sandboxOut } : {}),
      ...(activeOut !== undefined ? { activeSandboxId: activeOut } : {}),
    };
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'ResponseAborted')) {
      await handlers.onEvent({ type: 'error', error: 'Request cancelled.', status: 499 });
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    await handlers.onEvent({
      type: 'error',
      error: redactSecrets(msg, secrets),
    });
    throw err;
  }
}

/** @internal exported for tests */
export function collectToolTrace(
  result: {
    steps?: Array<{
      toolCalls?: Array<{ toolName?: string; toolCallId?: string }>;
      toolResults?: Array<{
        toolName?: string;
        toolCallId?: string;
        result?: unknown;
        output?: unknown;
      }>;
      /** AI SDK also records invalid/failed calls as content parts. */
      content?: Array<{
        type?: string;
        toolCallId?: string;
        toolName?: string;
        error?: unknown;
        output?: unknown;
      }>;
    }>;
  },
  secrets: Array<string | undefined | null> = [],
): ToolTraceEntry[] {
  const entries: ToolTraceEntry[] = [];
  const steps = result.steps ?? [];
  for (const step of steps) {
    const calls = step.toolCalls ?? [];
    const results = step.toolResults ?? [];
    const content = step.content ?? [];
    for (const call of calls) {
      const name = call.toolName ?? 'tool';
      const match =
        results.find((r) => r.toolCallId && r.toolCallId === call.toolCallId) ??
        results.find((r) => r.toolName === name);
      const errorPart =
        content.find(
          (p) =>
            p.type === 'tool-error' &&
            ((p.toolCallId && p.toolCallId === call.toolCallId) || p.toolName === name),
        ) ?? undefined;

      let raw: unknown;
      if (match) {
        raw =
          match.output != null
            ? match.output
            : 'result' in match
              ? match.result
              : undefined;
      } else if (errorPart) {
        raw =
          errorPart.error != null
            ? errorPart.error
            : errorPart.output != null
              ? errorPart.output
              : 'tool error';
      }

      const asText = flattenToolResultText(raw);
      const redacted = redactSecrets(asText, secrets);
      // Missing result/error → not ok (AI SDK tool-error without toolResults used to look successful).
      const ok =
        match != null &&
        !/^\s*ERROR\b/i.test(redacted) &&
        !/\bTIMED_OUT\b/.test(redacted);
      const summary = summarizeToolLine(
        name,
        redacted || (errorPart ? 'ERROR tool-error' : ''),
        ok,
        secrets,
      );
      const changeDirCwd =
        name === 'change_dir' && ok ? changeDirSuccessCwd(redacted) : undefined;
      entries.push({
        name,
        ok,
        summary,
        ...(changeDirCwd !== undefined ? { cwd: changeDirCwd } : {}),
      });
    }
  }
  return entries;
}
