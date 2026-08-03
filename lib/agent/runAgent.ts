import { generateText, stepCountIs } from 'ai';
import {
  TOOL_TRACE_SUMMARY_MAX_CHARS,
  resolveAgentMaxSteps,
  resolveAgentModelId,
  getSandboxConfig,
} from '../sandbox/config';
import { createSandboxClient, type SandboxClient } from '../sandbox/client';
import { createAgentTools } from './tools';
import { redactSecrets, truncateSummary } from './redact';

export type ToolTraceEntry = {
  name: string;
  ok: boolean;
  summary: string;
};

export type RunAgentParams = {
  prompt: string;
  signal?: AbortSignal;
  /** Override env-derived max steps. */
  maxSteps?: number;
  modelId?: string;
  system?: string;
  /** Inject for tests — same shape as `generateText` from `ai`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generateTextImpl?: (args: any) => Promise<any>;
  sandboxClient?: SandboxClient;
  secrets?: Array<string | undefined | null>;
  /** Effective grant permissions; default full access when omitted. */
  permissions?: { canRead: boolean; canWrite: boolean };
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

/**
 * Multi-step generateText + sandbox tools.
 * Caller must ensure sandbox is configured when not injecting sandboxClient.
 */
export async function runAgent(params: RunAgentParams): Promise<RunAgentResult> {
  const maxSteps = params.maxSteps ?? resolveAgentMaxSteps();
  const modelId = params.modelId ?? resolveAgentModelId();
  const generate = params.generateTextImpl ?? generateText;

  // Always scrub known server secrets from model-facing and client-facing strings.
  let secrets: Array<string | undefined | null> = [
    ...(params.secrets ?? []),
    process.env.AI_GATEWAY_API_KEY,
    process.env.SANDBOX_TOKEN,
  ];

  let client = params.sandboxClient;
  if (!client) {
    const cfg = getSandboxConfig();
    if (!cfg) {
      throw new Error('Sandbox not configured');
    }
    client = createSandboxClient(cfg);
    secrets = [...secrets, cfg.token];
  }

  const tools = createAgentTools({
    client,
    secrets,
    signal: params.signal,
    permissions: params.permissions,
  });

  const result = await generate({
    model: modelId,
    system: params.system ?? DEFAULT_AGENT_SYSTEM,
    prompt: params.prompt,
    tools,
    stopWhen: stepCountIs(maxSteps),
    abortSignal: params.signal,
  });

  const toolTrace = collectToolTrace(result, secrets);
  const text = redactSecrets((result.text ?? '').trim(), secrets);
  return { text, toolTrace };
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

      const asText =
        typeof raw === 'string'
          ? raw
          : raw == null
            ? ''
            : (() => {
                try {
                  return JSON.stringify(raw);
                } catch {
                  return String(raw);
                }
              })();
      const redacted = redactSecrets(asText, secrets);
      // Missing result/error → not ok (AI SDK tool-error without toolResults used to look successful).
      const ok =
        match != null &&
        !/^\s*ERROR\b/i.test(redacted) &&
        !/\bTIMED_OUT\b/.test(redacted);
      const summary = truncateSummary(
        summarizeTool(name, redacted || (errorPart ? 'ERROR tool-error' : ''), ok),
        TOOL_TRACE_SUMMARY_MAX_CHARS,
      );
      entries.push({ name, ok, summary });
    }
  }
  return entries;
}

function summarizeTool(name: string, resultText: string, ok: boolean): string {
  const oneLine = resultText.replace(/\s+/g, ' ').trim();
  if (!oneLine) return `${name} ${ok ? 'ok' : 'failed'}`;
  // Prefer first ~line for summary
  const head = oneLine.length > 200 ? oneLine.slice(0, 200) : oneLine;
  return head;
}
