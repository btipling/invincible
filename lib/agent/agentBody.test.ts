import { describe, expect, it } from 'vitest';
import { parseAgentBody } from './agentBody';
import { PROMPT_BODY_MAX_CHARS } from '../chatApi';

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

  it('accepts valid Redis-safe sandboxId override', () => {
    expect(parseAgentBody({ prompt: 'hi', sandboxId: 'sbx_abc123' }, {})).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
      sandboxId: 'sbx_abc123',
    });
  });

  it('omitted / null sandboxId → no override (undefined)', () => {
    const r = parseAgentBody({ prompt: 'hi' }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sandboxId).toBeUndefined();

    const r2 = parseAgentBody({ prompt: 'hi', sandboxId: null }, {});
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.sandboxId).toBeUndefined();
  });

  it('keeps cwd + sandboxId together', () => {
    expect(
      parseAgentBody({ prompt: 'hi', cwd: 'proj', sandboxId: 'sbx_1' }, {}),
    ).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: 'proj',
      sandboxId: 'sbx_1',
    });
  });

  it('rejects non-Redis-safe sandboxId with 400 (fail closed)', () => {
    for (const bad of ['a:b', 'has space', 'foo*bar', 'x'.repeat(513)]) {
      const r = parseAgentBody({ prompt: 'hi', sandboxId: bad }, {});
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.error).toMatch(/sandboxId/i);
      }
    }
  });

  it('rejects non-string sandboxId with 400', () => {
    const r = parseAgentBody({ prompt: 'hi', sandboxId: 7 as never }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('accepts valid Redis-safe personaId', () => {
    expect(parseAgentBody({ prompt: 'hi', personaId: 'pers_abc123' }, {})).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
      personaId: 'pers_abc123',
    });
  });

  it('omitted / null personaId → no override (undefined)', () => {
    const r = parseAgentBody({ prompt: 'hi' }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.personaId).toBeUndefined();

    const r2 = parseAgentBody({ prompt: 'hi', personaId: null }, {});
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.personaId).toBeUndefined();
  });

  it('keeps cwd + sandboxId + personaId together', () => {
    expect(
      parseAgentBody(
        { prompt: 'hi', cwd: 'proj', sandboxId: 'sbx_1', personaId: 'pers_1' },
        {},
      ),
    ).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: 'proj',
      sandboxId: 'sbx_1',
      personaId: 'pers_1',
    });
  });

  it('rejects non-Redis-safe personaId with 400 (fail closed)', () => {
    for (const bad of ['a:b', 'has space', 'foo*bar', 'x'.repeat(513)]) {
      const r = parseAgentBody({ prompt: 'hi', personaId: bad }, {});
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.error).toMatch(/personaId/i);
      }
    }
  });

  it('rejects non-string personaId with 400', () => {
    const r = parseAgentBody({ prompt: 'hi', personaId: 9 as never }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('accepts valid Redis-safe sessionId (parent #485 phase-3 seam)', () => {
    expect(parseAgentBody({ prompt: 'hi', sessionId: 'sess_abc123' }, {})).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
      sessionId: 'sess_abc123',
    });
  });

  it('omitted / null sessionId → no override (undefined)', () => {
    const r = parseAgentBody({ prompt: 'hi' }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sessionId).toBeUndefined();

    const r2 = parseAgentBody({ prompt: 'hi', sessionId: null }, {});
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.sessionId).toBeUndefined();
  });

  it('rejects non-Redis-safe sessionId with 400 (fail closed)', () => {
    for (const bad of ['a:b', 'has space', 'foo*bar', 'x'.repeat(513)]) {
      const r = parseAgentBody({ prompt: 'hi', sessionId: bad }, {});
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.error).toMatch(/sessionId/i);
      }
    }
  });

  it('rejects non-string sessionId with 400', () => {
    const r = parseAgentBody({ prompt: 'hi', sessionId: 7 as never }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('keeps cwd + sandboxId + personaId + sessionId together', () => {
    expect(
      parseAgentBody(
        {
          prompt: 'hi',
          cwd: 'proj',
          sandboxId: 'sbx_1',
          personaId: 'pers_1',
          sessionId: 'sess_1',
        },
        {},
      ),
    ).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: 'proj',
      sandboxId: 'sbx_1',
      personaId: 'pers_1',
      sessionId: 'sess_1',
    });
  });

  it('accepts reasoning token (lowercase / mixed case)', () => {
    expect(parseAgentBody({ prompt: 'hi', reasoning: 'low' }, {})).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
      reasoning: 'low',
    });
    expect(parseAgentBody({ prompt: 'hi', reasoning: 'MAX' }, {})).toEqual({
      ok: true,
      prompt: 'hi',
      cwd: '.',
      reasoning: 'max',
    });
  });

  it('omitted / null / whitespace reasoning → unset', () => {
    const r = parseAgentBody({ prompt: 'hi' }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reasoning).toBeUndefined();
    const r2 = parseAgentBody({ prompt: 'hi', reasoning: null }, {});
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.reasoning).toBeUndefined();
    const r3 = parseAgentBody({ prompt: 'hi', reasoning: '   ' }, {});
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.reasoning).toBeUndefined();
  });

  it('rejects present invalid reasoning with 400', () => {
    for (const bad of ['low!', 'has space', 'x'.repeat(33), 3]) {
      const r = parseAgentBody({ prompt: 'hi', reasoning: bad as never }, {});
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.error).toMatch(/reasoning/i);
      }
    }
  });

  it('adversarial #937 — prompt + promptHistory combined over PROMPT_BODY_MAX_CHARS → 400', () => {
    const prompt = 'p'.repeat(100);
    const history = 'h'.repeat(PROMPT_BODY_MAX_CHARS - 50);
    const r = parseAgentBody({ prompt, promptHistory: history, sessionId: 's1' }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toMatch(/prompt \+ promptHistory/i);
    }
    const ok = parseAgentBody(
      { prompt: 'hi', promptHistory: 'User: a\nAssistant: b\nUser: hi', sessionId: 's1' },
      {},
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.promptHistory).toContain('User: a');
  });
});
