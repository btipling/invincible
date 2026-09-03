import { describe, expect, it, vi } from 'vitest';
import type { SandboxClient } from '../sandbox/client';
import {
  collectToolTrace,
  DEFAULT_AGENT_SYSTEM,
  resolveAgentStopWhen,
  runAgent,
  runAgentStream,
} from './runAgent';
import { createAgentTools } from './tools';
import { TOOL_TRACE_SUMMARY_MAX_CHARS } from '../sandbox/config';
import type { AgentStreamEvent } from './agentStream';
import { MCP_SYSTEM_ADDENDUM } from '../mcp/toolNames';
import {
  SKILL_TOOLS_ONLY_SYSTEM,
  SKILL_TOOLS_SYSTEM_ADDENDUM,
} from './skillTools';
import { HTTP_GET_SYSTEM_ADDENDUM, HTTP_ONLY_SYSTEM } from './httpFetchTools';
import { META_TOOLS_SYSTEM_ADDENDUM, SKILL_META_ONLY_SYSTEM } from './metaTools';
import { META_SANDBOX_SYSTEM_ADDENDUM } from './metaSandboxTools';
import { SandboxHttpError } from '../sandbox/types';

describe('runAgent', () => {
  it('passes stopWhen stepCountIs(maxSteps) to generateText', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      // stopWhen is a function (stepCountIs(n)); identity differs across calls
      expect(typeof args.stopWhen).toBe('function');
      // Compare behavior: stepCountIs(4) stops when steps.length === 4
      const stopWhen = args.stopWhen as (ctx: { steps: unknown[] }) => boolean;
      expect(stopWhen({ steps: [1, 2, 3] })).toBe(false);
      expect(stopWhen({ steps: [1, 2, 3, 4] })).toBe(true);
      expect(args.prompt).toBe('hello');
      expect(args.tools).toBeTruthy();
      expect(args.abortSignal).toBeDefined();
      return {
        text: 'done',
        steps: [],
      };
    });

    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };

    const signal = new AbortController().signal;
    const result = await runAgent({
      prompt: 'hello',
      maxSteps: 4,
      modelId: 'test-model',
      signal,
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
    });

    expect(result.text).toBe('done');
    expect(generateTextImpl).toHaveBeenCalledTimes(1);
  });

  it('uses isLoopFinished (never step-stops) when maxSteps is null', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const stopWhen = args.stopWhen as (ctx: { steps: unknown[] }) => boolean;
      expect(stopWhen({ steps: [] })).toBe(false);
      expect(stopWhen({ steps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })).toBe(false);
      return { text: 'natural', steps: [] };
    });
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
    await runAgent({
      prompt: 'hi',
      maxSteps: null,
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
    });
    expect(generateTextImpl).toHaveBeenCalled();
  });

  it('resolveAgentStopWhen pins ceiling vs natural stop behavior', () => {
    const ceiling = resolveAgentStopWhen(2);
    expect(ceiling({ steps: [1] } as never)).toBe(false);
    expect(ceiling({ steps: [1, 2] } as never)).toBe(true);

    const natural = resolveAgentStopWhen(null);
    expect(natural({ steps: [1, 2, 3, 4, 5] } as never)).toBe(false);
  });

  it('merges extraTools into generateText tools', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const tools = args.tools as Record<string, unknown>;
      expect(tools.list_dir).toBeTruthy();
      expect(tools.mcp_exa__web_search).toBeTruthy();
      return { text: 'merged', steps: [] };
    });
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
    await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
      extraTools: {
        mcp_exa__web_search: {
          description: 'search',
          execute: async () => 'ok',
        },
      },
    });
    expect(generateTextImpl).toHaveBeenCalled();
  });

  it('does not fold MCP pick-criteria into the system string (lives on tool.description)', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      expect(args.system).toBe(DEFAULT_AGENT_SYSTEM);
      expect(String(args.system)).not.toContain(MCP_SYSTEM_ADDENDUM);
      return { text: 'ok', steps: [] };
    });
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
    await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
      extraTools: {
        mcp_exa__t: { execute: async () => 'x' },
      },
    });
  });

  it('does not fold the SKILL addendum into the system string when find_skill/fetch_skill are present (FS path)', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const system = String(args.system);
      expect(system).toContain(DEFAULT_AGENT_SYSTEM);
      expect(system).not.toContain(SKILL_TOOLS_SYSTEM_ADDENDUM);
      return { text: 'ok', steps: [] };
    });
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
    await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
      extraTools: {
        find_skill: { execute: async () => '[]' },
        fetch_skill: { execute: async () => 'body' },
      },
    });
  });

  it('uses the honest skill-only system when skills are the only non-FS tools (no phantom FS/http)', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const system = String(args.system);
      expect(system).toContain(SKILL_TOOLS_ONLY_SYSTEM);
      expect(system).not.toContain(SKILL_TOOLS_SYSTEM_ADDENDUM);
      // No FS-instruction block and no http mention when skills are the only tools.
      expect(system).not.toContain('filesystem and command work');
      expect(system).not.toMatch(/http_get/);
      return { text: 'ok', steps: [] };
    });
    await runAgent({
      prompt: 'query skills',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      skipSandboxTools: true,
      extraTools: {
        find_skill: { execute: async () => '[]' },
        fetch_skill: { execute: async () => 'body' },
      },
    });
  });

  it('uses SKILL_META_ONLY_SYSTEM without folding META addendum into system', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const system = String(args.system);
      expect(system).toBe(SKILL_META_ONLY_SYSTEM);
      expect(system).not.toContain(META_TOOLS_SYSTEM_ADDENDUM);
      expect(system).not.toContain(SKILL_TOOLS_SYSTEM_ADDENDUM);
      return { text: 'ok', steps: [] };
    });
    await runAgent({
      prompt: 'list personas',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      skipSandboxTools: true,
      extraTools: {
        meta_persona_list: { execute: async () => 'none' },
      },
    });
  });

  it('uses HTTP_ONLY_SYSTEM without folding HTTP addendum into system', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const system = String(args.system);
      expect(system).toBe(HTTP_ONLY_SYSTEM);
      expect(system).not.toContain(HTTP_GET_SYSTEM_ADDENDUM);
      return { text: 'ok', steps: [] };
    });
    await runAgent({
      prompt: 'fetch docs',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      skipSandboxTools: true,
      extraTools: {
        http_get: { execute: async () => 'ok' },
      },
    });
  });

  it('wraps a persona preamble in a mandatory <persona_standing_orders> block', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const system = String(args.system);
      expect(system).not.toContain(MCP_SYSTEM_ADDENDUM);
      expect(system).not.toContain(HTTP_GET_SYSTEM_ADDENDUM);
      expect(system).not.toContain(SKILL_TOOLS_SYSTEM_ADDENDUM);
      expect(system).not.toContain(META_TOOLS_SYSTEM_ADDENDUM);
      expect(system).not.toContain(META_SANDBOX_SYSTEM_ADDENDUM);
      expect(system).toContain('<persona_standing_orders>');
      expect(system).toContain('</persona_standing_orders>');
      expect(system).toContain('Follow these standing orders — they are mandatory');
      expect(system).toContain('never override the security/config non-negotiables');
      const blockStart = system.indexOf('<persona_standing_orders>');
      const blockEnd = system.indexOf('</persona_standing_orders>');
      expect(blockStart).toBeGreaterThan(-1);
      expect(system.slice(blockStart, blockEnd)).not.toMatch(/prefer/i);
      expect(system).toContain('Always use tabs.');
      expect(system.endsWith('Always use tabs.\n</persona_standing_orders>')).toBe(true);
      return { text: 'ok', steps: [] };
    });
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
    await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
      extraTools: {
        mcp_exa__t: { execute: async () => 'x' },
      },
      personaPreamble: 'Always use tabs.',
    });
  });

  it('drops an empty/whitespace persona preamble', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const system = String(args.system);
      expect(system).not.toContain(MCP_SYSTEM_ADDENDUM);
      expect(system).not.toContain('<persona_standing_orders>');
      return { text: 'ok', steps: [] };
    });
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
    await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
      extraTools: {
        mcp_exa__t: { execute: async () => 'x' },
      },
      personaPreamble: '   ',
    });
  });

  it('does not append MCP addendum when system override provided', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      expect(args.system).toBe('custom');
      return { text: 'ok', steps: [] };
    });
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
    await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      system: 'custom',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
      extraTools: {
        mcp_exa__t: { execute: async () => 'x' },
      },
    });
  });

  it('redacts secrets from final model text', async () => {
    const secret = 'sandbox-token-super-secret';
    const generateTextImpl = vi.fn(async () => ({
      text: `token is ${secret} end`,
      steps: [],
    }));
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
    const result = await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
      secrets: [secret],
    });
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain('[redacted]');
  });

  it('collectToolTrace builds summaries and ok flags', () => {
    const trace = collectToolTrace(
      {
        steps: [
          {
            toolCalls: [
              { toolName: 'list_dir', toolCallId: 'c1' },
              { toolName: 'exec', toolCallId: 'c2' },
            ],
            toolResults: [
              {
                toolName: 'list_dir',
                toolCallId: 'c1',
                output: 'list_dir .: 1 entries — a(file)',
              },
              {
                toolName: 'exec',
                toolCallId: 'c2',
                output: 'ERROR exec: boom SECRET',
              },
            ],
          },
        ],
      },
      ['SECRET'],
    );
    expect(trace).toHaveLength(2);
    expect(trace[0].name).toBe('list_dir');
    expect(trace[0].ok).toBe(true);
    expect(trace[0].summary.length).toBeLessThanOrEqual(
      TOOL_TRACE_SUMMARY_MAX_CHARS,
    );
    expect(trace[1].ok).toBe(false);
    expect(trace[1].summary).not.toContain('SECRET');
    expect(trace[1].summary).toContain('[redacted]');
  });

  it('collectToolTrace carries the TYPED cwd on confirmed change_dir and omits it on failure (adversarial review #470)', () => {
    const LONG_PATH =
      'packages/frontend/src/components/settings/panels/advanced/billing/extra';
    const trace = collectToolTrace({
      steps: [
        {
          toolCalls: [
            { toolName: 'change_dir', toolCallId: 'c1' },
            { toolName: 'change_dir', toolCallId: 'c2' },
          ],
          toolResults: [
            {
              toolName: 'change_dir',
              toolCallId: 'c1',
              output: `change_dir ${LONG_PATH}: ok cwd=${LONG_PATH}`,
            },
            {
              toolName: 'change_dir',
              toolCallId: 'c2',
              output: 'ERROR change_dir: no such dir',
            },
          ],
        },
      ],
    });
    expect(trace).toHaveLength(2);
    expect(trace[0].name).toBe('change_dir');
    expect(trace[0].ok).toBe(true);
    // The typed `cwd` is the full path (even though the summary is truncated).
    expect(trace[0].cwd).toBe(LONG_PATH);
    expect(trace[0].summary.length).toBeLessThanOrEqual(TOOL_TRACE_SUMMARY_MAX_CHARS);
    expect(trace[1].ok).toBe(false);
    expect(trace[1].cwd).toBeUndefined();
  });

  it('collectToolTrace marks missing results as not ok', () => {
    const trace = collectToolTrace({
      steps: [
        {
          toolCalls: [{ toolName: 'list_dir', toolCallId: 'c1' }],
          toolResults: [],
          content: [
            {
              type: 'tool-error',
              toolCallId: 'c1',
              toolName: 'list_dir',
              error: 'Invalid input',
            },
          ],
        },
      ],
    });
    expect(trace).toHaveLength(1);
    expect(trace[0].ok).toBe(false);
    expect(trace[0].summary).toMatch(/Invalid input|failed|ERROR/i);
  });

  it('redacts MCP secrets from toolTrace summaries', () => {
    const secret = 'mcp-api-key-should-not-leak';
    const trace = collectToolTrace(
      {
        steps: [
          {
            toolCalls: [{ toolName: 'mcp_exa__web_search', toolCallId: 'c1' }],
            toolResults: [
              {
                toolName: 'mcp_exa__web_search',
                toolCallId: 'c1',
                output: `ERROR mcp_exa__web_search: boom ${secret}`,
              },
            ],
          },
        ],
      },
      [secret],
    );
    expect(trace[0].summary).not.toContain(secret);
    expect(trace[0].summary).toContain('[redacted]');
    expect(trace[0].ok).toBe(false);
  });

  it('collectToolTrace flattens MCP content envelopes in summaries', () => {
    const trace = collectToolTrace({
      steps: [
        {
          toolCalls: [{ toolName: 'mcp_exa__web_search_exa', toolCallId: 'c1' }],
          toolResults: [
            {
              toolName: 'mcp_exa__web_search_exa',
              toolCallId: 'c1',
              output: {
                content: [
                  {
                    type: 'text',
                    text: 'Title: Introducing Exa 2.0 | Exa Blog\nURL: https://exa.ai/blog/exa-api-2-0',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(trace).toHaveLength(1);
    expect(trace[0].ok).toBe(true);
    expect(trace[0].summary).toMatch(/^mcp_exa__web_search_exa · ✓ ok ·/);
    expect(trace[0].summary).toContain('Introducing Exa 2.0');
    expect(trace[0].summary).not.toContain('"content"');
  });

  it('runAgent sanitizes pure MCP content-envelope assistant text', async () => {
    const envelope = JSON.stringify({
      content: [{ type: 'text', text: 'Title: Exa 2.0\nURL: https://exa.ai/blog' }],
    });
    const generateTextImpl = vi.fn(async () => ({
      text: envelope,
      steps: [],
    }));
    const { text, toolTrace } = await runAgent({
      prompt: 'search',
      modelId: 'test-model',
      sandboxClient: { request: vi.fn() } as never,
      generateTextImpl: generateTextImpl as never,
    });
    expect(text).toContain('Exa 2.0');
    expect(text).not.toContain('"content"');
    expect(toolTrace).toEqual([]);
  });

  it('runAgent does not rewrite prose that mentions JSON', async () => {
    const prose =
      'Found results. Payload was {"content":[{"type":"text","text":"x"}]} — summary: Exa launched 2.0.';
    const generateTextImpl = vi.fn(async () => ({
      text: prose,
      steps: [],
    }));
    const { text } = await runAgent({
      prompt: 'search',
      modelId: 'test-model',
      sandboxClient: { request: vi.fn() } as never,
      generateTextImpl: generateTextImpl as never,
    });
    expect(text).toBe(prose);
  });
});

describe('runAgent http-only / optional sandbox', () => {
  it('does not throw when sandboxClient omitted and http extraTools present', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const tools = args.tools as Record<string, unknown>;
      expect(tools.http_get).toBeTruthy();
      expect(tools.list_dir).toBeUndefined();
      expect(String(args.system)).toMatch(/http_get/);
      return { text: 'from web', steps: [] };
    });
    // Ensure env has no sandbox
    const prevUrl = process.env.SANDBOX_URL;
    const prevTok = process.env.SANDBOX_TOKEN;
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    try {
      const result = await runAgent({
        prompt: 'fetch example',
        modelId: 'test-model',
        generateTextImpl: generateTextImpl as never,
        skipSandboxTools: true,
        extraTools: {
          http_get: {
            description: 'get',
            execute: async () => 'ok',
          },
        },
      });
      expect(result.text).toBe('from web');
      expect(generateTextImpl).toHaveBeenCalled();
    } finally {
      if (prevUrl != null) process.env.SANDBOX_URL = prevUrl;
      if (prevTok != null) process.env.SANDBOX_TOKEN = prevTok;
    }
  });

  it('still throws when no sandbox and no extraTools', async () => {
    const prevUrl = process.env.SANDBOX_URL;
    const prevTok = process.env.SANDBOX_TOKEN;
    delete process.env.SANDBOX_URL;
    delete process.env.SANDBOX_TOKEN;
    try {
      await expect(
        runAgent({
          prompt: 'hi',
          modelId: 'test-model',
          generateTextImpl: vi.fn() as never,
          skipSandboxTools: true,
        }),
      ).rejects.toThrow(/Sandbox not configured/);
    } finally {
      if (prevUrl != null) process.env.SANDBOX_URL = prevUrl;
      if (prevTok != null) process.env.SANDBOX_TOKEN = prevTok;
    }
  });
});

describe('runAgent reasoning option (plan #897 / adversarial-review #899)', () => {
  const client: SandboxClient = {
    listDir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    strReplace: vi.fn(),
    exec: vi.fn(),
    stat: vi.fn(),
  };

  it('JSON generateText gets reasoning low for glm-5.3-flash (not merely runAgent params)', async () => {
    const prev = process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING;
    try {
      const generateTextImpl = vi.fn(async (_args: Record<string, unknown>) => ({
        text: 'ok',
        steps: [],
      }));
      await runAgent({
        prompt: 'hi',
        modelId: 'zai/glm-5.3-flash',
        generateTextImpl: generateTextImpl as never,
        sandboxClient: client,
      });
      expect(generateTextImpl).toHaveBeenCalledTimes(1);
      const args = generateTextImpl.mock.calls[0]![0];
      expect(args.reasoning).toBe('low');
      expect(args.reasoning).not.toBe('provider-default');
    } finally {
      if (prev == null) delete process.env.AGENT_REASONING;
      else process.env.AGENT_REASONING = prev;
    }
  });

  it('params.reasoning wins over AGENT_REASONING on generateText', async () => {
    const prev = process.env.AGENT_REASONING;
    process.env.AGENT_REASONING = 'high';
    try {
      const generateTextImpl = vi.fn(async (_args: Record<string, unknown>) => ({
        text: 'ok',
        steps: [],
      }));
      await runAgent({
        prompt: 'hi',
        modelId: 'zai/glm-5.3-flash',
        reasoning: 'low',
        generateTextImpl: generateTextImpl as never,
        sandboxClient: client,
      });
      const args = generateTextImpl.mock.calls[0]![0];
      expect(args.reasoning).toBe('low');
    } finally {
      if (prev == null) delete process.env.AGENT_REASONING;
      else process.env.AGENT_REASONING = prev;
    }
  });

  it('omits generateText reasoning for non-reasoning models when env unset', async () => {
    const prev = process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING;
    try {
      const generateTextImpl = vi.fn(async (_args: Record<string, unknown>) => ({
        text: 'ok',
        steps: [],
      }));
      await runAgent({
        prompt: 'hi',
        modelId: 'anthropic/claude-sonnet-4',
        generateTextImpl: generateTextImpl as never,
        sandboxClient: client,
      });
      const args = generateTextImpl.mock.calls[0]![0];
      expect(args).not.toHaveProperty('reasoning');
    } finally {
      if (prev == null) delete process.env.AGENT_REASONING;
      else process.env.AGENT_REASONING = prev;
    }
  });
});

describe('runAgentStream reasoning option', () => {
  it('passes resolveAgentReasoning result into streamText', async () => {
    const prev = process.env.AGENT_REASONING;
    process.env.AGENT_REASONING = 'high';
    try {
      const events: unknown[] = [];
      const streamTextImpl = vi.fn((_args: Record<string, unknown>) => ({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'ok' };
        })(),
        text: Promise.resolve('ok'),
        steps: Promise.resolve([]),
      }));
      const client: SandboxClient = {
        listDir: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        strReplace: vi.fn(),
        exec: vi.fn(),
        stat: vi.fn(),
      };
      await runAgentStream(
        {
          prompt: 'hi',
          modelId: 'xai/grok-4.1-fast-non-reasoning',
          streamTextImpl: streamTextImpl as never,
          sandboxClient: client,
        },
        {
          onEvent: async (ev) => {
            events.push(ev);
          },
        },
      );
      expect(streamTextImpl).toHaveBeenCalledTimes(1);
      const args = streamTextImpl.mock.calls[0]![0];
      expect(args.reasoning).toBe('high');
      expect(events.some((e) => (e as { type?: string }).type === 'done')).toBe(true);
    } finally {
      if (prev == null) delete process.env.AGENT_REASONING;
      else process.env.AGENT_REASONING = prev;
    }
  });

  it('omits reasoning for non-reasoning models when env unset', async () => {
    const prev = process.env.AGENT_REASONING;
    delete process.env.AGENT_REASONING;
    try {
      const streamTextImpl = vi.fn((_args: Record<string, unknown>) => ({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: 'ok' };
        })(),
        text: Promise.resolve('ok'),
        steps: Promise.resolve([]),
      }));
      const client: SandboxClient = {
        listDir: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        strReplace: vi.fn(),
        exec: vi.fn(),
        stat: vi.fn(),
      };
      await runAgentStream(
        {
          prompt: 'hi',
          modelId: 'anthropic/claude-sonnet-4',
          streamTextImpl: streamTextImpl as never,
          sandboxClient: client,
        },
        { onEvent: async () => {} },
      );
      const args = streamTextImpl.mock.calls[0]![0];
      expect(args).not.toHaveProperty('reasoning');
    } finally {
      if (prev != null) process.env.AGENT_REASONING = prev;
    }
  });
});

