/**
 * backend-agents C14b (#835) — unit tests for `toModelMessages` converter.
 *
 * Covers:
 *  1. user + assistant (text only, no tools) → one user + one assistant text part
 *  2. user + assistant (delta with 2 toolCalls) + 2 tool rows →
 *     assistant content has 2 `tool-call` parts; two `role:'tool'` messages;
 *     every `toolCallId` pairs
 *  3. persist row skipped
 *  4. missing toolCallId on assistant tool-call → omitted (fail-closed)
 *  5. missing toolCallId on tool result → omitted (fail-closed)
 *  6. failed tool row (ok:false) converted correctly
 */

import { describe, expect, it } from 'vitest';
import { toModelMessages } from './toModelMessages';

describe('toModelMessages', () => {
  it('user + assistant (text only, no tools) → one user + one assistant text part', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', delta: { text: 'hi there', toolCalls: [] } },
    ];
    const result = toModelMessages(messages);
    expect(result).toHaveLength(2);

    expect(result[0]).toEqual({ role: 'user', content: 'hello' });

    const asst = result[1];
    expect(asst.role).toBe('assistant');
    expect(Array.isArray(asst.content)).toBe(true);
    expect(asst.content).toHaveLength(1);
    expect(asst.content[0]).toEqual({ type: 'text', text: 'hi there' });
  });

  it('user + assistant (delta with 2 toolCalls) + 2 tool rows → assistant has tool-call parts, tool messages link by toolCallId', () => {
    const messages = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        delta: {
          text: 'calling',
          toolCalls: [
            { toolName: 'read_file', toolCallId: 'tc1', args: { path: 'x.ts' } },
            { toolName: 'list_dir', toolCallId: 'tc2', args: { path: '.' } },
          ],
        },
      },
      { role: 'tool', toolName: 'read_file', toolCallId: 'tc1', result: 'content of x.ts' },
      { role: 'tool', toolName: 'list_dir', toolCallId: 'tc2', result: '[a.ts, b.ts]' },
    ];
    const result = toModelMessages(messages);
    // user + assistant + 2 tool messages = 4
    expect(result).toHaveLength(4);

    expect(result[0].role).toBe('user');

    const asst = result[1];
    expect(asst.role).toBe('assistant');
    expect(Array.isArray(asst.content)).toBe(true);
    // text part + 2 tool-call parts = 3
    expect(asst.content).toHaveLength(3);
    expect(asst.content[0]).toEqual({ type: 'text', text: 'calling' });
    expect(asst.content[1]).toEqual({
      type: 'tool-call',
      toolCallId: 'tc1',
      toolName: 'read_file',
      input: { path: 'x.ts' },
    });
    expect(asst.content[2]).toEqual({
      type: 'tool-call',
      toolCallId: 'tc2',
      toolName: 'list_dir',
      input: { path: '.' },
    });

    // Tool messages
    expect(result[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc1',
          toolName: 'read_file',
          output: { type: 'text', value: 'content of x.ts' },
        },
      ],
    });
    expect(result[3]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tc2',
          toolName: 'list_dir',
          output: { type: 'text', value: '[a.ts, b.ts]' },
        },
      ],
    });
  });

  it('persist row skipped', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', delta: { text: 'ok', toolCalls: [] } },
      { role: 'persist', status: 'completed' },
    ];
    const result = toModelMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
  });

  it('missing toolCallId on assistant tool-call → omitted from content (fail-closed)', () => {
    const messages = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        delta: {
          text: '',
          toolCalls: [
            { toolName: 'read_file', toolCallId: 'tc1', args: {} },
            { toolName: 'list_dir' /* no toolCallId */, args: { path: '.' } },
          ],
        },
      },
      { role: 'tool', toolName: 'read_file', toolCallId: 'tc1', result: 'ok' },
      // No tool row for the missing toolCallId tool-call.
    ];
    const result = toModelMessages(messages);
    // user + assistant + 1 tool (the list_dir with no toolCallId is skipped in both)
    expect(result).toHaveLength(3);
    const asst = result[1];
    expect(asst.role).toBe('assistant');
    // Only 1 tool-call part (no text since text was empty)
    expect(asst.content).toHaveLength(1);
    expect(asst.content[0]).toMatchObject({ type: 'tool-call', toolCallId: 'tc1' });
  });

  it('missing toolCallId on tool result → omitted (fail-closed — cannot pair)', () => {
    const messages = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        delta: {
          text: '',
          toolCalls: [{ toolName: 'read_file', toolCallId: 'tc1', args: {} }],
        },
      },
      // Tool result with a DIFFERENT toolCallId — still has a valid id, included.
      { role: 'tool', toolName: 'read_file', toolCallId: 'tc2', result: 'other id' },
      // Tool result with NO toolCallId property → SKIPPED (cannot pair with any tool-call).
      { role: 'tool', toolName: 'list_dir', result: 'no id at all' },
      // Correct tool result
      { role: 'tool', toolName: 'read_file', toolCallId: 'tc1', result: 'correct' },
    ];
    const result = toModelMessages(messages);
    // user + assistant + tool(tc2, has valid id) + tool(tc1) = 4. The no-id tool is skipped.
    expect(result).toHaveLength(4);
    // The first tool (tc2) is included because it has a valid toolCallId string.
    const toolMsg0 = result[2];
    expect(toolMsg0.role).toBe('tool');
    expect(toolMsg0.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'tc2',
      output: { type: 'text', value: 'other id' },
    });
    // The tool with NO toolCallId is skipped — the next message is the tc1 result.
    const toolMsg1 = result[3];
    expect(toolMsg1.role).toBe('tool');
    expect(toolMsg1.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'tc1',
      output: { type: 'text', value: 'correct' },
    });
  });

  it('failed tool row (ok:false) → tool message with error text', () => {
    const messages = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        delta: {
          text: '',
          toolCalls: [{ toolName: 'change_dir', toolCallId: 'tc1', args: { path: 'bad' } }],
        },
      },
      { role: 'tool', toolName: 'change_dir', toolCallId: 'tc1', ok: false, error: 'no such directory' },
    ];
    const result = toModelMessages(messages);
    expect(result).toHaveLength(3);
    const toolMsg = result[2];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.content[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'tc1',
      toolName: 'change_dir',
      output: { type: 'text', value: 'no such directory' },
    });
  });

  it('empty / null / non-object rows are silently skipped', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      null,
      undefined,
      {},
      { role: 'assistant', delta: { text: 'ok', toolCalls: [] } },
    ];
    const result = toModelMessages(messages);
    expect(result).toHaveLength(2);
  });

  it('maps role error to a user Error: line so the model sees the cap', () => {
    const result = toModelMessages([
      { role: 'user', content: 'go' },
      { role: 'error', content: 'step budget exhausted' },
      { role: 'persist', status: 'completed' },
    ]);
    expect(result).toEqual([
      { role: 'user', content: 'go' },
      { role: 'user', content: 'Error: step budget exhausted' },
    ]);
  });
});

