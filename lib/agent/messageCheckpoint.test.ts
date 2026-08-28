import { describe, expect, it } from 'vitest';
import {
  type CheckpointRow,
  checkpointToSnapshotMessages,
  mergeCheckpointOntoPrior,
  snapshotMessagesFromUnknown,
  applyPriorMessagesToSnapshotJson,
  truncateMessageCheckpoint,
} from './messageCheckpoint';
import {
  TURN_MSG_CHECKPOINT_MAX_BYTES,
  TURN_MSG_CHECKPOINT_MAX_ROWS,
} from '../sessionCloudCaps';

function rows(n: number, content = 'm'): CheckpointRow[] {
  return Array.from({ length: n }, (_, i) => ({ role: 'user', content: `${content}${i}` }));
}

describe('truncateMessageCheckpoint (plan #800, backend-agents B6)', () => {
  it('matrix 10 — empty input yields an empty projection, truncated=false, no throw', () => {
    const out = truncateMessageCheckpoint([]);
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it('matrix 1 — well-formed rows under both caps are preserved, truncated=false', () => {
    const input: CheckpointRow[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'next' },
    ];
    const out = truncateMessageCheckpoint(input);
    expect(out.truncated).toBe(false);
    expect(out.rows).toEqual(input);
  });

  it('matrix 2 — row count > maxRows keeps the HEAD rows, truncated=true', () => {
    const out = truncateMessageCheckpoint(rows(5), { maxRows: 3 });
    expect(out.truncated).toBe(true);
    expect(out.rows.map((r) => r.content)).toEqual(['m0', 'm1', 'm2']);
  });

  it('matrix 3 — total bytes > maxBytes keeps head rows that fit, truncated=true', () => {
    const input: CheckpointRow[] = [
      { role: 'user', content: 'aaaa' },
      { role: 'assistant', content: 'bbbb' },
      { role: 'user', content: 'cccc' },
      { role: 'assistant', content: 'dddd' },
    ];
    const out = truncateMessageCheckpoint(input, { maxBytes: 40 });
    expect(out.truncated).toBe(true);
    // head-kept: the oldest row survives, later rows dropped once the byte cap bites
    expect(out.rows[0].content).toBe('aaaa');
    expect(out.rows.length).toBeLessThan(input.length);
    // the projection always fits the cap (never a lie)
    expect(Buffer.byteLength(JSON.stringify(out.rows), 'utf8')).toBeLessThanOrEqual(40);
  });

  it('matrix 4 — a single row alone > maxBytes never throws; content is truncated deterministically', () => {
    const walk = truncateMessageCheckpoint(
      [{ role: 'user', content: 'x'.repeat(500) }],
      { maxBytes: 40 },
    );
    expect(walk.truncated).toBe(true);
    expect(walk.rows.length).toBe(1);
    expect(walk.rows[0].content.length).toBeLessThan(500);
    expect(Buffer.byteLength(JSON.stringify(walk.rows), 'utf8')).toBeLessThanOrEqual(40);

    // Even a content-less row cannot fit an impossibly small cap → dropped, truncated=true.
    const dropped = truncateMessageCheckpoint([{ role: 'user', content: 'big' }], {
      maxBytes: 1,
    });
    expect(dropped.truncated).toBe(true);
    expect(dropped.rows).toEqual([]);
  });

  it('matrix 4 — oversize-row truncation is UTF-8 safe (never splits a multi-byte rune)', () => {
    // Each emoji is 4 UTF-8 bytes; a budget that lands mid-rune must not emit a broken half.
    const out = truncateMessageCheckpoint(
      [{ role: 'user', content: '😀'.repeat(100) }],
      { maxBytes: 50 },
    );
    expect(out.truncated).toBe(true);
    expect(out.rows.length).toBe(1);
    if (out.rows.length === 1) {
      // 50 - scaffolding; content budget must be a whole number of 4-byte runes (or truncate).
      const contentBytes = Buffer.byteLength(out.rows[0].content, 'utf8');
      expect(contentBytes % 4).toBe(0);
      expect(Buffer.byteLength(JSON.stringify(out.rows), 'utf8')).toBeLessThanOrEqual(50);
    }
  });

  it('matrix 4 — JSON-escaping expansion is budgeted (quote/backslash/control chars never blow the serialized cap)', () => {
    // Unlike 'x'/emoji, these need JSON escaping: each '"' or '\\' serializes to
    // 2 bytes, each control char (e.g. \u0000) to 6 bytes — 2–6× their raw UTF-8
    // footprint. The lone oversize path must budget the *serialized* size, or the
    // returned projection could exceed maxBytes (the review's L8 break scenario).
    const escapingCases: string[] = [
      '"'.repeat(500),
      '\\'.repeat(500),
      '\u0000'.repeat(200),
      ('"\u0000\\'.repeat(300)),
    ];
    for (const content of escapingCases) {
      const out = truncateMessageCheckpoint([{ role: 'user', content }], { maxBytes: 40 });
      expect(out.truncated).toBe(true);
      // the projection always fits the cap (never a lie), regardless of escaping
      expect(Buffer.byteLength(JSON.stringify(out.rows), 'utf8')).toBeLessThanOrEqual(40);
      if (out.rows.length === 1) {
        // the oversized content was actually truncated for the escaping overhead
        expect(out.rows[0].content.length).toBeLessThan(content.length);
      }
    }
  });

  it('matrix 5 — malformed rows fail closed (dropped, never throw)', () => {
    // Missing role / missing content / wrong types / bare primitives / arrays.
    const malformed = [
      null,
      undefined,
      42,
      'role',
      [],
      {},
      { role: '' },
      { role: 'user' },
      { content: 'only-content' },
      { role: 7, content: 'x' },
      { role: 'user', content: 42 },
      { role: null, content: 'x' },
    ];
    for (const bad of malformed) {
      expect(() => truncateMessageCheckpoint([{ role: 'user', content: 'ok' }, bad])).not.toThrow();
      const out = truncateMessageCheckpoint([{ role: 'user', content: 'ok' }, bad]);
      expect(out.rows[0].content).toBe('ok'); // valid head preserved
      expect(out.truncated).toBe(true); // malformed dropped → marked
    }
    // Fully malformed input → empty + truncated (never throws).
    expect(() => truncateMessageCheckpoint([null as unknown])).not.toThrow();
    const onlyBad = truncateMessageCheckpoint([null as unknown]);
    expect(onlyBad.rows).toEqual([]);
    expect(onlyBad.truncated).toBe(true);
  });

  it('matrix 5 — non-array input (undefined / object / number) fails closed, never throws', () => {
    for (const bad of [undefined, null, {}, 'string', 7]) {
      expect(() => truncateMessageCheckpoint(bad)).not.toThrow();
      const out = truncateMessageCheckpoint(bad);
      expect(out.rows).toEqual([]);
      expect(out.truncated).toBe(true);
    }
  });

  it('default caps are the locked NEW plan #800 values (4096 rows / 8 MiB)', () => {
    expect(TURN_MSG_CHECKPOINT_MAX_ROWS).toBe(4096);
    expect(TURN_MSG_CHECKPOINT_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('default run preserves a large-but-under-cap checkpoint and matches the caps', () => {
    // Well under both default caps: passes through unchanged, truncated=false.
    const many = rows(TURN_MSG_CHECKPOINT_MAX_ROWS - 1);
    const out = truncateMessageCheckpoint(many);
    expect(out.truncated).toBe(false);
    expect(out.rows.length).toBe(TURN_MSG_CHECKPOINT_MAX_ROWS - 1);

    // At the default row cap exactly → no truncation.
    const atCap = truncateMessageCheckpoint(rows(TURN_MSG_CHECKPOINT_MAX_ROWS));
    expect(atCap.truncated).toBe(false);
    expect(atCap.rows.length).toBe(TURN_MSG_CHECKPOINT_MAX_ROWS);
  });

  it('content is normalized to { role, content } only (extra fields stripped)', () => {
    const out = truncateMessageCheckpoint([
      { role: 'user', content: 'hi', extra: 'dropped' } as unknown as CheckpointRow,
    ]);
    expect(out.truncated).toBe(false);
    expect(out.rows).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('checkpointToSnapshotMessages', () => {
  it('maps user/assistant happy path with stable ids and finite at', () => {
    const out = checkpointToSnapshotMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    expect(out).toEqual([
      { id: 'cp_0', role: 'user', text: 'hello', at: 1 },
      { id: 'cp_1', role: 'assistant', text: 'hi there', at: 2 },
    ]);
  });

  it("maps checkpoint 'tool' to session 'tool_run' (not dropped)", () => {
    const out = checkpointToSnapshotMessages([
      { role: 'user', content: 'run' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'tool_run', 'assistant']);
    expect(out[1]).toEqual({
      id: 'cp_1',
      role: 'tool_run',
      text: 'file content',
      at: 2,
    });
  });

  it('drops unknown roles and keeps SessionRole members', () => {
    const out = checkpointToSnapshotMessages([
      { role: 'user', content: 'ok' },
      { role: 'narrator', content: 'nope' },
      { role: 'system', content: 'note' },
      { role: 'error', content: 'boom' },
      { role: 'skill_attached', content: '/foo' },
    ]);
    expect(out.map((m) => m.role)).toEqual([
      'user',
      'system',
      'error',
      'skill_attached',
    ]);
    expect(out.map((m) => m.id)).toEqual(['cp_0', 'cp_2', 'cp_3', 'cp_4']);
  });

  it('drops empty-text assistant rows (tool-only generateOneRound rounds)', () => {
    const out = checkpointToSnapshotMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'tool_run', 'assistant']);
    expect(out.map((m) => m.text)).toEqual(['go', 'file content', 'done']);
  });

  it('empty checkpoint yields empty messages', () => {
    expect(checkpointToSnapshotMessages([])).toEqual([]);
  });
});

describe('mergeCheckpointOntoPrior', () => {
  const u1 = { id: 'h1', role: 'user' as const, text: 'turn-1 user', at: 10 };
  const a1 = { id: 'h2', role: 'assistant' as const, text: 'turn-1 assistant', at: 11 };
  const u2 = { id: 'cp_0', role: 'user' as const, text: 'turn-2 user', at: 1 };
  const a2 = { id: 'cp_1', role: 'assistant' as const, text: 'turn-2 assistant', at: 2 };

  it('empty prior keeps incoming', () => {
    expect(mergeCheckpointOntoPrior([], [u2, a2])).toEqual([u2, a2]);
  });

  it('empty incoming keeps prior', () => {
    expect(mergeCheckpointOntoPrior([u1, a1], [])).toEqual([u1, a1]);
  });

  it('appends this-run messages after a prior turn', () => {
    const out = mergeCheckpointOntoPrior([u1, a1], [u2, a2]);
    expect(out.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      'turn-2 assistant',
    ]);
    expect(out[2]?.id).not.toBe(u1.id);
    expect(out[2]?.at).toBeGreaterThan(a1.at);
  });

  it('does not duplicate a host prior that already ends with this turn', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'turn-2 user', at: 20 };
    const hostA2 = { id: 'ha2', role: 'assistant' as const, text: 'turn-2 assistant', at: 21 };
    const out = mergeCheckpointOntoPrior([u1, a1, hostU2, hostA2], [u2, a2]);
    expect(out).toEqual([u1, a1, hostU2, hostA2]);
  });

  it('appends only the non-overlapping tail (host already has this-run user)', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'turn-2 user', at: 20 };
    const out = mergeCheckpointOntoPrior([u1, a1, hostU2], [u2, a2]);
    expect(out.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      'turn-2 assistant',
    ]);
    expect(out).toHaveLength(4);
  });

  it('does not duplicate a host prior whose tool_run payload differs from the checkpoint', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'turn-2 user', at: 20 };
    const hostTool = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"}]}',
      at: 21,
    };
    const rawTool = { id: 'cp_1', role: 'tool_run' as const, text: 'file content', at: 2 };
    const out = mergeCheckpointOntoPrior([u1, a1, hostU2, hostTool], [u2, rawTool, a2]);
    expect(out.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      hostTool.text,
      'turn-2 assistant',
    ]);
    expect(out.filter((m) => m.role === 'user' && m.text === 'turn-2 user')).toHaveLength(1);
    expect(out[4]?.role).toBe('assistant');
    expect(out[4]?.text).toBe('turn-2 assistant');
    expect(out[4]?.id).not.toBe(hostU2.id);
  });

  it('keeps a host prior that already ends with this turn including encoded tool_run', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'turn-2 user', at: 20 };
    const hostTool = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"}]}',
      at: 21,
    };
    const hostA2 = { id: 'ha2', role: 'assistant' as const, text: 'turn-2 assistant', at: 22 };
    const rawTool = { id: 'cp_1', role: 'tool_run' as const, text: 'file content', at: 2 };
    const out = mergeCheckpointOntoPrior(
      [u1, a1, hostU2, hostTool, hostA2],
      [u2, rawTool, a2],
    );
    expect(out).toEqual([u1, a1, hostU2, hostTool, hostA2]);
  });

  it('one host tool_run card covers N checkpoint tools (does not append raw extras)', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'turn-2 user', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"},{"name":"exec"}]}',
      at: 21,
    };
    const hostA2 = { id: 'ha2', role: 'assistant' as const, text: 'turn-2 assistant', at: 22 };
    const t1 = { id: 'cp_1', role: 'tool_run' as const, text: 'file content', at: 2 };
    const t2 = { id: 'cp_2', role: 'tool_run' as const, text: 'exit=0', at: 3 };
    const out = mergeCheckpointOntoPrior(
      [u1, a1, hostU2, hostCard, hostA2],
      [u2, t1, t2, a2],
    );
    expect(out).toEqual([u1, a1, hostU2, hostCard, hostA2]);
    expect(out.filter((m) => m.role === 'user' && m.text === 'turn-2 user')).toHaveLength(1);
    expect(out.filter((m) => m.role === 'assistant' && m.text === 'turn-2 assistant')).toHaveLength(
      1,
    );
  });

  it('mid-turn host card (no assistant yet) appends only the trailing assistant', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'turn-2 user', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"},{"name":"exec"}]}',
      at: 21,
    };
    const t1 = { id: 'cp_1', role: 'tool_run' as const, text: 'file content', at: 2 };
    const t2 = { id: 'cp_2', role: 'tool_run' as const, text: 'exit=0', at: 3 };
    const out = mergeCheckpointOntoPrior([u1, a1, hostU2, hostCard], [u2, t1, t2, a2]);
    expect(out.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      hostCard.text,
      'turn-2 assistant',
    ]);
    expect(out.filter((m) => m.role === 'tool_run')).toHaveLength(1);
  });

  it('skill_attached in the host this-run window does not duplicate this-run', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'turn-2 user', at: 20 };
    const skill = {
      id: 'hs',
      role: 'skill_attached' as const,
      text: 'Skill attached: create-plan',
      at: 21,
    };
    const hostTool = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"}]}',
      at: 22,
    };
    const hostA2 = { id: 'ha2', role: 'assistant' as const, text: 'turn-2 assistant', at: 23 };
    const rawTool = { id: 'cp_1', role: 'tool_run' as const, text: 'file content', at: 2 };
    const out = mergeCheckpointOntoPrior(
      [u1, a1, hostU2, skill, hostTool, hostA2],
      [u2, rawTool, a2],
    );
    expect(out).toEqual([u1, a1, hostU2, skill, hostTool, hostA2]);
  });

  it('worker-to-worker consecutive tool_run rows stay 1:1 (no greedy consume)', () => {
    const wU = { id: 'cp_0', role: 'user' as const, text: 'turn-2 user', at: 1 };
    const wT1 = { id: 'cp_1', role: 'tool_run' as const, text: 'file content', at: 2 };
    const wT2 = { id: 'cp_2', role: 'tool_run' as const, text: 'exit=0', at: 3 };
    const wA = { id: 'cp_3', role: 'assistant' as const, text: 'turn-2 assistant', at: 4 };
    const prior = [u1, a1, wU, wT1, wT2, wA];
    const out = mergeCheckpointOntoPrior(prior, [u2, wT1, wT2, a2]);
    expect(out).toEqual(prior);
  });

  it('skips incoming preamble assistant in front of a host tool card', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'turn-2 user', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"},{"name":"exec"}]}',
      at: 21,
    };
    const preamble = {
      id: 'cp_1',
      role: 'assistant' as const,
      text: 'Let me read that',
      at: 2,
    };
    const t1 = { id: 'cp_2', role: 'tool_run' as const, text: 'file content', at: 3 };
    const t2 = { id: 'cp_3', role: 'tool_run' as const, text: 'exit=0', at: 4 };
    const out = mergeCheckpointOntoPrior(
      [u1, a1, hostU2, hostCard],
      [u2, preamble, t1, t2, a2],
    );
    expect(out.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      hostCard.text,
      'Let me read thatturn-2 assistant',
    ]);
    expect(out.filter((m) => m.role === 'user' && m.text === 'turn-2 user')).toHaveLength(1);
    expect(out.filter((m) => m.role === 'tool_run')).toHaveLength(1);
  });

  it('host trailing concatenated done.text covers last-round checkpoint assistant', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'turn-2 user', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"}]}',
      at: 21,
    };
    const hostA2 = {
      id: 'ha2',
      role: 'assistant' as const,
      text: 'Let me read that\nfile looks good',
      at: 22,
    };
    const preamble = {
      id: 'cp_1',
      role: 'assistant' as const,
      text: 'Let me read that',
      at: 2,
    };
    const rawTool = { id: 'cp_2', role: 'tool_run' as const, text: 'file content', at: 3 };
    const last = {
      id: 'cp_3',
      role: 'assistant' as const,
      text: 'file looks good',
      at: 4,
    };
    const out = mergeCheckpointOntoPrior(
      [u1, a1, hostU2, hostCard, hostA2],
      [u2, preamble, rawTool, last],
    );
    expect(out).toEqual([u1, a1, hostU2, hostCard, hostA2]);
  });

  it('same user text + tools + different assistant appends the new turn', () => {
    const uA = { id: 'h1', role: 'user' as const, text: 'continue', at: 10 };
    const tA = {
      id: 'h2',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"}]}',
      at: 11,
    };
    const aA = {
      id: 'h3',
      role: 'assistant' as const,
      text: 'here is the first analysis',
      at: 12,
    };
    const uB = { id: 'cp_0', role: 'user' as const, text: 'continue', at: 1 };
    const tB = { id: 'cp_1', role: 'tool_run' as const, text: 'exit=0', at: 2 };
    const aB = {
      id: 'cp_2',
      role: 'assistant' as const,
      text: 'now I will edit the file',
      at: 3,
    };
    const out = mergeCheckpointOntoPrior([uA, tA, aA], [uB, tB, aB]);
    expect(out.map((m) => m.text)).toEqual([
      'continue',
      tA.text,
      'here is the first analysis',
      'continue',
      'exit=0',
      'now I will edit the file',
    ]);
  });

  it('worker-to-worker preamble assistant stays 1:1 (not skipped)', () => {
    const wU = { id: 'cp_0', role: 'user' as const, text: 'turn-2 user', at: 1 };
    const wPre = { id: 'cp_1', role: 'assistant' as const, text: 'Let me read that', at: 2 };
    const wT = { id: 'cp_2', role: 'tool_run' as const, text: 'file content', at: 3 };
    const wA = { id: 'cp_3', role: 'assistant' as const, text: 'file looks good', at: 4 };
    const prior = [u1, a1, wU, wPre, wT, wA];
    const out = mergeCheckpointOntoPrior(prior, [u2, wPre, wT, wA]);
    expect(out).toEqual(prior);
  });

  it('interleaved per-round assistants vs mid-turn host card keep all this-run assistant prose', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'fix the tests', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"},{"name":"exec"}]}',
      at: 21,
    };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'I will run the tests' },
      { role: 'tool', content: 'exit=1' },
      { role: 'assistant', content: '3 passed' },
    ]);
    const out = mergeCheckpointOntoPrior([u1, a1, hostU2, hostCard], incoming);
    expect(out.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'tool_run',
      'assistant',
    ]);
    expect(out.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      hostCard.text,
      'Let me read the fileI will run the tests3 passed',
    ]);
    expect(out.filter((m) => m.role === 'tool_run')).toHaveLength(1);
    expect(out.filter((m) => m.role === 'user' && m.text === 'fix the tests')).toHaveLength(
      1,
    );
  });

  it('empty last-round vs mid-turn host card keeps skipped this-run assistant prose', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'fix the tests', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"},{"name":"exec"}]}',
      at: 21,
    };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'I will run the tests' },
      { role: 'tool', content: 'exit=1' },
      { role: 'assistant', content: '' },
    ]);
    expect(incoming.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool_run',
      'assistant',
      'tool_run',
    ]);
    const out = mergeCheckpointOntoPrior([u1, a1, hostU2, hostCard], incoming);
    expect(out.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'tool_run',
      'assistant',
    ]);
    expect(out.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      hostCard.text,
      'Let me read the fileI will run the tests',
    ]);
    expect(out.filter((m) => m.role === 'tool_run')).toHaveLength(1);
  });

  it('interleaved per-round assistants vs trailing host concat do not duplicate the user', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'fix the tests', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"},{"name":"exec"}]}',
      at: 21,
    };
    const hostA2 = {
      id: 'ha2',
      role: 'assistant' as const,
      text: 'Let me read the file\nI will run the tests\n3 passed',
      at: 22,
    };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'I will run the tests' },
      { role: 'tool', content: 'exit=1' },
      { role: 'assistant', content: '3 passed' },
    ]);
    const prior = [u1, a1, hostU2, hostCard, hostA2];
    const out = mergeCheckpointOntoPrior(prior, incoming);
    expect(out).toEqual(prior);
    expect(out.filter((m) => m.role === 'user' && m.text === 'fix the tests')).toHaveLength(
      1,
    );
  });

  it('new assistant ending with a prior short ack appends (no reverse endsWith cover)', () => {
    const uA = { id: 'h1', role: 'user' as const, text: 'continue', at: 10 };
    const tA = {
      id: 'h2',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"}]}',
      at: 11,
    };
    const aA = { id: 'h3', role: 'assistant' as const, text: 'OK', at: 12 };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'continue' },
      { role: 'tool', content: 'exit=0' },
      { role: 'assistant', content: 'All tests passed. OK' },
    ]);
    const out = mergeCheckpointOntoPrior([uA, tA, aA], incoming);
    expect(out.map((m) => m.text)).toEqual([
      'continue',
      tA.text,
      'OK',
      'continue',
      'exit=0',
      'All tests passed. OK',
    ]);
  });

  it('worker-to-worker interleaved tools stay 1:1 on persist retry', () => {
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'I will run the tests' },
      { role: 'tool', content: 'exit=1' },
      { role: 'assistant', content: '3 passed' },
    ]);
    const prior = [u1, a1, ...incoming];
    const out = mergeCheckpointOntoPrior(prior, incoming);
    expect(out).toEqual(prior);
  });

  it('worker-to-worker empty last-round persist retry does not duplicate assts', () => {
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'I will run the tests' },
      { role: 'tool', content: 'exit=1' },
      { role: 'assistant', content: '' },
    ]);
    expect(incoming.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool_run',
      'assistant',
      'tool_run',
    ]);
    const prior = [u1, a1, ...incoming];
    const out = mergeCheckpointOntoPrior(prior, incoming);
    expect(out).toEqual(prior);
    expect(out.filter((m) => m.text === 'Let me read the file')).toHaveLength(1);
    expect(out.filter((m) => m.text === 'I will run the tests')).toHaveLength(1);
  });

  it('empty last-round persist retry onto folded mid-turn snapshot does not append leftover tool', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'fix the tests', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"},{"name":"exec"}]}',
      at: 21,
    };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'I will run the tests' },
      { role: 'tool', content: 'exit=1' },
      { role: 'assistant', content: '' },
    ]);
    const folded = mergeCheckpointOntoPrior([u1, a1, hostU2, hostCard], incoming);
    expect(folded.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      hostCard.text,
      'Let me read the fileI will run the tests',
    ]);
    const retry = mergeCheckpointOntoPrior(folded, incoming);
    expect(retry.map((m) => m.text)).toEqual(folded.map((m) => m.text));
    expect(retry.filter((m) => m.role === 'tool_run')).toHaveLength(1);
    expect(retry.filter((m) => m.role === 'user' && m.text === 'fix the tests')).toHaveLength(1);
  });

  it('empty last-round retry onto folded snapshot keeps trailing Turn ended system', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'fix the tests', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"},{"name":"exec"}]}',
      at: 21,
    };
    const foldedAsst = {
      id: 'hf',
      role: 'assistant' as const,
      text: 'Let me read the fileI will run the tests',
      at: 22,
    };
    const turnEnd = {
      id: 'hs',
      role: 'system' as const,
      text: 'Turn ended · model finished',
      at: 23,
    };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'I will run the tests' },
      { role: 'tool', content: 'exit=1' },
      { role: 'assistant', content: '' },
    ]);
    const prior = [u1, a1, hostU2, hostCard, foldedAsst, turnEnd];
    const out = mergeCheckpointOntoPrior(prior, incoming);
    expect(out).toEqual(prior);
  });

  it('completed host persistTurn trailing Turn ended + nonempty last-round is not duplicated', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'fix the tests', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"},{"name":"exec"}]}',
      at: 21,
    };
    const concat = {
      id: 'ha2',
      role: 'assistant' as const,
      text: 'Let me read the file\nI will run the tests\n3 passed',
      at: 22,
    };
    const turnEnd = {
      id: 'hs',
      role: 'system' as const,
      text: 'Turn ended · model finished',
      at: 23,
    };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'I will run the tests' },
      { role: 'tool', content: 'exit=1' },
      { role: 'assistant', content: '3 passed' },
    ]);
    const prior = [u1, a1, hostU2, hostCard, concat, turnEnd];
    const out = mergeCheckpointOntoPrior(prior, incoming);
    expect(out).toEqual(prior);
    expect(out.filter((m) => m.role === 'user' && m.text === 'fix the tests')).toHaveLength(1);
  });

  it('thinking-split two host cards vs interleaved tools keep one user and fold assts', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'fix the tests', at: 20 };
    const card1 = {
      id: 'ht1',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"}]}',
      at: 21,
    };
    const card2 = {
      id: 'ht2',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"exec"}]}',
      at: 22,
    };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'I will run the tests' },
      { role: 'tool', content: 'exit=0' },
      { role: 'assistant', content: '3 passed' },
    ]);
    const out = mergeCheckpointOntoPrior([u1, a1, hostU2, card1, card2], incoming);
    expect(out.filter((m) => m.role === 'user' && m.text === 'fix the tests')).toHaveLength(1);
    expect(out.filter((m) => m.role === 'tool_run')).toHaveLength(2);
    expect(out.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      card1.text,
      card2.text,
      'Let me read the fileI will run the tests3 passed',
    ]);
  });

  it('thinking-split two host cards + empty last-round folds skipped assts', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'fix the tests', at: 20 };
    const card1 = {
      id: 'ht1',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"read_file"}]}',
      at: 21,
    };
    const card2 = {
      id: 'ht2',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"exec"}]}',
      at: 22,
    };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: 'I will run the tests' },
      { role: 'tool', content: 'exit=0' },
      { role: 'assistant', content: '' },
    ]);
    const out = mergeCheckpointOntoPrior([u1, a1, hostU2, card1, card2], incoming);
    expect(out.filter((m) => m.role === 'user' && m.text === 'fix the tests')).toHaveLength(1);
    expect(out.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      card1.text,
      card2.text,
      'Let me read the fileI will run the tests',
    ]);
  });

  it('user-only prior (usage before first tool) appends this-run tools and assts', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'fix the tests', at: 20 };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me read the file' },
      { role: 'tool', content: 'file content' },
      { role: 'assistant', content: '3 passed' },
    ]);
    const out = mergeCheckpointOntoPrior([u1, a1, hostU2], incoming);
    expect(out.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'fix the tests',
      'Let me read the file',
      'file content',
      '3 passed',
    ]);
  });

  it('error after mid-turn host card + empty last-round keeps error and folds assts', () => {
    const hostU2 = { id: 'hu2', role: 'user' as const, text: 'fix the tests', at: 20 };
    const hostCard = {
      id: 'ht',
      role: 'tool_run' as const,
      text: '{"tools":[{"name":"exec"}]}',
      at: 21,
    };
    const err = { id: 'he', role: 'error' as const, text: 'tool failed', at: 22 };
    const incoming = checkpointToSnapshotMessages([
      { role: 'user', content: 'fix the tests' },
      { role: 'assistant', content: 'Let me run' },
      { role: 'tool', content: 'exit=1' },
      { role: 'assistant', content: '' },
    ]);
    const out = mergeCheckpointOntoPrior([u1, a1, hostU2, hostCard, err], incoming);
    expect(out.filter((m) => m.role === 'user' && m.text === 'fix the tests')).toHaveLength(1);
    expect(out.filter((m) => m.role === 'error')).toHaveLength(1);
    expect(out[out.length - 1]?.text).toBe('Let me run');
  });
});

