import { generateText, streamText, stepCountIs, isLoopFinished } from 'ai';
import { mapFullStreamPart, summarizeToolLine } from './agentStream';
import { resolveAgentReasoning } from './reasoningConfig';
import {
  resolveAgentMaxSteps,
  resolveAgentModelId,
  getSandboxConfig,
} from '../sandbox/config';
import { createSandboxClient, type SandboxClient } from '../sandbox/client';
import { createAgentTools } from './tools';
import { redactSecrets } from './redact';
import {
  flattenToolResultText,
  parseAndFlattenIfMcpEnvelope,
} from './toolResultText';
import { MCP_SYSTEM_ADDENDUM } from '../mcp/toolNames';
import {
  HTTP_GET_SYSTEM_ADDENDUM,
  HTTP_ONLY_SYSTEM,
} from './httpFetchTools';

export type ToolTraceEntry = {
  name: string;
  ok: boolean;
  summary: string;
};

export type RunAgentParams = {
  prompt: string;
  signal?: AbortSignal;
  /**
   * Optional step ceiling (tests / explicit override).
   * When omitted, uses `resolveAgentMaxSteps()` — `null` means model-ended loop.
   */
  maxSteps?: number | null;
  modelId?: string;
  system?: string;
  /** Request-scoped Gateway BYOK (tenancy on). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  providerOptions?: any;
  /** Inject for tests — same shape as `generateText` from `ai`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generateTextImpl?: (args: any) => Promise<any>;
  /** Inject for tests — same shape as `streamText` from `ai`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  streamTextImpl?: (args: any) => any;
  /**
   * Optional. When omitted and sandbox env is missing, FS tools are skipped
   * (http-only / MCP-only paths). Throws only when no tools at all would remain
   * *and* no extraTools were provided *and* no sandbox can be resolved —
   * callers that need a hard error should check config at the route layer.
   */
  sandboxClient?: SandboxClient;
  secrets?: Array<string | undefined | null>;
  /** Effective grant permissions; default full access when omitted. */
  permissions?: { canRead: boolean; canWrite: boolean };
  /**
   * Optional extra tools (e.g. MCP, builtin http) merged after sandbox tools.
   * Route builds these; tests inject pure maps.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraTools?: Record<string, any>;
  /**
   * When true, do not auto-create sandbox client from env (route already decided
   * FS tools are unavailable). Default false.
   */
  skipSandboxTools?: boolean;
};

export type RunAgentResult = {
  text: string;
  toolTrace: ToolTraceEntry[];
};

export const DEFAULT_AGENT_SYSTEM = [
  'You are the Invincible coding agent.',
  'The workspace is a remote sandbox root. Prefer tools (list_dir, read_file, write_file, exec) for filesystem and command work.',
  'Use paths relative to the workspace root. Do not invent host absolute paths outside the sandbox.',
  'Be concise in final answers; cite relative paths when useful.',
].join(' ');

function resolveSystem(
  params: RunAgentParams,
  hasFsTools: boolean,
): string {
  if (params.system != null) return params.system;
  const extra = params.extraTools ?? {};
  const keys = Object.keys(extra);
  const hasMcp = keys.some((k) => k.startsWith('mcp_'));
  const hasHttp = keys.some((k) => k === 'http_get' || k === 'http_head');

  const parts: string[] = [];
  if (hasFsTools) {
    parts.push(DEFAULT_AGENT_SYSTEM);
  } else if (hasHttp || hasMcp) {
    parts.push(HTTP_ONLY_SYSTEM);
  } else {
    parts.push(DEFAULT_AGENT_SYSTEM);
  }
  if (hasHttp) parts.push(HTTP_GET_SYSTEM_ADDENDUM);
  if (hasMcp) parts.push(MCP_SYSTEM_ADDENDUM);
  return parts.join(' ');
}

/** Model-ended loop, or stepCountIs when an optional ceiling is set. */
export function resolveAgentStopWhen(
  maxSteps: number | null | undefined,
): ReturnType<typeof stepCountIs> | ReturnType<typeof isLoopFinished> {
  if (maxSteps != null && Number.isFinite(maxSteps) && maxSteps >= 1) {
    return stepCountIs(Math.floor(maxSteps));
  }
  return isLoopFinished();
}

/**
 * Multi-step generateText + optional sandbox / extra tools.
 * Sandbox client is optional when extraTools (http / MCP) supply the tool surface.
 */
export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const maxSteps =
    params.maxSteps !== undefined ? params.maxSteps : resolveAgentMaxSteps();
  const modelId = params.modelId ?? resolveAgentModelId();
  const generate = params.generateTextImpl ?? generateText;

  // Always scrub known server secrets from model-facing and client-facing strings.
  let secrets: Array<string | undefined | null> = [
    ...(params.secrets ?? []),
    process.env.AI_GATEWAY_API_KEY,
    process.env.SANDBOX_TOKEN,
  ];

  let client = params.sandboxClient;
  let hasFsTools = false;

  if (!params.skipSandboxTools) {
    if (!client) {
      const cfg = getSandboxConfig();
      if (cfg) {
        client = createSandboxClient(cfg);
        secrets = [...secrets, cfg.token];
      }
    }
    if (client) {
      hasFsTools = true;
    }
  } else if (client) {
    hasFsTools = true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandboxTools: Record<string, any> = hasFsTools && client
    ? createAgentTools({
        client,
        secrets,
        signal: params.signal,
        permissions: params.permissions,
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

  const result = await generate(genArgs);

  const toolTrace = collectToolTrace(result, secrets);
  let text = redactSecrets((result.text ?? '').trim(), secrets);
  // Pure MCP content-envelope assistant dumps → readable text (#129 / #133).
  const unwrapped = parseAndFlattenIfMcpEnvelope(text);
  if (unwrapped != null) {
    text = redactSecrets(unwrapped, secrets);
  }
  return { text, toolTrace };
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
  const modelId = params.modelId ?? resolveAgentModelId();
  const stream = params.streamTextImpl ?? streamText;

  let secrets: Array<string | undefined | null> = [
    ...(params.secrets ?? []),
    process.env.AI_GATEWAY_API_KEY,
    process.env.SANDBOX_TOKEN,
  ];

  let client = params.sandboxClient;
  let hasFsTools = false;

  if (!params.skipSandboxTools) {
    if (!client) {
      const cfg = getSandboxConfig();
      if (cfg) {
        client = createSandboxClient(cfg);
        secrets = [...secrets, cfg.token];
      }
    }
    if (client) {
      hasFsTools = true;
    }
  } else if (client) {
    hasFsTools = true;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sandboxTools: Record<string, any> = hasFsTools && client
    ? createAgentTools({
        client,
        secrets,
        signal: params.signal,
        permissions: params.permissions,
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
  const reasoning = resolveAgentReasoning(modelId);
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
    await handlers.onEvent({
      type: 'done',
      text,
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
    });
    return { text, toolTrace };
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
      entries.push({ name, ok, summary });
    }
  }
  return entries;
}
