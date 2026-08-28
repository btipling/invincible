import { createTurnPersistSeam } from '../lib/agent/turnPersistSeam';
import { MemoryBlobTranscriptStore } from '../lib/sessions/blobStores';
import { MemorySessionStore } from '../lib/sessions/memorySessionStore';
import type { ObjectScope } from '../lib/sessions/blobStore';
import type { SessionRecordKey } from '../lib/sessions/sessionStore';
import type { PersistStepSeam } from '../lib/workflows/persistStep';
import { persistStep, setPersistSeamResolver } from '../lib/workflows/persistStep';

export const INT_SCOPE: ObjectScope = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  sessionId: 'session-1',
};
export const INT_KEY: SessionRecordKey = INT_SCOPE;
export const TURN1_RUN_ID = 'wr_0000_1f2e3d4c5b6a';
export const TURN2_RUN_ID = 'wr_0000_2a3b4c5d6e7f';

export async function makePersistWorld(): Promise<{
  blobStore: MemoryBlobTranscriptStore;
  envelopeStore: MemorySessionStore;
  seam: PersistStepSeam;
}> {
  const blobStore = new MemoryBlobTranscriptStore();
  const envelopeStore = new MemorySessionStore();
  const seam = createTurnPersistSeam({ blobStore, envelopeStore, scope: INT_SCOPE });
  setPersistSeamResolver(() => seam);
  return { blobStore, envelopeStore, seam };
}

/** Terminal worker persist (B13) — writes a SessionSnapshot onto transcriptPointer. */
export async function persistTurn1(opts?: {
  deltas?: ReadonlyArray<unknown>;
  userLine?: string;
  assistantLine?: string;
}): Promise<{
  blobStore: MemoryBlobTranscriptStore;
  envelopeStore: MemorySessionStore;
  objectId?: string;
}> {
  const world = await makePersistWorld();
  const userLine = opts?.userLine ?? 'turn-1 user';
  const assistantLine = opts?.assistantLine ?? 'turn-1 assistant';
  const result = await persistStep({
    turnRunId: TURN1_RUN_ID,
    deltas: opts?.deltas ?? [{ type: 'text_delta', text: assistantLine }],
    fold: {
      checkpoint: [
        { role: 'user', content: userLine },
        { role: 'assistant', content: assistantLine },
      ],
    },
    scope: INT_SCOPE,
  });
  if (!result.ok) {
    throw new Error(`persistTurn1 failed: ${result.code} ${result.error}`);
  }
  return {
    blobStore: world.blobStore,
    envelopeStore: world.envelopeStore,
    objectId: result.objectId,
  };
}

/** Host-shaped turn-2 start: envelope `running` + new run id, pointer unchanged. */
export async function markEnvelopeRunning(
  envelopeStore: MemorySessionStore,
  turnRunId: string = TURN2_RUN_ID,
): Promise<void> {
  const env = await envelopeStore.readEnvelope(INT_KEY);
  const updatedAt = (env?.updatedAt ?? 0) + 1;
  const res = await envelopeStore.upsertEnvelope(INT_KEY, {
    id: INT_SCOPE.sessionId,
    userId: INT_SCOPE.userId,
    tenantId: INT_SCOPE.tenantId,
    updatedAt,
    meta: {
      ...(env?.meta ?? {}),
      turnStatus: 'running',
      turnRunId,
    },
  });
  if (res.status !== 'stored') {
    throw new Error('markEnvelopeRunning LWW conflict');
  }
}