describe('runAgent cwd', () => {
  it('returns cwd when FS tools active', async () => {
    const generateTextImpl = vi.fn(async () => ({
      text: 'done',
      steps: [],
    }));
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
    const result = await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
      initialCwd: 'invincible',
    });
    expect(result.cwd).toBe('invincible');
    expect(result.text).toBe('done');
    // tools include pwd + change_dir
    expect(generateTextImpl).toHaveBeenCalled();
    const firstCall = generateTextImpl.mock.calls.at(0) as
      | [{ tools?: Record<string, unknown> }]
      | undefined;
    const tools = firstCall?.[0]?.tools;
    expect(tools?.pwd).toBeTruthy();
    expect(tools?.change_dir).toBeTruthy();
  });

  it('omits cwd when FS tools skipped', async () => {
    const generateTextImpl = vi.fn(async () => ({
      text: 'http only',
      steps: [],
    }));
    const result = await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      skipSandboxTools: true,
      extraTools: {
        http_get: { description: 'x', execute: async () => 'ok' },
      },
    });
    expect(result.cwd).toBeUndefined();
  });

  it('runAgentStream done event includes cwd', async () => {
    const events: Array<{ type: string; cwd?: string }> = [];
    async function* emptyStream() {
      // no parts
    }
    const streamTextImpl = vi.fn(() => ({
      fullStream: emptyStream(),
      text: Promise.resolve('streamed'),
      steps: Promise.resolve([]),
    }));
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
    const result = await runAgentStream(
      {
        prompt: 'hi',
        modelId: 'test-model',
        streamTextImpl: streamTextImpl as never,
        sandboxClient: client,
        initialCwd: 'proj',
      },
      {
        onEvent: async (ev) => {
          events.push(ev as { type: string; cwd?: string });
        },
      },
    );
    expect(result.cwd).toBe('proj');
    const done = events.find((e) => e.type === 'done');
    expect(done?.cwd).toBe('proj');
  });
});

