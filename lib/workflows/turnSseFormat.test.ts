import { describe, expect, it } from 'vitest';
import { formatLiveModelSse, formatTurnSse } from './turnSseFormat';

describe('formatTurnSse (plan #842)', () => {
  it('frames a JSON event as one SSE data block', () => {
    expect(formatTurnSse({ type: 'text_delta', text: 'Hi' })).toBe(
      'data: {"type":"text_delta","text":"Hi"}\n\n',
    );
  });

  it('frames error.error (host AgentStreamEvent), not message', () => {
    expect(formatTurnSse({ type: 'error', error: 'boom' })).toBe(
      'data: {"type":"error","error":"boom"}\n\n',
    );
  });

  it('omits undefined fields', () => {
    const line = formatTurnSse({ type: 'done', text: '', cwd: undefined });
    expect(line).toBe('data: {"type":"done","text":""}\n\n');
  });
});

describe('formatLiveModelSse (plan #850)', () => {
  it('frames non-empty reasoning_delta', () => {
    expect(formatLiveModelSse({ type: 'reasoning_delta', text: 'Hmm' })).toBe(
      'data: {"type":"reasoning_delta","text":"Hmm"}\n\n',
    );
  });

  it('frames non-empty text_delta', () => {
    expect(formatLiveModelSse({ type: 'text_delta', text: 'Hi' })).toBe(
      'data: {"type":"text_delta","text":"Hi"}\n\n',
    );
  });

  it('returns null for empty or non-string text', () => {
    expect(formatLiveModelSse({ type: 'reasoning_delta', text: '' })).toBeNull();
    expect(formatLiveModelSse({ type: 'text_delta', text: '' })).toBeNull();
    expect(formatLiveModelSse({ type: 'text_delta' })).toBeNull();
    expect(formatLiveModelSse({ type: 'reasoning_delta', text: 1 })).toBeNull();
  });

  it('frames tool_start with and without id', () => {
    expect(formatLiveModelSse({ type: 'tool_start', name: 'list_dir' })).toBe(
      'data: {"type":"tool_start","name":"list_dir"}\n\n',
    );
    expect(formatLiveModelSse({ type: 'tool_start', name: 'read_file', id: 'c1' })).toBe(
      'data: {"type":"tool_start","name":"read_file","id":"c1"}\n\n',
    );
  });

  it('returns null for tool_start without a string name', () => {
    expect(formatLiveModelSse({ type: 'tool_start' })).toBeNull();
    expect(formatLiveModelSse({ type: 'tool_start', name: 3 })).toBeNull();
  });

  it('returns null for loop-owned / other event types', () => {
    expect(formatLiveModelSse({ type: 'usage', usage: { total: 1 } })).toBeNull();
    expect(formatLiveModelSse({ type: 'done', text: 'x' })).toBeNull();
    expect(formatLiveModelSse({ type: 'error', error: 'boom' })).toBeNull();
    expect(formatLiveModelSse({ type: 'tool_result', name: 'list_dir' })).toBeNull();
    expect(formatLiveModelSse({ type: 'skill_attached', name: 'x' })).toBeNull();
  });
});
