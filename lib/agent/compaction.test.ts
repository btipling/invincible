/**
 * Tests for the compaction primitives (plan #948, source #552 — A4 phase 1).
 * Covers the plan's Testing table rows 1–4:
 *  1. `findCompactionCut` never splits an assistant `toolCalls` row from its
 *     `tool` result rows; cut lands on a `user` boundary; re-pair drops
 *     orphans on BOTH sides.
 *  2. `findCompactionCut` returns `null` when no clean user boundary exists
 *     (single user turn) / no cut possible.
 *  3. `renderSummaryRow` labels the row `Summary of earlier session
 *     (compacted…)` and emits `user` role, never assistant.
 *  4. `buildCheckpoint` enforces `COMPACTION_SUMMARY_MAX_CHARS` +
 *     `COMPACTION_FILES_TOUCHED_MAX` (bounded, explicit markers on overflow).
 */
import { describe, expect, it } from 'vitest';
import {
  COMPACTION_FILES_TOUCHED_MAX,
  COMPACTION_SUMMARY_MAX_CHARS,
} from '../sessionCloudCaps';
import {
  buildCheckpoint,
  findCompactionCut,
  renderSummaryRow,
} from './compaction';
import { rePairModelMessages, type ModelMessageRow } from './modelMessages';

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