describe('runAgent post-turn activeSandboxId (blocker B1 wire)', () => {
  const client: SandboxClient = {
    listDir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    strReplace: vi.fn(),
    exec: vi.fn(),
    stat: vi.fn(),
  };

  it('runAgent folds the meta_sandbox_switch target into activeSandboxId (JSON)', async () => {
    const generateTextImpl = vi.fn(async () => ({
      text: 'switched',
      steps: [
        {
          toolCalls: [{ toolName: 'meta_sandbox_switch', toolCallId: 'c1' }],
          toolResults: [
            {
              toolName: 'meta_sandbox_switch',
              toolCallId: 'c1',
              output: 'switched active sandbox to id=sb-byo tools=[read_file, write_file]',
            },
          ],
        },
      ],
    }));
    const result = await runAgent({
      prompt: 'switch to sb-byo',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
      // Pre-turn bind differs from the switch target — the host must NOT fold this back.
      sandboxId: 'sb-original',
    });
    expect(result.activeSandboxId).toBe('sb-byo');
    expect(result.sandboxId).toBe('sb-original');
  });

  it('runAgent mirrors sandboxId when no switch ran', async () => {
    const generateTextImpl = vi.fn(async () => ({
      text: 'done',
      steps: [{ toolCalls: [], toolResults: [] }],
    }));
    const result = await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: client,
      sandboxId: 'sb-original',
    });
    expect(result.activeSandboxId).toBe('sb-original');
  });

  it('runAgent omits activeSandboxId when no FS bind and no switch', async () => {
    const generateTextImpl = vi.fn(async () => ({
      text: 'http only',
      steps: [],
    }));
    const result = await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      skipSandboxTools: true,
      extraTools: { http_get: { description: 'x', execute: async () => 'ok' } },
    });
    expect(result.activeSandboxId).toBeUndefined();
  });

  it('runAgentStream done event + result include the switched activeSandboxId', async () => {
    const events: Array<{ type: string; activeSandboxId?: string }> = [];
    async function* fullStream() {
      yield {
        type: 'tool-result',
        toolName: 'meta_sandbox_switch',
        toolCallId: 'c1',
        output: 'switched active sandbox to id=sb-vercel tools=[exec]',
      };
    }
    const streamTextImpl = vi.fn(() => ({
      fullStream: fullStream(),
      text: Promise.resolve('switched'),
      steps: Promise.resolve([
        {
          toolCalls: [{ toolName: 'meta_sandbox_switch', toolCallId: 'c1' }],
          toolResults: [
            {
              toolName: 'meta_sandbox_switch',
              toolCallId: 'c1',
              output: 'switched active sandbox to id=sb-vercel tools=[exec]',
            },
          ],
        },
      ]),
    }));
    const result = await runAgentStream(
      {
        prompt: 'switch',
        modelId: 'test-model',
        streamTextImpl: streamTextImpl as never,
        sandboxClient: client,
        sandboxId: 'sb-original',
      },
      {
        onEvent: async (ev) => {
          events.push(ev as { type: string; activeSandboxId?: string });
        },
      },
    );
    expect(result.activeSandboxId).toBe('sb-vercel');
    const done = events.find((e) => e.type === 'done') as
      | { activeSandboxId?: string }
      | undefined;
    expect(done?.activeSandboxId).toBe('sb-vercel');
  });

  it('runAgentStream mirrors sandboxId on done when no switch ran', async () => {
    const events: Array<{ type: string; activeSandboxId?: string }> = [];
    async function* emptyStream() {
      // no parts
    }
    const streamTextImpl = vi.fn(() => ({
      fullStream: emptyStream(),
      text: Promise.resolve('done'),
      steps: Promise.resolve([]),
    }));
    const result = await runAgentStream(
      {
        prompt: 'hi',
        modelId: 'test-model',
        streamTextImpl: streamTextImpl as never,
        sandboxClient: client,
        sandboxId: 'sb-original',
      },
      {
        onEvent: async (ev) => {
          events.push(ev as { type: string; activeSandboxId?: string });
        },
      },
    );
    expect(result.activeSandboxId).toBe('sb-original');
    const done = events.find((e) => e.type === 'done') as
      | { activeSandboxId?: string }
      | undefined;
    expect(done?.activeSandboxId).toBe('sb-original');
  });
});

