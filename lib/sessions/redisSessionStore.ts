/**
 * Phase 1 (#412) — Redis `ServerSessionStore` via `@upstash/redis` REST.
 * Serverless-safe (no persistent sockets). BYO-configured via `SESSION_REDIS_URL`
 * / `SESSION_REDIS_TOKEN` (also honours `UPSTASH_REDIS_REST_URL`/`_TOKEN`).
 *
 * TTL (`SESSION_REDIS_TTL_MS`), default `0` = no expiry, is refreshed on **write only**
 * (`put` sets `EX`); it is NOT advanced by `get`/`list`, so treat it as "TTL-since-last-
 * write", not "idle since last read" (adversarial nit L8).
 *
 * Server-only — never imported from client/Wasm (wired server-side in #414).
 */
import { Redis } from '@upstash/redis';
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
  validateSessionRecord,
} from './sessionStore';

/**
 * The small Redis surface this store depends on, so tests can inject a fake
 * (no real Redis needed). The real `@upstash/redis` `Redis` instance satisfies
 * it structurally.
 */
export interface RedisClientLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
}

export interface RedisSessionStoreOptions {
  /** Inject a fake client (tests). When omitted, build from env (or `url`/`token`). */
  client?: RedisClientLike;
  url?: string;
  token?: string;
  /** TTL in ms refreshed on each write (`put`). 0 (default) = no expiry. Not admin-read-refreshing. */
  ttlMs?: number;
}

function envUrl(opts: RedisSessionStoreOptions): string | undefined {
  return opts.url ?? process.env.SESSION_REDIS_URL ?? process.env.UPSTASH_REDIS_REST_URL;
}

function envToken(opts: RedisSessionStoreOptions): string | undefined {
  return opts.token ?? process.env.SESSION_REDIS_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
}

function envTtlMs(opts: RedisSessionStoreOptions): number {
  if (opts.ttlMs !== undefined) return Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.floor(opts.ttlMs) : 0;
  const raw = process.env.SESSION_REDIS_TTL_MS;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function secondsFromMs(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export class RedisSessionStore implements ServerSessionStore {
  private readonly client: RedisClientLike;
  private readonly ttlMs: number;
  private readonly resolvedUrl: string | undefined;
  private readonly resolvedToken: string | undefined;

  constructor(opts: RedisSessionStoreOptions = {}) {
    this.ttlMs = envTtlMs(opts);
    this.resolvedUrl = envUrl(opts);
    this.resolvedToken = envToken(opts);
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!this.resolvedUrl || !this.resolvedToken) {
        throw new Error(
          'RedisSessionStore requires SESSION_REDIS_URL / SESSION_REDIS_TOKEN ' +
            '(or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN), or an injected client.',
        );
      }
      // Default @upstash REST client: JSON-serialized values on write, JSON-deserialized reads.
      this.client = new Redis({ url: this.resolvedUrl, token: this.resolvedToken });
    }
  }

  /** Resolved URL (for tests / diagnostics). */
  url(): string | undefined {
    return this.resolvedUrl;
  }

  /**
   * Resolved token (for tests / diagnostics only). **Never log or expose this.** Redis
   * access is ops-side; the token only ever lives in Vercel project env / injected client.
   */
  token(): string | undefined {
    return this.resolvedToken;
  }

  async get(key: SessionRecordKey): Promise<HarnessSessionRecord | null> {
    assertValidSessionRecordKey(key);
    const raw = await this.client.get(sessionKeyString(key));
    if (raw == null) return null;
    // Trust-but-verify on read: corrupt/foreign values must not flow as typed records. We
    // also require the blob's OWN identity to match the key it lives under, so a
    // schema-valid but mis-ownered (e.g. hand-edited / bad-migration) blob fails closed
    // instead of being returned to a caller that trusts the record field for authz
    // (adversarial re-run, Minor L2).
    const parsed = validateSessionRecord(raw);
    return parsed.ok && keyMatchesRecord(key, parsed.value) ? parsed.value : null;
  }

  async put(key: SessionRecordKey, record: HarnessSessionRecord): Promise<PutResult> {
    assertValidSessionRecord(record);
    assertValidSessionRecordKey(key);
    assertKeyMatchesRecord(key, record);
    const existing = await this.get(key);
    if (existing && record.updatedAt < existing.updatedAt) {
      return { status: 'conflict', server: existing };
    }
    // Upsert keeps stored `createdAt` (plan #412 lock, enforced at the store — adv. L1/L6).
    const normalized = existing ? { ...record, createdAt: existing.createdAt } : record;
    const k = sessionKeyString(key);
    if (this.ttlMs > 0) {
      await this.client.set(k, normalized, { ex: secondsFromMs(this.ttlMs) });
    } else {
      await this.client.set(k, normalized);
    }
    return { status: 'stored', record: normalized };
  }

  /**
   * Note: implemented as `KEYS {tenant}:{user}:*` + N×`GET` (adversarial minor L5). The
   * parent #411 accepted the prefix scan for P0; a pagination / CURSOR pass is deferred to
   * a later phase. Each key is re-validated on read, and the blob is only included when its
   * own identity re-binds to the key it lives under (corrupt / mis-ownered blobs skipped,
   * adversarial re-run Minor L2).
   */
  async list(scope: SessionListScope): Promise<HarnessSessionRecord[]> {
    assertValidSessionListScope(scope);
    const matches = await this.client.keys(sessionPrefix(scope));
    const records: HarnessSessionRecord[] = [];
    for (const k of matches) {
      const recordKey = parseSessionKeyString(k);
      if (!recordKey) continue;
      const raw = await this.client.get(k);
      if (raw == null) continue;
      const parsed = validateSessionRecord(raw);
      if (parsed.ok && keyMatchesRecord(recordKey, parsed.value)) records.push(parsed.value);
    }
    return records;
  }

  async remove(key: SessionRecordKey): Promise<boolean> {
    assertValidSessionRecordKey(key);
    const k = sessionKeyString(key);
    const existing = await this.client.get(k);
    if (existing == null) return false;
    await this.client.del(k);
    return true;
  }
}
