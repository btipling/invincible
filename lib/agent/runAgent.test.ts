import { describe, expect, it, vi } from 'vitest';
import type { SandboxClient } from '../sandbox/client';
import { collectToolTrace, DEFAULT_AGENT_SYSTEM, runAgent } from './runAgent';
import { TOOL_TRACE_SUMMARY_MAX_CHARS } from '../sandbox/config';
import { MCP_SYSTEM_ADDENDUM } from '../mcp/toolNames';

describe('runAgent', () => {
  it('passes stopWhen stepCountIs(maxSteps) to generateText', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      // stopWhen is a function (stepCountIs(n)); identity differs across calls
      expect(typeof args.stopWhen).toBe('function');
      // Compare behavior: stepCountIs(4) stops when steps.length >= 4
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
      exec: vi.fn(),
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
      exec: vi.fn(),
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

  it('appends MCP system addendum when mcp_ extraTools present', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      expect(args.system).toBe(`${DEFAULT_AGENT_SYSTEM} ${MCP_SYSTEM_ADDENDUM}`);
      return { text: 'ok', steps: [] };
    });
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
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

  it('does not append MCP addendum when system override provided', async () => {
    const generateTextImpl = vi.fn(async (args: Record<string, unknown>) => {
      expect(args.system).toBe('custom');
      return { text: 'ok', steps: [] };
    });
    const client: SandboxClient = {
      listDir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      exec: vi.fn(),
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
      exec: vi.fn(),
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
    expect(trace[0].summary).toMatch(/^mcp_exa__web_search_exa · ok ·/);
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