describe('DEFAULT_AGENT_SYSTEM standing orders', () => {
  it('mentions read before edit, re-read on change, and create exception', () => {
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/read_file a path in this agent run/i);
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/read_file again before editing/i);
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/Creating a new file with write_file does not require/i);
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/offset=1/);
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/limit/);
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/maxBytes/);
  });

  it('must mention /tmp', () => {
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/\/tmp/i);
  });

  it('must mention workspace root is writable', () => {
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/workspace root is writable/i);
  });

  it('names sandbox_info and forbids learning the sandbox via exec env', () => {
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/sandbox_info/);
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/do not exec env/);
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/printenv/);
    expect(DEFAULT_AGENT_SYSTEM).toMatch(/uname/);
  });
});

describe('runAgent daemon-version preflight', () => {
  function clientWith(
    checkDaemonCurrent: (() => Promise<void>) | undefined,
  ): SandboxClient {
    return {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
      checkDaemonCurrent,
    };
  }

  it('fails the turn (not chat fallback) when the sandbox daemon is out of date', async () => {
    const generateTextImpl = vi.fn(async () => ({
      text: 'SHOULD NOT RUN',
      steps: [],
    }));
    const client = clientWith(async () => {
      throw new SandboxHttpError(
        'Sandbox daemon out of date (running 0, expected 1). Update and restart the sandbox process.',
        426,
        'SANDBOX_DAEMON_OUT_OF_DATE',
      );
    });
    await expect(
      runAgent({
        prompt: 'go',
        modelId: 'test-model',
        generateTextImpl: generateTextImpl as never,
        sandboxClient: client,
      }),
    ).rejects.toMatchObject({ status: 426, code: 'SANDBOX_DAEMON_OUT_OF_DATE' });
    // Turn must stop before any model step.
    expect(generateTextImpl).not.toHaveBeenCalled();
  });

  it('runs normally when the daemon is current', async () => {
    const generateTextImpl = vi.fn(async () => ({ text: 'ok', steps: [] }));
    const client = clientWith(async () => {});
    await expect(
      runAgent({
        prompt: 'go',
        modelId: 'test-model',
        generateTextImpl: generateTextImpl as never,
        sandboxClient: client,
      }),
    ).resolves.toMatchObject({ text: 'ok' });
    expect(generateTextImpl).toHaveBeenCalledTimes(1);
  });

  it('still runs when the backend client has no daemon gate (Vercel sandbox)', async () => {
    const generateTextImpl = vi.fn(async () => ({ text: 'vercel-ok', steps: [] }));
    const client = clientWith(undefined);
    await expect(
      runAgent({
        prompt: 'go',
        modelId: 'test-model',
        generateTextImpl: generateTextImpl as never,
        sandboxClient: client,
      }),
    ).resolves.toMatchObject({ text: 'vercel-ok' });
  });
});