describe('snapshotMessagesFromUnknown / applyPriorMessagesToSnapshotJson', () => {
  it('rejects leftover { deltas } and mismatched id', () => {
    expect(snapshotMessagesFromUnknown({ deltas: [{ d: 1 }] }, 's1')).toBeNull();
    expect(
      snapshotMessagesFromUnknown(
        { id: 'other', updatedAt: 1, messages: [] },
        's1',
      ),
    ).toBeNull();
  });

  it('merges this-run JSON onto a prior snapshot without stamping a clock', () => {
    const prior = [{ id: 'h1', role: 'user' as const, text: 't1', at: 5 }];
    const content = JSON.stringify({
      id: 's1',
      messages: [{ id: 'cp_0', role: 'user', text: 't2', at: 1 }],
      deltas: [{ d: 1 }],
    });
    const out = applyPriorMessagesToSnapshotJson(content, prior, 's1');
    expect(out).not.toBeNull();
    const body = JSON.parse(out ?? 'null') as {
      id: string;
      updatedAt?: number;
      messages: Array<{ text: string }>;
      deltas: unknown[];
    };
    expect(body.id).toBe('s1');
    expect(body.updatedAt).toBeUndefined();
    expect(body.messages.map((m) => m.text)).toEqual(['t1', 't2']);
    expect(body.deltas).toEqual([{ d: 1 }]);
  });

  it('returns null for a non-snapshot object so the seam can stamp the original', () => {
    expect(applyPriorMessagesToSnapshotJson('{"delta":"x"}', [], 's1')).toBeNull();
  });
});
