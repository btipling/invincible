/**
 * Phase 1 (#412) — In-memory `ServerSessionStore` test double.
 * Mirrors the Redis implementation's create/upsert + LWW semantics so unit tests
 * never need a real Redis. **Test/scratch only — not persisted, not production.**
 */
import {
  type HarnessSessionRecord,
  type PutResult,
  type ServerSessionStore,
  type SessionListScope,
  type SessionRecordKey,
  assertKeyMatchesRecord,
  assertValidSessionListScope,
  assertValidSessionRecord,
  assertValidSessionRecordKey,
  keyMatchesRecord,
  parseSessionKeyString,
  sessionKeyString,
  sessionPrefix,
} from './sessionStore';

export class MemorySessionStore implements ServerSessionStore {
  private readonly store = new Map<string, HarnessSessionRecord>();

  async get(key: SessionRecordKey): Promise<HarnessSessionRecord | null> {
    assertValidSessionRecordKey(key);
    const r = this.store.get(sessionKeyString(key));
    // Mirrors the Redis fail-closed read: only return when the blob's own identity
    // re-binds to the key it lives under (adversarial re-run, Minor L2).
    return r && keyMatchesRecord(key, r) ? structuredClone(r) : null;
  }

  async put(key: SessionRecordKey, record: HarnessSessionRecord): Promise<PutResult> {
    assertValidSessionRecord(record);
    assertValidSessionRecordKey(key);
    assertKeyMatchesRecord(key, record);
    const k = sessionKeyString(key);
    const existing = this.store.get(k);
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
    for (const [k, r] of this.store) {
      if (!k.startsWith(base)) continue;
      const recordKey = parseSessionKeyString(k);
      if (recordKey && keyMatchesRecord(recordKey, r)) records.push(structuredClone(r));
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
}