describe('findCompactionCut (plan #948 row 1 + 2)', () => {
  it('cut lands on a user boundary; tail fits; span + tail re-paired', () => {
    // turn 1 (heavy, compacted) | turn 2 (retained tail).
    const rows: ModelMessageRow[] = [
      user('first ask'),
      assistant('working', [{ toolName: 'read_file', toolCallId: 'c1' }]),
      toolOk('read_file', 'c1', 'x'.repeat(4000)),
      assistant('done turn 1'),
      user('second ask'),
      assistant('also working'),
    ];
    // Budget that fits only the second turn's tail.
    const tailJson = JSON.stringify(rows.slice(4));
    const budget = Math.ceil(tailJson.length / 4) + 1;
    const cut = findCompactionCut(rows, budget);
    expect(cut).not.toBeNull();
    expect(cut!.cutIndex).toBe(4);
    expect(rows[cut!.cutIndex].role).toBe('user');
    expect(cut!.tail).toEqual(rows.slice(4));
    expect(cut!.span).toEqual(rows.slice(0, 4));
  });

  it('row 1 — NEVER splits a call from its result: boundary candidates next to tool rows are rejected', () => {
    // The newest user boundary sits BETWEEN the assistant call row and its
    // tool result only if roles were adversarial — here the pair is atomic,
    // and the cut walk must only ever land ON a user row.
    const rows: ModelMessageRow[] = [
      user('ask one'),
      assistant('calling', [{ toolName: 'search', toolCallId: 'c1' }]),
      toolOk('search', 'c1', 'big'.repeat(2000)),
      user('ask two'),
      assistant('final answer'),
    ];
    const budget = Math.ceil(JSON.stringify(rows.slice(3)).length / 4) + 1;
    const cut = findCompactionCut(rows, budget);
    expect(cut).not.toBeNull();
    // The cut is exactly at the user row — never at index 1/2 (inside the pair).
    expect(cut!.cutIndex).toBe(3);
    // Both sides are pair-clean: no tool row without its call, no call
    // without its result.
    for (const side of [cut!.span, cut!.tail]) {
      const callIds = new Set(
        side.flatMap((r) =>
          r.role === 'assistant' ? r.delta.toolCalls.map((c) => c.toolCallId) : [],
        ),
      );
      for (const r of side) {
        if (r.role === 'tool') expect(callIds.has(r.toolCallId)).toBe(true);
      }
      for (const id of callIds) {
        if (typeof id === 'string') {
          expect(side.some((r) => r.role === 'tool' && r.toolCallId === id)).toBe(true);
        }
      }
    }
  });

  it('row 1 — orphan tool rows are dropped from the span by re-pair (reuse, not fork)', () => {
    const rows: ModelMessageRow[] = [
      user('ask'),
      assistant('calling', [{ toolName: 'read_file', toolCallId: 'c1' }]),
      toolOk('read_file', 'c1', 'result'),
      // Orphan: a tool row whose call no assistant row carries.
      toolOk('exec', 'ghost', 'orphan result'),
      user('ask two'),
      assistant('done'),
    ];
    const budget = Math.ceil(JSON.stringify(rows.slice(4)).length / 4) + 1;
    const cut = findCompactionCut(rows, budget);
    expect(cut).not.toBeNull();
    expect(cut!.cutIndex).toBe(4);
    // The orphan is gone from the span (rePairModelMessages reused).
    expect(cut!.span.some((r) => r.role === 'tool' && r.toolCallId === 'ghost')).toBe(false);
    // And a direct rePair call matches (behavior unmodified).
    expect(cut!.span).toEqual(rePairModelMessages(rows.slice(0, 4)));
  });

  it('row 1 — an open call in the span has its toolCalls stripped by re-pair', () => {
    const rows: ModelMessageRow[] = [
      user('ask'),
      assistant('calling', [
        { toolName: 'read_file', toolCallId: 'c1' },
        { toolName: 'search', toolCallId: 'c2' },
      ]),
      toolOk('read_file', 'c1', 'result'),
      // c2 never got a result — re-pair strips c2 from the span's calls.
      user('ask two'),
      assistant('done'),
    ];
    const budget = Math.ceil(JSON.stringify(rows.slice(3)).length / 4) + 1;
    const cut = findCompactionCut(rows, budget);
    expect(cut).not.toBeNull();
    const callIds = cut!.span.flatMap((r) =>
      r.role === 'assistant' ? r.delta.toolCalls.map((c) => c.toolCallId) : [],
    );
    expect(callIds).toEqual(['c1']);
    expect(cut!.span.length).toBe(3);
  });

  it('row 2 — no user boundary inside (single turn) → null', () => {
    const rows: ModelMessageRow[] = [
      user('one giant ask'),
      assistant('working', [{ toolName: 'read_file', toolCallId: 'c1' }]),
      toolOk('read_file', 'c1', 'big'.repeat(10_000)),
    ];
    expect(findCompactionCut(rows, 1)).toBeNull();
    expect(findCompactionCut([], 10_000)).toBeNull();
  });

  it('row 2 — only boundary is index 0 (no compactable history) → null', () => {
    const rows: ModelMessageRow[] = [user('ask'), assistant('reply')];
    expect(findCompactionCut(rows, 1)).toBeNull();
  });

  it('row 2 — every boundary tail over the budget → null (never fabricate a cut)', () => {
    const rows: ModelMessageRow[] = [
      user('ask one'),
      assistant('x'.repeat(5000)),
      user('ask two'),
      assistant('y'.repeat(5000)),
    ];
    expect(findCompactionCut(rows, 1)).toBeNull();
  });

  it('row/byte rails: a boundary whose tail busts maxRows or maxBytes is skipped', () => {
    const rows: ModelMessageRow[] = [
      user('ask one'),
      assistant('x'),
      user('ask two'),
      assistant('y'),
    ];
    // Tail [2..3] is 2 rows — a maxRows=1 rail rejects it; boundary 2 fails,
    // boundary... only boundary is 2 → null.
    expect(findCompactionCut(rows, 10_000, { maxRows: 1 })).toBeNull();
    // maxBytes=1 rejects every tail → null.
    expect(findCompactionCut(rows, 10_000, { maxBytes: 1 })).toBeNull();
  });

  it('newest fitting boundary wins (largest compactable span at the budget)', () => {
    const rows: ModelMessageRow[] = [
      user('t1'),
      assistant('a'),
      user('t2'),
      assistant('b'),
      user('t3'),
      assistant('c'),
    ];
    // Budget fits only [4..5] (t3) — cut at 4.
    const small = Math.ceil(JSON.stringify(rows.slice(4)).length / 4) + 1;
    expect(findCompactionCut(rows, small)?.cutIndex).toBe(4);
    // Bigger budget: the plan locks the NEWEST fitting boundary, so the cut
    // stays at 4 — a larger budget never moves the cut earlier on its own.
    const mid = Math.ceil(JSON.stringify(rows.slice(2)).length / 4) + 1;
    expect(findCompactionCut(rows, mid)?.cutIndex).toBe(4);
    // Exact math (charsPerToken=1): tails grow monotonically as the boundary
    // moves earlier, so a budget one byte under the newest tail fits NO
    // boundary → null (never fabricate a cut).
    const tail45 = JSON.stringify(rows.slice(4)).length;
    expect(findCompactionCut(rows, tail45, { charsPerToken: 1 })?.cutIndex).toBe(4);
    expect(findCompactionCut(rows, tail45 - 1, { charsPerToken: 1 })).toBeNull();
  });

  it('charsPerToken override is honored (test seam)', () => {
    const rows: ModelMessageRow[] = [
      user('t1'),
      assistant('abcdefgh'), // 8 chars
      user('t2'),
      assistant('ij'),
    ];
    const tailJson = JSON.stringify(rows.slice(2));
    // ratio 1 → tokens = chars.
    const budget = tailJson.length + 1;
    expect(findCompactionCut(rows, budget, { charsPerToken: 1 })?.cutIndex).toBe(2);
  });
});

