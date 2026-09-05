/**
 * Phase 1 (#412) — In-memory `ServerSessionStore` test double.
 * Mirrors the Redis implementation's create/upsert + LWW semantics so unit tests
 * never need a real Redis. **Test/scratch only — not persisted, not production.**
 */
import {
  type BackfillMarkerStore,
  type EnvelopeUpsertResult,
  type HarnessSessionRecord,
  type PutResult,
  type ServerSessionStore,
  type SessionEnvelope,
  type SessionEnvelopeInput,
  type SessionListScope,
  type SessionRecordKey,
  assertKeyMatchesRecord,
  assertValidSessionEnvelope,
  assertValidSessionListScope,
  assertValidSessionRecord,
  assertValidSessionRecordKey,
  backfillMarkerKey,
  copyForwardModelMessagesPointer,
  copyForwardFreshnessReminderPointer,
  copyForwardWorkingNotes,
  envelopeFromRecord,
  envelopeKeyString,
  keyMatchesRecord,
  parseEnvelopeKeyString,
  parseSessionKeyString,
  sessionKeyString,
  sessionPrefix,
} from './sessionStore';

export class MemorySessionStore
  implements ServerSessionStore, BackfillMarkerStore
{
  /** Mapped by key string; holds session records plus `{v:1}` backfill markers. */
  private readonly store = new Map<
    string,
    HarnessSessionRecord | { v: number } | SessionEnvelope
  >();

  async get(key: SessionRecordKey): Promise<HarnessSessionRecord | null> {
    assertValidSessionRecordKey(key);
    const r = this.store.get(sessionKeyString(key)) as HarnessSessionRecord | undefined;
    // Mirrors the Redis fail-closed read: only return when the blob's own identity
    // re-binds to the key it lives under (adversarial re-run, Minor L2).
    return r && keyMatchesRecord(key, r) ? structuredClone(r) : null;
  }

  async put(key: SessionRecordKey, record: HarnessSessionRecord): Promise<PutResult> {
    assertValidSessionRecord(record);
    assertValidSessionRecordKey(key);
    assertKeyMatchesRecord(key, record);
    const k = sessionKeyString(key);
    const existing = this.store.get(k) as HarnessSessionRecord | undefined;
    if (existing && record.updatedAt < existing.updatedAt) {
      return { status: 'conflict', server: structuredClone(existing) };
    }
    // Create preserves the supplied record (incl. `updatedAt: 0`); upsert keeps the
    // stored `createdAt` (plan #412 lock) — enforced at the store, not by caller
    // discipline (adversarial review L1/L6).
    const normalized = existing ? { ...record, createdAt: existing.createdAt } : record;
    this.store.set(k, structuredClone(normalized));
    return { status: 'stored', record: structuredClone(normalized) };
  }

  async list(scope: SessionListScope): Promise<HarnessSessionRecord[]> {
    assertValidSessionListScope(scope);
    const base = sessionPrefix(scope).slice(0, -1); // drop trailing '*'
    const records: HarnessSessionRecord[] = [];
    for (const [k, value] of this.store) {
      if (!k.startsWith(base)) continue;
      const recordKey = parseSessionKeyString(k);
      const rec = value as HarnessSessionRecord;
      if (recordKey && keyMatchesRecord(recordKey, rec)) records.push(structuredClone(rec));
    }
    return records;
  }

  async remove(key: SessionRecordKey): Promise<boolean> {
    assertValidSessionRecordKey(key);
    const k = sessionKeyString(key);
    if (!this.store.has(k)) return false;
    this.store.delete(k);
    return true;
  }

  /** Phase 0 (#515): read only the envelope (never a transcript). */
  async readEnvelope(key: SessionRecordKey): Promise<SessionEnvelope | null> {
    assertValidSessionRecordKey(key);
    const k = envelopeKeyString(key);
    const env = this.store.get(k) as SessionEnvelope | undefined;
    if (env) {
      return env.tenantId === key.tenantId &&
        env.userId === key.userId &&
        env.id === key.sessionId
        ? structuredClone(env)
        : null;
    }
    // Roll-forward: an envelope may be derived from a legacy whole-blob record.
    const legacy = this.store.get(sessionKeyString(key)) as HarnessSessionRecord | undefined;
    if (legacy && keyMatchesRecord(key, legacy)) return envelopeFromRecord(legacy);
    return null;
  }

  /** Phase 0 (#515): upsert only the envelope (LWW, `createdAt` preserved). */
  async upsertEnvelope(
    key: SessionRecordKey,
    input: SessionEnvelopeInput,
  ): Promise<EnvelopeUpsertResult> {
    assertValidSessionRecordKey(key);
    if (
      key.tenantId !== input.tenantId ||
      key.userId !== input.userId ||
      key.sessionId !== input.id
    ) {
      throw new Error(
        'Session envelope identity must match the session key (tenantId/userId/id).',
      );
    }
    const existing = await this.readEnvelope(key);
    if (existing && input.updatedAt < existing.updatedAt) {
      return { status: 'conflict', server: structuredClone(existing) };
    }
    const createdAt = existing?.createdAt ?? Date.now();
    const envelope: SessionEnvelope = {
      id: input.id,
      userId: input.userId,
      tenantId: input.tenantId,
      createdAt,
      updatedAt: input.updatedAt,
      // Replace, not merge: absent key = clear (RESERVED_META_KEYS contract).
      // Exception: modelMessagesPointer + freshnessReminderPointer + workingNotes
      // are copy-forwarded from the LWW `existing` when incoming omits them
      // (adversarial-review #937 / #940 / plan #941) so a host flatten cannot
      // delete the worker's latest. Same read as the LWW check. Worker clear of
      // workingNotes is a present `''`.
      meta: copyForwardWorkingNotes(
        copyForwardFreshnessReminderPointer(
          copyForwardModelMessagesPointer(input.meta, existing?.meta),
          existing?.meta,
        ),
        existing?.meta,
      ),
    };
    assertValidSessionEnvelope(envelope);
    this.store.set(envelopeKeyString(key), structuredClone(envelope));
    return { status: 'stored', envelope: structuredClone(envelope) };
  }

  async hasBackfillMarker(scope: SessionListScope): Promise<boolean> {
    assertValidSessionListScope(scope);
    return this.store.has(backfillMarkerKey(scope));
  }

  async setBackfillMarker(scope: SessionListScope): Promise<void> {
    assertValidSessionListScope(scope);
    this.store.set(backfillMarkerKey(scope), { v: 1 });
  }
}
