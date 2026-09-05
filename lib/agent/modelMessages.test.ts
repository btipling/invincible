/**
 * Tests for the model-messages projection (plan #936, source #549).
 * Covers testing rows 1–4: round-trip, truncation (UTF-8 safe, `log:` pointers
 * survive), pairing (atomic calls/results, `skipped:` closers), and the
 * orphan-drop review lock (a tool row whose call never converts is dropped).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildModelMessages,
  trimModelMessagesToBudget,
  type ModelMessageRow,
} from './modelMessages';
import {
  MODEL_MSG_CHECKPOINT_MAX_ROWS,
  MODEL_MSG_SEED_MAX_BYTES,
  MODEL_MSG_SEED_MAX_ROWS,
  MODEL_MSG_TOOL_RESULT_MAX_CHARS,
} from '../sessionCloudCaps';

const user = (content: string): ModelMessageRow => ({ role: 'user', content });
const assistant = (
  text: string,
  toolCalls: Array<{ toolName: string; toolCallId?: string; args?: unknown }> = [],
): ModelMessageRow => ({ role: 'assistant', delta: { text, toolCalls } });
const toolOk = (toolName: string, toolCallId: string, result: string): ModelMessageRow => ({
  role: 'tool',
  toolName,
  toolCallId,
  result,
});
const toolErr = (toolName: string, toolCallId: string, error: string): ModelMessageRow => ({
  role: 'tool',
  toolName,
  toolCallId,
  ok: false,
  error,
});

describe('buildModelMessages (plan #936)', () => {
  it('row 1 — user/assistant/tool rows round-trip; persist/error rows skipped; reasoning absent', () => {
    const { rows, truncated } = buildModelMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        delta: {
          text: 'reading',
          toolCalls: [{ toolName: 'read_file', toolCallId: 'c1', args: { path: 'a.ts' } }],
          reasoning: 'SECRET-CHAIN-OF-THOUGHT',
        },
      },
      { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'file bytes' },
      { role: 'persist', status: 'completed' },
      { role: 'error', content: 'wrap-up budget' },
      { role: 'assistant', delta: { text: 'done', toolCalls: [] } },
    ]);
    expect(truncated).toBe(false);
    expect(rows).toEqual([
      user('go'),
      assistant('reading', [{ toolName: 'read_file', toolCallId: 'c1', args: { path: 'a.ts' } }]),
      toolOk('read_file', 'c1', 'file bytes'),
      assistant('done', []),
    ]);
    // reasoning never carried onto the persisted assistant delta.
    const asst = rows[1];
    expect(asst.role).toBe('assistant');
    if (asst.role === 'assistant') {
      expect('reasoning' in asst.delta).toBe(false);
      expect(JSON.stringify(asst)).not.toContain('SECRET-CHAIN-OF-THOUGHT');
    }
  });

  it('row 2 — truncation: a >cap result is bounded + marker; UTF-8 multi-byte never split; log: pointers survive', () => {
    const cap = MODEL_MSG_TOOL_RESULT_MAX_CHARS;
    // A fat result whose head holds the exec disk-log pointer lines.
    const pointer = 'log: .invincible/logs/exec-2026-09-03T20-1.log';
    const fat = `${pointer}\n${'x'.repeat(cap * 3)}`;
    const { rows } = buildModelMessages([
      { role: 'assistant', delta: { text: '', toolCalls: [{ toolName: 'exec', toolCallId: 'e1' }] } },
      { role: 'tool', toolName: 'exec', toolCallId: 'e1', result: fat },
    ]);
    const t = rows[1];
    expect(t.role).toBe('tool');
    if (t.role === 'tool' && 'result' in t) {
      expect(t.result.length).toBeLessThanOrEqual(cap + 60); // head + marker line
      expect(t.result).toContain('truncated');
      expect(t.result.startsWith(pointer)).toBe(true); // log: pointer survives the head excerpt
    } else {
      throw new Error('expected a tool result row');
    }

    // UTF-8 multi-byte: a result of astral/CJK runes is never split mid-rune.
    const runes = '你好世界🚀'.repeat(Math.ceil(cap / 2));
    const { rows: r2 } = buildModelMessages([
      { role: 'assistant', delta: { text: '', toolCalls: [{ toolName: 'read_file', toolCallId: 'u1' }] } },
      { role: 'tool', toolName: 'read_file', toolCallId: 'u1', result: runes },
    ]);
    const t2 = r2[1];
    if (t2.role === 'tool' && 'result' in t2) {
      // No lone surrogate / replacement char at the cut boundary.
      expect(t2.result).not.toContain('�');
      // The excerpt is whole code points only.
      const head = t2.result.split('\n')[0]!;
      expect([...head].length).toBeLessThanOrEqual(cap);
    } else {
      throw new Error('expected a tool result row');
    }
  });

  it('row 3 — pairing: assistant toolCalls + tool rows persist atomically; skipped: closers kept verbatim', () => {
    const { rows } = buildModelMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        delta: {
          text: '',
          toolCalls: [
            { toolName: 'read_file', toolCallId: 'a' },
            { toolName: 'search', toolCallId: 'b' },
          ],
        },
      },
      { role: 'tool', toolName: 'read_file', toolCallId: 'a', result: 'bytes' },
      // The loop's synthetic closer for the call that never ran (cap/abort).
      { role: 'tool', toolName: 'search', toolCallId: 'b', ok: false, error: 'skipped: turn wall clock exceeded' },
    ]);
    expect(rows).toEqual([
      user('go'),
      assistant('', [
        { toolName: 'read_file', toolCallId: 'a' },
        { toolName: 'search', toolCallId: 'b' },
      ]),
      toolOk('read_file', 'a', 'bytes'),
      toolErr('search', 'b', 'skipped: turn wall clock exceeded'),
    ]);
    // Every assistant toolCallId has a following tool row (no open call).
    const ids = new Set(
      rows.flatMap((r) => (r.role === 'tool' ? [r.toolCallId] : [])),
    );
    for (const r of rows) {
      if (r.role === 'assistant') {
        for (const c of r.delta.toolCalls) {
          if (c.toolCallId) expect(ids.has(c.toolCallId)).toBe(true);
        }
      }
    }
  });

  it('row 4 — orphan-drop (review lock 2): a tool row whose toolCallId appears on no assistant row is dropped', () => {
    const { rows, truncated } = buildModelMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', delta: { text: 'hi', toolCalls: [{ toolName: 'read_file', toolCallId: 'kept' }] } },
      { role: 'tool', toolName: 'read_file', toolCallId: 'kept', result: 'bytes' },
      // Orphan: no assistant row carries toolCallId 'ghost'.
      { role: 'tool', toolName: 'search', toolCallId: 'ghost', result: 'orphan bytes' },
      // Orphan: missing toolCallId entirely.
      { role: 'tool', toolName: 'exec', result: 'no id' },
    ]);
    expect(truncated).toBe(true); // the drops are marked
    expect(rows).toEqual([
      user('go'),
      assistant('hi', [{ toolName: 'read_file', toolCallId: 'kept' }]),
      toolOk('read_file', 'kept', 'bytes'),
    ]);
    // The seeded array never carries a tool-result without its tool-call.
    const callIds = new Set(
      rows.flatMap((r) =>
        r.role === 'assistant' ? r.delta.toolCalls.map((c) => c.toolCallId) : [],
      ),
    );
    for (const r of rows) {
      if (r.role === 'tool') expect(callIds.has(r.toolCallId)).toBe(true);
    }
  });

  it('bounding: row cap keeps the NEWEST rows; over-cap is marked truncated', () => {
    const many = Array.from({ length: MODEL_MSG_CHECKPOINT_MAX_ROWS + 10 }, (_, i) => ({
      role: 'user',
      content: `m${i}`,
    }));
    const { rows, truncated } = buildModelMessages(many);
    expect(truncated).toBe(true);
    expect(rows.length).toBe(MODEL_MSG_CHECKPOINT_MAX_ROWS);
    // Keep newest: the oldest `m0` is gone; last row is the last input.
    expect(rows[0]).toEqual({
      role: 'user',
      content: `m${10}`,
    });
    expect(rows[rows.length - 1]).toEqual({
      role: 'user',
      content: `m${MODEL_MSG_CHECKPOINT_MAX_ROWS + 9}`,
    });
  });

  it('bounding: cap that drops an assistant and keeps a later tool does not seed the orphan', () => {
    const { rows } = buildModelMessages(
      [
        {
          role: 'assistant',
          delta: { text: '', toolCalls: [{ toolName: 'read_file', toolCallId: 'old' }] },
        },
        { role: 'tool', toolName: 'read_file', toolCallId: 'old', result: 'old bytes' },
        { role: 'user', content: 'follow-up' },
      ],
      { maxRows: 1 },
    );
    expect(rows).toEqual([user('follow-up')]);
  });

  it('bounding: assistant toolCalls whose results were trimmed are stripped (Goal 4)', () => {
    const { rows } = buildModelMessages(
      [
        { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'bytes' },
        {
          role: 'assistant',
          delta: {
            text: 'a',
            toolCalls: [{ toolName: 'read_file', toolCallId: 'c1' }],
          },
        },
      ],
      { maxRows: 1 },
    );
    expect(rows).toEqual([assistant('a', [])]);
  });

  it('bounding: a lone giant user row is bounded by the byte cap without throwing', () => {
    const giant = { role: 'user', content: 'x'.repeat(9 * 1024 * 1024) };
    const { rows } = buildModelMessages([giant]);
    // The single row is dropped when even it cannot fit the byte cap (fail-closed).
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it('source-lock: no Node Buffer identifier in executable code (Workflows canvas)', () => {
    const src = readFileSync(new URL('./modelMessages.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bBuffer\b/);
    expect(code).toMatch(/TextEncoder/);
  });

  it('byte-cap path works when global Buffer is absent (Workflows VM)', () => {
    const g = globalThis as { Buffer?: unknown };
    const saved = g.Buffer;
    expect(typeof saved).toBe('function');
    Reflect.deleteProperty(g, 'Buffer');
    expect(typeof g.Buffer).toBe('undefined');
    try {
      const { rows } = buildModelMessages([
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          delta: { text: '', toolCalls: [{ toolName: 'read_file', toolCallId: 'c1' }] },
        },
        { role: 'tool', toolName: 'read_file', toolCallId: 'c1', result: 'bytes' },
      ]);
      expect(rows).toEqual([
        user('hello'),
        assistant('', [{ toolName: 'read_file', toolCallId: 'c1' }]),
        toolOk('read_file', 'c1', 'bytes'),
      ]);
      expect(() =>
        buildModelMessages([{ role: 'user', content: 'x'.repeat(64 * 1024) }], {
          maxBytes: 1024,
        }),
      ).not.toThrow();
    } finally {
      g.Buffer = saved;
    }
  });
});

describe('trimModelMessagesToBudget (plan #944, testing rows 4–6 + 14)', () => {
  it('row 4 — under-budget seed passes through intact (not truncated)', () => {
    const rows = [user('go'), assistant('done', [])];
    const { rows: out, truncated } = trimModelMessagesToBudget(rows, 10_000);
    expect(truncated).toBe(false);
    expect(out).toEqual(rows);
  });

  it('row 4 — token budget: drop OLDEST until under budget; the newest row always survives', () => {
    const rows = [
      user('old-1'),
      assistant('old-2', []),
      user('old-3'),
      user('newest ask'),
    ];
    // chars/4: total 25 chars → 7 tokens. Budget 3 (12 chars): dropping
    // old-1 → 20 (5 tok), dropping assistant → 15 (4 tok), dropping old-3 →
    // 10 chars (3 tok ≤ 3) → only the newest survives.
    const { rows: out, truncated } = trimModelMessagesToBudget(rows, 3, {
      charsPerToken: 4,
    });
    expect(truncated).toBe(true);
    expect(out).toEqual([user('newest ask')]);
  });

  it('row 5 — row rail: splices the oldest rows beyond maxRows', () => {
    const rows = [user('1'), user('2'), user('3'), user('4')];
    const { rows: out, truncated } = trimModelMessagesToBudget(rows, 1_000_000, {
      maxRows: 2,
      charsPerToken: 4,
    });
    expect(truncated).toBe(true);
    expect(out).toEqual([user('3'), user('4')]);
  });

  it('row 6 — byte rail: drop oldest until the serialized seed fits the Workflow-arg bound', () => {
    const rows = [user('x'.repeat(4_000)), user('y'.repeat(4_000)), user('tail')];
    const { rows: out, truncated } = trimModelMessagesToBudget(rows, 1_000_000, {
      maxBytes: 4_200,
      charsPerToken: 4,
    });
    expect(truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4_200);
    expect(out[out.length - 1]).toEqual(user('tail'));
  });

  it('re-pairs after the trim: no orphan tool-results, no open calls', () => {
    const rows = [
      user('old ask'),
      assistant('calling', [{ toolName: 'read_file', toolCallId: 'c1' }]),
      toolOk('read_file', 'c1', 'bytes'),
      user('newest'),
    ];
    // Budget sized so the assistant+tool pair is trimmed away (the pair rides
    // or dies together via re-pair): total 38 chars → 10 tok; budget 8.
    const { rows: out } = trimModelMessagesToBudget(rows, 8, {
      charsPerToken: 4,
    });
    for (const r of out) {
      if (r.role === 'tool') {
        expect.fail('a tool row orphaned by the trim must not survive');
      }
    }
    expect(out[out.length - 1]).toEqual(user('newest'));
  });

  it('row 14 — a single oversized newest row is sent as-is (the budget trims history, never the current ask)', () => {
    const giant = user('z'.repeat(64 * 1024));
    const { rows: out } = trimModelMessagesToBudget([giant], 10, {
      charsPerToken: 4,
    });
    expect(out).toEqual([giant]);
  });

  it('locked seed caps stay pinned', () => {
    expect(MODEL_MSG_SEED_MAX_ROWS).toBe(4_096);
    expect(MODEL_MSG_SEED_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});
