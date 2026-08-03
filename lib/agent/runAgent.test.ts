import { describe, expect, it, vi } from 'vitest';
import type { SandboxClient } from '../sandbox/client';
import { collectToolTrace, runAgent } from './runAgent';
import { TOOL_TRACE_SUMMARY_MAX_CHARS } from '../sandbox/config';

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
});
