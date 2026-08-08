import { describe, expect, it } from 'vitest';
import {
  encodeSseData,
  mapFullStreamPart,
  wantsAgentStream,
  summarizeToolLine,
  LIVE_TOOL_LINES_MAX,
} from './agentStream';

describe('wantsAgentStream', () => {
  it('true for Accept text/event-stream', () => {
    expect(
      wantsAgentStream(
        new Request('http://x/api/agent', {
          headers: { Accept: 'text/event-stream' },
        }),
      ),
    ).toBe(true);
    expect(
      wantsAgentStream(
        new Request('http://x/api/agent', {
          headers: { Accept: 'application/json, text/event-stream' },
        }),
      ),
    ).toBe(true);
  });

  it('false without stream accept', () => {
    expect(wantsAgentStream(new Request('http://x/api/agent'))).toBe(false);
    expect(
      wantsAgentStream(
        new Request('http://x/api/agent', {
          headers: { Accept: 'application/json' },
        }),
      ),
    ).toBe(false);
  });
});

describe('encodeSseData', () => {
  it('formats data line', () => {
    const s = encodeSseData({ type: 'text_delta', text: 'hi' });
    expect(s).toBe('data: {"type":"text_delta","text":"hi"}\n\n');
  });
});

describe('mapFullStreamPart', () => {
  it('maps tool-call → tool_start', () => {
    expect(
      mapFullStreamPart({ type: 'tool-call', toolName: 'list_dir', toolCallId: 'c1' }),
    ).toEqual([{ type: 'tool_start', name: 'list_dir', id: 'c1' }]);
  });

  it('maps tool-result → tool_result with summary', () => {
    const evs = mapFullStreamPart({
      type: 'tool-result',
      toolName: 'list_dir',
      toolCallId: 'c1',
      output: 'a.txt\nb.txt',
    });
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: 'tool_result', name: 'list_dir', ok: true });
    if (evs[0]!.type === 'tool_result') {
      expect(evs[0].summary).toContain('list_dir · ✓ ok');

    }
  });

  it('maps text-delta', () => {
    expect(mapFullStreamPart({ type: 'text-delta', text: 'Hel' })).toEqual([
      { type: 'text_delta', text: 'Hel' },
    ]);
  });

  it('redacts secrets in text and tool output', () => {
    const secret = 'sk-super-secret';
    expect(
      mapFullStreamPart({ type: 'text-delta', text: `token ${secret}` }, [secret]),
    ).toEqual([{ type: 'text_delta', text: 'token [redacted]' }]);
    const evs = mapFullStreamPart(
      {
        type: 'tool-result',
        toolName: 'exec',
        output: `export KEY=${secret}`,
      },
      [secret],
    );
    if (evs[0]!.type === 'tool_result') {
      expect(evs[0].summary).not.toContain(secret);
      expect(evs[0].summary).toContain('[redacted]');
    }
  });

  it('maps reasoning-delta → reasoning_delta', () => {
    expect(mapFullStreamPart({ type: 'reasoning-delta', text: 'think' })).toEqual([
      { type: 'reasoning_delta', text: 'think' },
    ]);
  });

  it('redacts secrets in reasoning_delta', () => {
    const secret = 'sk-reason-secret';
    expect(
      mapFullStreamPart({ type: 'reasoning-delta', text: `see ${secret}` }, [secret]),
    ).toEqual([{ type: 'reasoning_delta', text: 'see [redacted]' }]);
  });

  it('maps error parts', () => {
    expect(mapFullStreamPart({ type: 'error', error: new Error('boom') })).toEqual([
      { type: 'error', error: 'boom' },
    ]);
  });
});

describe('summarizeToolLine', () => {
  it('caps length', () => {
    const line = summarizeToolLine('x', 'y'.repeat(500), true);
    expect(line.length).toBeLessThanOrEqual(240);
  });

  it('marks ok and failed clearly', () => {
    expect(summarizeToolLine('list_dir', 'a', true)).toContain('✓ ok');
    expect(summarizeToolLine('list_dir', 'boom', false)).toContain('✗ failed');
  });
});

describe('LIVE_TOOL_LINES_MAX', () => {
  it('is 32', () => {
    expect(LIVE_TOOL_LINES_MAX).toBe(32);
  });
});
