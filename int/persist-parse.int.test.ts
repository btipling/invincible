import { describe, expect, it } from 'vitest';
import { parseCloudSessionSnapshot } from '../lib/sessionRepository';
import { reconstructTranscriptChain } from '../lib/sessions/transcriptChunks';
import { isObjectIdBoundTo } from '../lib/sessions/blobStore';
import { INT_SCOPE, persistTurn1, persistTurn2 } from './stores';

describe('int persist-parse (#859 row 1 pointer clobber)', () => {
  it('persistTurn1 writes a JSON blob onto transcriptPointer (fixture smoke)', async () => {
    const { blobStore, envelopeStore, objectId } = await persistTurn1();
    const env = await envelopeStore.readEnvelope({
      tenantId: INT_SCOPE.tenantId,
      userId: INT_SCOPE.userId,
      sessionId: INT_SCOPE.sessionId,
    });
    const pointer =
      (typeof env?.meta?.transcriptPointer === 'string' && env.meta.transcriptPointer) ||
      objectId;
    expect(pointer).toBeTruthy();
    const raw = pointer ? await blobStore.read(pointer) : null;
    expect(raw).toBeTruthy();
    expect(() => JSON.parse(raw ?? '')).not.toThrow();
  });

  it('#859 row 1: worker persist blob parses as SessionSnapshot', async () => {
    const { blobStore, envelopeStore, objectId } = await persistTurn1();
    const env = await envelopeStore.readEnvelope({
      tenantId: INT_SCOPE.tenantId,
      userId: INT_SCOPE.userId,
      sessionId: INT_SCOPE.sessionId,
    });
    const pointer =
      (typeof env?.meta?.transcriptPointer === 'string' && env.meta.transcriptPointer) ||
      objectId;
    expect(pointer).toBeTruthy();
    const raw = pointer ? await blobStore.read(pointer) : null;
    expect(raw).toBeTruthy();
    const parsed = parseCloudSessionSnapshot(JSON.parse(raw ?? 'null'), INT_SCOPE.sessionId);
    expect(parsed).not.toBeNull();
    expect(parsed?.messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('second persist keeps turn-1 user on the reconstructed chain', async () => {
    const world = await persistTurn1();
    const second = await persistTurn2(world);
    const env = await world.envelopeStore.readEnvelope({
      tenantId: INT_SCOPE.tenantId,
      userId: INT_SCOPE.userId,
      sessionId: INT_SCOPE.sessionId,
    });
    const pointer =
      (typeof env?.meta?.transcriptPointer === 'string' && env.meta.transcriptPointer) ||
      second.objectId;
    expect(pointer).toBeTruthy();
    if (!pointer) return;
    const raw = await world.blobStore.read(pointer);
    const head = JSON.parse(raw ?? 'null');
    const latest = parseCloudSessionSnapshot(head, INT_SCOPE.sessionId);
    expect(latest?.messages.map((m) => m.text)).toEqual([
      'turn-2 user',
      'turn-2 assistant',
    ]);
    const walked = await reconstructTranscriptChain({
      sessionId: INT_SCOPE.sessionId,
      headId: pointer,
      headBody: head,
      read: async (id) => {
        const b = await world.blobStore.read(id);
        if (b === null) return null;
        try {
          return JSON.parse(b);
        } catch {
          return null;
        }
      },
      isBound: (id) => isObjectIdBoundTo(id, INT_SCOPE),
    });
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;
    expect(walked.messages.map((m) => m.text)).toEqual([
      'turn-1 user',
      'turn-1 assistant',
      'turn-2 user',
      'turn-2 assistant',
    ]);
  });
});