describe('renderSummaryRow (plan #948 row 3 — honesty lock)', () => {
  it('emits a user-role row with the locked compaction label, never assistant', () => {
    const row = renderSummaryRow('We built the cut walk.', ['lib/agent/compaction.ts']);
    expect(row.role).toBe('user');
    if (row.role !== 'user') return; // type-narrow for the union
    expect(row.content.startsWith('Summary of earlier session (compacted, not live assistant prose):')).toBe(true);
    expect(row.content).toContain('We built the cut walk.');
    expect(row.content).toContain('Files read/modified: lib/agent/compaction.ts');
    expect(JSON.stringify(row)).not.toContain('"role":"assistant"');
  });

  it('files line omitted when no paths; empty summary still renders the honest label', () => {
    const row = renderSummaryRow('', []);
    expect(row.role).toBe('user');
    if (row.role !== 'user') return;
    expect(row.content).toBe(
      'Summary of earlier session (compacted, not live assistant prose): ',
    );
    expect(row.content).not.toContain('Files read/modified:');
  });

  it('multiple paths join with commas', () => {
    const row = renderSummaryRow('s', ['a.ts', 'b.ts']);
    expect(row.role).toBe('user');
    if (row.role !== 'user') return;
    expect(row.content).toContain('Files read/modified: a.ts, b.ts');
  });
});

describe('buildCheckpoint (plan #948 row 4 — caps table enforcement)', () => {
  it('summary over COMPACTION_SUMMARY_MAX_CHARS is code-point-bounded + explicit marker', () => {
    expect(COMPACTION_SUMMARY_MAX_CHARS).toBe(8_000);
    const fat = 'x'.repeat(COMPACTION_SUMMARY_MAX_CHARS * 3);
    const cp = buildCheckpoint({ summary: fat, filesTouched: [] }, []);
    expect(cp.summary.length).toBeLessThanOrEqual(COMPACTION_SUMMARY_MAX_CHARS + 40);
    expect(cp.summary).toContain('… [summary truncated]');
    // Surrogate pairs never split: an emoji-heavy fat summary stays valid.
    const emojiFat = '🙂'.repeat(COMPACTION_SUMMARY_MAX_CHARS);
    const cp2 = buildCheckpoint({ summary: emojiFat, filesTouched: [] }, []);
    expect(cp2.summary).toContain('🙂');
    expect(cp2.summary).toContain('… [summary truncated]');
  });

  it('filesTouched over COMPACTION_FILES_TOUCHED_MAX keeps the NEWEST + honest omitted marker', () => {
    expect(COMPACTION_FILES_TOUCHED_MAX).toBe(256);
    const paths = Array.from({ length: COMPACTION_FILES_TOUCHED_MAX + 10 }, (_, i) => `p${i}.ts`);
    const cp = buildCheckpoint({ summary: 's', filesTouched: paths }, []);
    expect(cp.filesTouched.length).toBe(COMPACTION_FILES_TOUCHED_MAX);
    expect(cp.filesTouched[0]).toBe(`p10.ts`); // oldest dropped
    expect(cp.filesTouched.at(-1)).toBe(`p${paths.length - 1}.ts`); // newest kept
    expect(cp.summary).toContain('earlier paths omitted');
  });

  it('non-string / duplicate / empty paths are dropped (dedupe, first-seen order)', () => {
    const cp = buildCheckpoint(
      { summary: 's', filesTouched: ['a.ts', 'a.ts', '', 42 as unknown as string, 'b.ts'] },
      [],
    );
    expect(cp.filesTouched).toEqual(['a.ts', 'b.ts']);
    expect(cp.summary).not.toContain('omitted');
  });

  it('retainedTail is re-paired (orphan tool rows dropped; open calls stripped)', () => {
    const tail: ModelMessageRow[] = [
      assistant('calling', [{ toolName: 'read_file', toolCallId: 'c1' }]),
      toolOk('read_file', 'c1', 'result'),
      toolOk('exec', 'ghost', 'orphan'),
    ];
    const cp = buildCheckpoint({ summary: 's', filesTouched: [] }, tail);
    expect(cp.retainedTail.some((r) => r.role === 'tool' && r.toolCallId === 'ghost')).toBe(false);
  });

  it('empty span inputs stay honest: empty summary + no files → labeled empty checkpoint', () => {
    const cp = buildCheckpoint({ summary: '', filesTouched: [] }, [user('hi')]);
    expect(cp.summary).toBe('');
    expect(cp.filesTouched).toEqual([]);
    expect(cp.retainedTail).toEqual([user('hi')]);
  });
});
