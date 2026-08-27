import type { HarnessBridge } from '../lib/harnessBridge';
import { pushSessionToBridge } from '../lib/harnessChat';
import {
  bootCloudSnapshot,
  cloudGetFromBoot,
  getEnvelopeParseLocal,
  type CloudGetResult,
} from '../lib/sessionRepository';
import type { SessionSnapshot } from '../lib/sessionStore';
import type { MemoryBlobTranscriptStore } from '../lib/sessions/blobStores';
import type { MemorySessionStore } from '../lib/sessions/memorySessionStore';
import type { SessionRecordKey } from '../lib/sessions/sessionStore';
import { INT_SCOPE } from './stores';

export async function bootFromMemory(opts: {
  local: SessionSnapshot;
  envelopeStore: MemorySessionStore;
  blobStore: MemoryBlobTranscriptStore;
  key?: SessionRecordKey;
}): Promise<CloudGetResult> {
  const key = opts.key ?? {
    tenantId: INT_SCOPE.tenantId,
    userId: INT_SCOPE.userId,
    sessionId: INT_SCOPE.sessionId,
  };
  const env = await opts.envelopeStore.readEnvelope(key);
  const pointer =
    env?.meta && typeof env.meta.transcriptPointer === 'string'
      ? env.meta.transcriptPointer
      : undefined;
  let blobJson: unknown = null;
  if (pointer) {
    const raw = await opts.blobStore.read(pointer);
    if (raw) {
      try {
        blobJson = JSON.parse(raw);
      } catch {
        blobJson = null;
      }
    }
  }
  return cloudGetFromBoot(
    bootCloudSnapshot({
      id: opts.local.id,
      local: getEnvelopeParseLocal(opts.local.id),
      envelopeMeta: env?.meta,
      blobJson,
    }),
  );
}

export function hydrateRing(bridge: HarnessBridge, snapshot: SessionSnapshot): void {
  pushSessionToBridge(bridge, snapshot);
}

export function ringTexts(bridge: HarnessBridge): string[] {
  const out: string[] = [];
  const n = bridge.messageCount();
  for (let i = 0; i < n; i++) {
    out.push(bridge.messageTextAt(i));
  }
  return out;
}
