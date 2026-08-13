import { describe, expect, it } from 'vitest';
import { parseAgentBody } from './agentBody';

describe('parseAgentBody', () => {
  it('accepts prompt without cwd (defaults . when no env)', () => {
    expect(parseAgentBody({ prompt: 'hi' }, {})).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
    });
  });

  it('omitted cwd ignores env SANDBOX_DEFAULT_CWD → always .', () => {
    expect(
      parseAgentBody({ prompt: 'hi' }, { SANDBOX_DEFAULT_CWD: 'invincible' }),
    ).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
    });
  });

  it('null cwd always resolves to . (env ignored)', () => {
    expect(
      parseAgentBody(
        { prompt: 'hi', cwd: null },
        { SANDBOX_DEFAULT_CWD: 'invincible' },
      ),
    ).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
    });
  });

  it('empty/whitespace cwd always resolves to .', () => {
    expect(parseAgentBody({ prompt: 'hi', cwd: '' }, {})).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
    });
    expect(parseAgentBody({ prompt: 'hi', cwd: '   ' }, {})).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
    });
  });

  it('body cwd wins (valid workspace-relative)', () => {
    expect(parseAgentBody({ prompt: 'hi', cwd: 'proj' }, {})).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: 'proj',
    });
  });

  it('valid cwd passes through', () => {
    expect(parseAgentBody({ prompt: 'hi', cwd: 'invincible' }, {})).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: 'invincible',
    });
  });

  it('rejects host-absolute cwd with 400', () => {
    const r = parseAgentBody({ prompt: 'hi', cwd: '/etc' }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/Invalid cwd|absolute/i);
    }
  });

  it('rejects non-string cwd', () => {
    const r = parseAgentBody({ prompt: 'hi', cwd: 3 }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('rejects empty prompt', () => {
    const r = parseAgentBody({ prompt: '' }, {});
    expect(r.ok).toBe(false);
  });
});