describe('runAgent skillsPreamble (phase 2 #517)', () => {
  function fsClient(): SandboxClient {
    return {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
  }

  it('appends the skills preamble AFTER the persona standing orders (catalog block)', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const system = String(args.system);
      // Persona block first.
      const personaIdx = system.indexOf('<persona_standing_orders>');
      expect(personaIdx).toBeGreaterThan(-1);
      expect(system).toContain('Always use tabs.');
      expect(system).toContain('</persona_standing_orders>');
      const skillsIdx = system.indexOf('<attached_skills>');
      expect(skillsIdx).toBeGreaterThan(personaIdx);
      expect(system).toContain('`create-plan` — Create plan: writes a plan.');
      expect(system).toContain('</attached_skills>');
      expect(
        system.endsWith('`create-plan` — Create plan: writes a plan.\n</attached_skills>'),
      ).toBe(true);
      return { text: 'ok', steps: [] };
    });
    await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: fsClient(),
      personaPreamble: 'Always use tabs.',
      skillsPreamble: '`create-plan` — Create plan: writes a plan.',
    });
    expect(generateTextImpl).toHaveBeenCalled();
  });

  it('appends skills even without a persona (after the base system)', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const system = String(args.system);
      expect(system).toContain('<attached_skills>');
      expect(system).toContain('`review` — Review');
      expect(system).not.toContain('<persona_standing_orders>');
      return { text: 'ok', steps: [] };
    });
    await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: fsClient(),
      skillsPreamble: '`review` — Review: be adversarial.',
    });
    expect(generateTextImpl).toHaveBeenCalled();
  });

  it('drops empty/whitespace skillsPreamble', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      const system = String(args.system);
      expect(system).not.toContain('<attached_skills>');
      return { text: 'ok', steps: [] };
    });
    await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: fsClient(),
      skillsPreamble: '   ',
    });
    expect(generateTextImpl).toHaveBeenCalled();
  });

  it('a system override keeps the override intact (no skills/persona fold)', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      expect(args.system).toBe('custom');
      return { text: 'ok', steps: [] };
    });
    await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      system: 'custom',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: fsClient(),
      personaPreamble: 'Always use tabs.',
      skillsPreamble: '`x` — X: body',
    });
    expect(generateTextImpl).toHaveBeenCalled();
  });
});

