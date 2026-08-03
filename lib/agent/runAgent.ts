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

  let client = params.sandboxClient;
  let secrets = params.secrets ?? [];
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
  const text = (result.text ?? '').trim();
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
    }>;
  },
  secrets: Array<string | undefined | null> = [],
): ToolTraceEntry[] {
  const entries: ToolTraceEntry[] = [];
  const steps = result.steps ?? [];
  for (const step of steps) {
    const calls = step.toolCalls ?? [];
    const results = step.toolResults ?? [];
    for (const call of calls) {
      const name = call.toolName ?? 'tool';
      const match =
        results.find((r) => r.toolCallId && r.toolCallId === call.toolCallId) ??
        results.find((r) => r.toolName === name);
      const raw =
        match && 'output' in match && match.output != null
          ? match.output
          : match && 'result' in match
            ? match.result
            : undefined;
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
      const ok = !/^\s*ERROR\b/i.test(redacted) && !/\bTIMED_OUT\b/.test(redacted);
      const summary = truncateSummary(
        summarizeTool(name, redacted, ok),
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
