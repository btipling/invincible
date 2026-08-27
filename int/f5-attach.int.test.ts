import { beforeAll, describe, expect, it } from 'vitest';
import { decideHotResume, decideSendAttach, coldAttachFromSnapshot } from '../lib/turnAttach';
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

describe('int F5 attach (#859 rows 2, 3, 5, 6)', () => {
  let bridge: HarnessBridge;

  beforeAll(async () => {
    bridge = await loadBridge();
  });

  it.fails(
    '#859 row 2: stale local completed + envelope running → cold attach, not none',
    async () => {
      const { blobStore, envelopeStore } = await persistTurn1();
      await markEnvelopeRunning(envelopeStore);
      const boot = await bootFromMemory({
        local: turn1Local(),
        envelopeStore,
        blobStore,
      });
      const spec = coldAttachFromSnapshot(boot.snapshot);
      expect(spec).not.toBeNull();
      expect(spec).toEqual({
        runId: TURN2_RUN_ID,
        startIndex: 0,
        dedup: true,
      });
    },
  );

  it.fails('#859 row 2: heap-B ring is not stuck on turn-1-only', async () => {
    const { blobStore, envelopeStore } = await persistTurn1();
    await markEnvelopeRunning(envelopeStore);
    const boot = await bootFromMemory({
      local: turn1Local(),
      envelopeStore,
      blobStore,
    });
    hydrateRing(bridge, boot.snapshot);
    expect(ringTexts(bridge).some((t) => t.includes(TURN2_USER))).toBe(true);
  });

  it.fails(
    '#859 row 3: Send while envelope live + local completed remaps to GET-attach',
    async () => {
      const { blobStore, envelopeStore } = await persistTurn1();
      await markEnvelopeRunning(envelopeStore);
      const boot = await bootFromMemory({
        local: turn1Local(),
        envelopeStore,
        blobStore,
      });
      const send = decideSendAttach({
        turnRunId: boot.snapshot.turnRunId,
        turnStatus: boot.snapshot.turnStatus,
        envelopeCursor: boot.snapshot.turnStreamCursor,
        heapApplied: null,
      });
      expect(send.kind).not.toBe('none');
      if (send.kind === 'none') return;
      expect(send.runId).toBe(TURN2_RUN_ID);
      expect(send.startIndex).toBe(0);
    },
  );

  it('row 5 (green): mid-turn abort does not flip envelope to completed', async () => {
    const { envelopeStore } = await persistTurn1();
    await markEnvelopeRunning(envelopeStore);
    const env = await envelopeStore.readEnvelope({
      tenantId: INT_SCOPE.tenantId,
      userId: INT_SCOPE.userId,
      sessionId: INT_SCOPE.sessionId,
    });
    expect(env?.meta?.turnStatus).toBe('running');
    expect(env?.meta?.turnRunId).toBe(TURN2_RUN_ID);
  });

  it.fails('#859 row 5: stream-drop + F5 still cold-attaches; empty-EOF does not spin', async () => {
    const { blobStore, envelopeStore } = await persistTurn1();
    await markEnvelopeRunning(envelopeStore);
    const boot = await bootFromMemory({
      local: turn1Local(),
      envelopeStore,
      blobStore,
    });
    expect(coldAttachFromSnapshot(boot.snapshot)).not.toBeNull();
    const hot = decideHotResume({
      turnRunId: boot.snapshot.turnRunId,
      turnStatus: boot.snapshot.turnStatus,
      heapApplied: null,
      attachStart: 0,
    });
    expect(hot.kind).toBe('none');
  });

  it.fails(
    '#859 row 6: mid-turn persist hole — boot ring is not live interleaving',
    async () => {
      const { blobStore, envelopeStore } = await persistTurn1();
      await markEnvelopeRunning(envelopeStore);
      const boot = await bootFromMemory({
        local: turn1Local(),
        envelopeStore,
        blobStore,
      });
      hydrateRing(bridge, boot.snapshot);
      const texts = ringTexts(bridge);
      expect(texts.some((t) => t.includes(TURN2_USER))).toBe(true);
      expect(texts.some((t) => t.includes(LIVE_ASSISTANT))).toBe(true);
    },
  );
});
