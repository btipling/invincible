import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_CHUNK_WALK_MAX } from '../sessionCloudCaps';
import {
  flattenReconstructedBody,
  reconstructFromPointer,
  reconstructTranscriptChain,
  transcriptChunkPrev,
} from './transcriptChunks';

const SESSION = 'session-1';

function msg(id: string, text: string, at = 1) {
  return { id, role: 'user' as const, text, at };
}

function snap(messages: ReturnType<typeof msg>[], prev?: string) {
  return {
    id: SESSION,
    updatedAt: 1,
    messages,
    ...(prev !== undefined ? { prev } : {}),
  };
}

describe('transcriptChunkPrev', () => {
  it('omitted / null is one-node', () => {
    expect(transcriptChunkPrev({ id: SESSION, messages: [] })).toEqual({ kind: 'none' });
    expect(transcriptChunkPrev({ id: SESSION, messages: [], prev: null })).toEqual({
      kind: 'none',
    });
  });

  it('opaque string is an id; garbage is invalid', () => {
    expect(transcriptChunkPrev({ prev: 't_abc_def' })).toEqual({
      kind: 'id',
      id: 't_abc_def',
    });
    expect(transcriptChunkPrev({ prev: 'a:b' }).kind).toBe('invalid');
    expect(transcriptChunkPrev({ prev: 1 }).kind).toBe('invalid');
  });
});

describe('reconstructTranscriptChain (plan #886)', () => {
  it('one-node legacy (no prev) is the full list', async () => {
    const head = snap([msg('m1', 'hello')]);
    const got = await reconstructTranscriptChain({
      sessionId: SESSION,
      headId: 't_head_1',
      headBody: head,
      read: async () => {
        throw new Error('must not read');
      },
      isBound: () => true,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.messages.map((m) => m.text)).toEqual(['hello']);
  });

  it('two-node chain suffix-merges oldest then this-run', async () => {
    const older = snap([msg('m1', 'turn-1 user'), msg('m2', 'turn-1 assistant', 2)]);
    const head = snap(
      [msg('m3', 'turn-2 user'), msg('m4', 'turn-2 assistant', 2)],
      't_old_1',
    );
    const store = new Map<string, unknown>([['t_old_1', older]]);
    const got = await reconstructTranscriptChain({
      sessionId: SESSION,
      headId: 't_head_1',
      headBody: head,
      read: async (id) => store.get(id) ?? null,
      isBound: () => true,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      'turn-2 assistant',
    ]);
  });

  it('host flatten root (no prev) is the full list', async () => {
    const flatten = snap([
      msg('h1', 'turn-1 user'),
      msg('h2', 'turn-1 assistant', 2),
      msg('h3', 'turn-2 user', 3),
    ]);
    const got = await reconstructTranscriptChain({
      sessionId: SESSION,
      headId: 't_flat_1',
      headBody: flatten,
      read: async () => null,
      isBound: () => true,
    });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.messages.map((m) => m.id)).toEqual(['h1', 'h2', 'h3']);
  });

  it('foreign prev fail-closed', async () => {
    const head = snap([msg('m1', 'this-run')], 't_foreign_1');
    const got = await reconstructTranscriptChain({
      sessionId: SESSION,
      headId: 't_head_1',
      headBody: head,
      read: async () => snap([msg('x', 'secret')]),
      isBound: (id) => id === 't_head_1',
    });
    expect(got).toMatchObject({ ok: false, code: 'foreign_prev' });
  });

  it('cycle fail-closed', async () => {
    const a = snap([msg('a', 'a')], 't_b');
    const b = snap([msg('b', 'b')], 't_a');
    const store = new Map<string, unknown>([
      ['t_a', a],
      ['t_b', b],
    ]);
    const got = await reconstructTranscriptChain({
      sessionId: SESSION,
      headId: 't_a',
      headBody: a,
      read: async (id) => store.get(id) ?? null,
      isBound: () => true,
    });
    expect(got).toMatchObject({ ok: false, code: 'loop' });
  });

  it('walk cap fail-closed', async () => {
    const c = snap([msg('c', 'c')]);
    const b = snap([msg('b', 'b')], 't_c');
    const a = snap([msg('a', 'a')], 't_b');
    const store = new Map<string, unknown>([
      ['t_b', b],
      ['t_c', c],
    ]);
    const got = await reconstructTranscriptChain({
      sessionId: SESSION,
      headId: 't_a',
      headBody: a,
      read: async (id) => store.get(id) ?? null,
      isBound: () => true,
      maxWalk: 2,
    });
    expect(got).toMatchObject({ ok: false, code: 'walk_cap' });
  });

  it('missing prev object fail-closed (not this-chunk-only)', async () => {
    const head = snap([msg('m1', 'this-run')], 't_missing');
    const got = await reconstructTranscriptChain({
      sessionId: SESSION,
      headId: 't_head_1',
      headBody: head,
      read: async () => null,
      isBound: () => true,
    });
    expect(got).toMatchObject({ ok: false, code: 'missing' });
  });

  it('TRANSCRIPT_CHUNK_WALK_MAX is 256', () => {
    expect(TRANSCRIPT_CHUNK_WALK_MAX).toBe(256);
  });
});

describe('reconstructFromPointer + flatten', () => {
  it('pointer miss is missing; flatten drops prev', async () => {
    const miss = await reconstructFromPointer({
      pointer: 't_head_1',
      sessionId: SESSION,
      readRaw: async () => null,
      isBound: () => true,
    });
    expect(miss).toMatchObject({ ok: false, code: 'missing' });

    const body = flattenReconstructedBody(
      snap([msg('m1', 'x')], 't_old'),
      SESSION,
      [msg('m1', 'x')],
    );
    expect(body.prev).toBeUndefined();
    expect(body.id).toBe(SESSION);
    expect((body.messages as { text: string }[])[0].text).toBe('x');
  });
});