describe('runAgent provider usage capture (plan #539 / #327)', () => {
  function fsClient(): SandboxClient {
    return {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
  }

  it('carries a bounded usage summary on the JSON result', async () => {
    const generateTextImpl = vi.fn(async () => ({
      text: 'ok',
      steps: [],
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    }));
    const result = await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: fsClient(),
    });
    expect(result.usage).toEqual({
      source: 'provider',
      prompt: 100,
      completion: 40,
      total: 140,
    });
  });

  it('omits usage when the provider reports none / a non-usable shape', async () => {
    const generateTextImpl = vi.fn(async () => ({ text: 'ok', steps: [] }));
    const result = await runAgent({
      prompt: 'hi',
      modelId: 'test-model',
      generateTextImpl: generateTextImpl as never,
      sandboxClient: fsClient(),
    });
    expect(result.usage).toBeUndefined();
  });

  it('attaches usage to the stream done event and the returned result', async () => {
    const events: AgentStreamEvent[] = [];
    const streamTextImpl = vi.fn(() => ({
      fullStream: (async function* () {})(),
      text: Promise.resolve('ok'),
      steps: Promise.resolve([]),
      usage: Promise.resolve({
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
      }),
    }));
    const result = await runAgentStream(
      {
        prompt: 'hi',
        modelId: 'test-model',
        streamTextImpl: streamTextImpl as never,
        sandboxClient: fsClient(),
      },
      { onEvent: (ev) => void events.push(ev) },
    );
    expect(result.usage).toEqual({
      source: 'provider',
      prompt: 7,
      completion: 3,
      total: 10,
    });
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect((done as { usage?: unknown })?.usage).toEqual(result.usage);
  });

  it('a usage read failure never breaks the turn (omits usage)', async () => {
    const streamTextImpl = vi.fn(() => ({
      fullStream: (async function* () {})(),
      text: Promise.resolve('ok'),
      steps: Promise.resolve([]),
      // A billing/usage read that rejects must NOT fail the turn.
      get usage() {
        return Promise.reject(new Error('usage read failed'));
      },
    }));
    const result = await runAgentStream(
      {
        prompt: 'hi',
        modelId: 'test-model',
        streamTextImpl: streamTextImpl as never,
        sandboxClient: fsClient(),
      },
      { onEvent: () => {} },
    );
    expect(result.text).toBe('ok');
    expect(result.usage).toBeUndefined();
  });
});

