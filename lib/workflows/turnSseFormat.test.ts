import { describe, expect, it } from 'vitest';
import { formatTurnSse } from './turnSseFormat';

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
