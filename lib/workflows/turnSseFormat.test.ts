import { describe, expect, it } from 'vitest';
import {
  formatLiveModelSse,
  formatLiveToolResultSse,
  formatTurnSse,
} from './turnSseFormat';

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

  it('emits provider when the slug is a non-empty string (plan #906)', () => {
    expect(formatLiveModelSse({ type: 'provider', provider: 'togetherai' })).toBe(
      'data: {"type":"provider","provider":"togetherai"}\n\n',
    );
    expect(formatLiveModelSse({ type: 'provider', provider: 'fireworks' })).toBe(
      'data: {"type":"provider","provider":"fireworks"}\n\n',
    );
    expect(formatLiveModelSse({ type: 'provider', provider: '' })).toBeNull();
    expect(formatLiveModelSse({ type: 'provider' })).toBeNull();
    expect(formatLiveModelSse({ type: 'provider', provider: 1 })).toBeNull();
  });

  it('returns null for loop-owned / other event types', () => {
    expect(formatLiveModelSse({ type: 'usage', usage: { total: 1 } })).toBeNull();
    expect(formatLiveModelSse({ type: 'done', text: 'x' })).toBeNull();
    expect(formatLiveModelSse({ type: 'error', error: 'boom' })).toBeNull();
    expect(formatLiveModelSse({ type: 'tool_result', name: 'list_dir' })).toBeNull();
    expect(formatLiveModelSse({ type: 'skill_attached', name: 'x' })).toBeNull();
  });
});

describe('formatLiveToolResultSse (plan #880)', () => {
  it('frames ok result', () => {
    expect(
      formatLiveToolResultSse({ name: 'list_dir', ok: true, summary: 'ok' }),
    ).toBe('data: {"type":"tool_result","name":"list_dir","ok":true,"summary":"ok"}\n\n');
  });

  it('attaches confirmed cwd / sandbox id', () => {
    expect(
      formatLiveToolResultSse({
        name: 'change_dir',
        ok: true,
        summary: 'change_dir lib: ok cwd=lib',
        changeDirCwd: 'lib',
      }),
    ).toContain('"changeDirCwd":"lib"');
    expect(
      formatLiveToolResultSse({
        name: 'meta_sandbox_switch',
        ok: true,
        summary: 'switched',
        activeSandboxId: 'sb_b',
      }),
    ).toContain('"activeSandboxId":"sb_b"');
  });

  it('attaches provider tool-call id (adversarial #881 round-3)', () => {
    expect(
      formatLiveToolResultSse({
        name: 'read_file',
        ok: true,
        summary: 'ok',
        id: 'tc_a',
      }),
    ).toContain('"id":"tc_a"');
  });
});