describe('AGENT TOOL descriptions ban /tmp', () => {
  function mockClient(): SandboxClient {
    return {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      strReplace: vi.fn(),
      exec: vi.fn(),
      stat: vi.fn(),
    };
  }

  it('every edited FS tool description mentions /tmp (not just workspace)', () => {
    const tools = createAgentTools({
      client: mockClient(),
      freshness: { recordRead: vi.fn(), recordWrite: vi.fn(), assertCanEdit: vi.fn(() => ({ ok: true } as const)) } as never,
    });

    // Only the six tools edited in this PR — pwd is unchanged and was not part of the plan.
    const editedTools = ['change_dir', 'list_dir', 'read_file', 'write_file', 'str_replace', 'exec'] as const;
    for (const name of editedTools) {
      const t = tools[name] as { description?: string } | undefined;
      expect(t, `tool ${name} exists`).toBeTruthy();
      expect(
        t?.description,
        `tool ${name} description must mention /tmp`,
      ).toMatch(/\/tmp/i);
    }
  });

  it('every FS path arg description mentions /tmp', () => {
    const tools = createAgentTools({
      client: mockClient(),
      freshness: { recordRead: vi.fn(), recordWrite: vi.fn(), assertCanEdit: vi.fn(() => ({ ok: true } as const)) } as never,
    });

    // Inspect inputSchema.jsonSchema.properties.path.description directly —
    // not JSON.stringify, which would match /tmp from the parent tool
    // description and leave the test vacuous.
    const pathTools = ['change_dir', 'list_dir', 'read_file', 'write_file', 'str_replace'] as const;
    for (const name of pathTools) {
      const t = tools[name] as {
        inputSchema?: { jsonSchema?: { properties?: { path?: { description?: string } } } };
      };
      expect(t, `tool ${name} exists`).toBeTruthy();
      const pathDesc = t?.inputSchema?.jsonSchema?.properties?.path?.description ?? '';
      expect(
        pathDesc,
        `tool ${name} path arg description must contain /tmp`,
      ).toMatch(/\/tmp/i);
    }
  });

  it('exec cwd arg description mentions /tmp', () => {
    const tools = createAgentTools({
      client: mockClient(),
      freshness: { recordRead: vi.fn(), recordWrite: vi.fn(), assertCanEdit: vi.fn(() => ({ ok: true } as const)) } as never,
    });

    const exec = tools.exec as {
      inputSchema?: { jsonSchema?: { properties?: { cwd?: { description?: string } } } };
    };
    expect(exec).toBeTruthy();
    const cwdDesc = exec?.inputSchema?.jsonSchema?.properties?.cwd?.description ?? '';
    expect(
      cwdDesc,
      'exec cwd arg description must contain /tmp',
    ).toMatch(/\/tmp/i);
  });
});

