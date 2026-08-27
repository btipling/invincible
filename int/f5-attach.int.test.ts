import { beforeAll, describe, expect, it } from 'vitest';
import { decideHotResume, decideSendAttach, coldAttachFromSnapshot } from '../lib/turnAttach';
import { decideDetach, shouldSetHostTurnNote } from '../lib/detachTurn';
import { snapshotAfterCloudGet } from '../lib/sessionBoot';
import { makeMessage, type SessionSnapshot } from '../lib/sessionStore';
import type { HarnessBridge } from '../lib/harnessBridge';
import { loadBridge } from './loadBridge';
import { bootFromMemory, hydrateRing, ringTexts } from './driver';
import { persistTurn1, markEnvelopeRunning, TURN2_RUN_ID, INT_SCOPE } from './stores';

const TURN2_USER = 'turn-2 user';
const LIVE_ASSISTANT = 'partial live assistant';

function turn1Local(): SessionSnapshot {
  return {
    id: INT_SCOPE.sessionId,
    updatedAt: 1,
    messages: [
      makeMessage('user', 'turn-1 user'),
      makeMessage('assistant', 'turn-1 assistant'),
    ],
    turnStatus: 'completed',
  };
}

/** Host restore: CloudGetResult (cloudGetFromBoot); error has no snapshot; LWW on ok. */
function restoredAfterBoot(
  local: SessionSnapshot,
  boot: Awaited<ReturnType<typeof bootFromMemory>>,
): SessionSnapshot {
  return snapshotAfterCloudGet(local, boot);
}

describe('int F5 attach (#859 issue-rows 3 F5, 4 stream-drop, 2 persist-hole)', () => {
  let bridge: HarnessBridge;

  beforeAll(async () => {
    bridge = await loadBridge();
  });

  it.fails(
    '#859 row 3: stale local completed + envelope running → cold attach, not none',
    async () => {
      const local = turn1Local();
      const { blobStore, envelopeStore } = await persistTurn1();
      await markEnvelopeRunning(envelopeStore);
      const boot = await bootFromMemory({
        local,
        envelopeStore,
        blobStore,
      });
      const spec = coldAttachFromSnapshot(restoredAfterBoot(local, boot));
      expect(spec).not.toBeNull();
      expect(spec).toEqual({
        runId: TURN2_RUN_ID,
        startIndex: 0,
        dedup: true,
      });
    },
  );

  it.fails('#859 row 2: F5 ring is not turn-1-only (worker transcript, not attach)', async () => {
    const local = turn1Local();
    const { blobStore, envelopeStore } = await persistTurn1();
    await markEnvelopeRunning(envelopeStore);
    const boot = await bootFromMemory({
      local,
      envelopeStore,
      blobStore,
    });
    hydrateRing(bridge, restoredAfterBoot(local, boot));
    expect(ringTexts(bridge).some((t) => t.includes(TURN2_USER))).toBe(true);
  });

  it.fails(
    '#859 C15: Send while envelope live + local completed remaps to GET-attach',
    async () => {
      const local = turn1Local();
      const { blobStore, envelopeStore } = await persistTurn1();
      await markEnvelopeRunning(envelopeStore);
      const boot = await bootFromMemory({
        local,
        envelopeStore,
        blobStore,
      });
      const restored = restoredAfterBoot(local, boot);
      const send = decideSendAttach({
        turnRunId: restored.turnRunId,
        turnStatus: restored.turnStatus,
        envelopeCursor: restored.turnStreamCursor,
        heapApplied: null,
      });
      expect(send.kind).not.toBe('none');
      if (send.kind === 'none') return;
      expect(send.runId).toBe(TURN2_RUN_ID);
      expect(send.startIndex).toBe(0);
    },
  );

  it('row 4 (green): stream-drop fixture stays envelope running; F5 is detach not cancel', async () => {
    const { envelopeStore } = await persistTurn1();
    const afterPersist = await envelopeStore.readEnvelope({
      tenantId: INT_SCOPE.tenantId,
      userId: INT_SCOPE.userId,
      sessionId: INT_SCOPE.sessionId,
    });
    expect(afterPersist?.meta?.turnStatus).toBe('completed');
    await markEnvelopeRunning(envelopeStore);
    const env = await envelopeStore.readEnvelope({
      tenantId: INT_SCOPE.tenantId,
      userId: INT_SCOPE.userId,
      sessionId: INT_SCOPE.sessionId,
    });
    expect(env?.meta?.turnStatus).toBe('running');
    expect(env?.meta?.turnRunId).toBe(TURN2_RUN_ID);
    expect(
      decideDetach({
        cancel: false,
        inflight: false,
        turnRunId: TURN2_RUN_ID,
        turnStatus: 'running',
      }),
    ).toBe('detach');
    expect(shouldSetHostTurnNote('running')).toBe(false);
  });

  it.fails('#859 row 4: stream-drop + F5 still cold-attaches; empty-EOF does not spin', async () => {
    const local = turn1Local();
    const { blobStore, envelopeStore } = await persistTurn1();
    await markEnvelopeRunning(envelopeStore);
    const boot = await bootFromMemory({
      local,
      envelopeStore,
      blobStore,
    });
    const restored = restoredAfterBoot(local, boot);
    expect(coldAttachFromSnapshot(restored)).not.toBeNull();
    const hot = decideHotResume({
      turnRunId: restored.turnRunId,
      turnStatus: restored.turnStatus,
      heapApplied: null,
      attachStart: 0,
    });
    expect(hot.kind).toBe('none');
  });

  it.fails(
    '#859 row 2: mid-turn persist hole — boot ring is not live interleaving',
    async () => {
      const local = turn1Local();
      const { blobStore, envelopeStore } = await persistTurn1();
      await markEnvelopeRunning(envelopeStore);
      const boot = await bootFromMemory({
        local,
        envelopeStore,
        blobStore,
      });
      hydrateRing(bridge, restoredAfterBoot(local, boot));
      const texts = ringTexts(bridge);
      expect(texts.some((t) => t.includes(TURN2_USER))).toBe(true);
      expect(texts.some((t) => t.includes(LIVE_ASSISTANT))).toBe(true);
    },
  );
});
