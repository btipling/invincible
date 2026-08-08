import { describe, expect, it } from 'vitest';
import { parseAgentBody } from './agentBody';

describe('parseAgentBody', () => {
  it('accepts prompt without cwd (defaults .)', () => {
    expect(parseAgentBody({ prompt: 'hi' })).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
    });
  });

  it('accepts valid cwd', () => {
    expect(parseAgentBody({ prompt: 'hi', cwd: 'invincible' })).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: 'invincible',
    });
  });

  it('rejects host-absolute cwd with 400', () => {
    const r = parseAgentBody({ prompt: 'hi', cwd: '/etc' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/Invalid cwd|absolute/i);
    }
  });

  it('rejects non-string cwd', () => {
    const r = parseAgentBody({ prompt: 'hi', cwd: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('still rejects bad prompt', () => {
    const r = parseAgentBody({ prompt: '' });
    expect(r.ok).toBe(false);
  });
});
