import { describe, expect, it } from 'vitest';
import { parseCloudSessionSnapshot } from '../lib/sessionRepository';
import { INT_SCOPE, persistTurn1 } from './stores';

describe('int persist-parse (#859 row 1 pointer clobber)', () => {
  it.fails('#859 row 1: worker persist blob parses as SessionSnapshot', async () => {
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
});
