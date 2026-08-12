/**
 * Phase 1 (#412) — Redis `ServerSessionStore` via the node-redis RESP client.
 *
 * Config: a single `REDIS_URL` in `redis://` (or `rediss://` for TLS) wire format,
 * e.g. the Vercel/Upstash Redis integration's `REDIS_URL`
 * `redis://default:<secret>@<host>:<port>`. The connection is created lazily and
 * shared per-process (warm instance) so serverless calls reuse one socket instead of
 * leaking a connection per request; node-redis reconnects automatically if a frozen
 * instance's socket dies.
 *
 * TTL (`SESSION_REDIS_TTL_MS`), default `0` = no expiry, is refreshed on **write only**
 * (`put` sets `EX`); it is NOT advanced by `get`/`list`, so treat it as "TTL-since-last-
 * write", not "idle since last read" (adversarial nit L8).
 *
 * Server-only — never imported from client/Wasm (wired server-side in #414).
 *
 * This replaces the earlier `@upstash/redis` REST client: that client speaks HTTPS REST
 * and needs a separate pair of `{url, token}` env vars, which cannot drive RESP-style
 * `REDIS_URL` credentials. The store still keeps a protocol-agnostic `RedisClientLike`
 * seam so unit tests inject a fake and never need a real Redis.
 */
import { createClient, type RedisClientType } from 'redis';
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
 * (no real Redis needed). The interface carries **JSON** values in/out (the store
 * never deals with raw wire bytes): the injected fake and the real node-redis
 * adapter both present/store objects, never strings.
 */
export interface RedisClientLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
}

export interface RedisSessionStoreOptions {
  /** Inject a fake client (tests). When omitted, build from `REDIS_URL` (or `url`). */
  client?: RedisClientLike;
  /** Explicit URL override (defaults to `process.env.REDIS_URL`). RESP wire format. */
  url?: string;
  /** TTL in ms refreshed on each write (`put`). 0 (default) = no expiry. Not admin-read-refreshing. */
  ttlMs?: number;
}

function envUrl(opts: RedisSessionStoreOptions): string | undefined {
  return opts.url ?? process.env.REDIS_URL;
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

/**
 * Per-process cache of node-redis clients keyed by URL, so every store instance in a
 * warm serverless function reuses ONE socket rather than opening (and leaking) one per
 * request. Connections are established lazily on first command; node-redis auto-reconnects.
 * An `error` listener is attached (once) so background reconnect failures never hit the
 * unhandled-'error' guard — command failures still reject their own promise, which the
 * seam turns into `503 SESSION_STORE_UNAVAILABLE`.
 */
const clientsByUrl = new Map<string, RedisClientType>();
const ATTACHED_ERROR_HANDLER = Symbol.for('invincible.redis.errorHandlerAttached');

async function redisFor(url: string): Promise<RedisClientType> {
  let client = clientsByUrl.get(url);
  if (!client) {
    client = createClient({ url });
    if (!(client as unknown as Record<symbol, boolean>)[ATTACHED_ERROR_HANDLER]) {
      (client as unknown as Record<symbol, boolean>)[ATTACHED_ERROR_HANDLER] = true;
      client.on('error', () => {
        // Swallow; command promises reject individually (→ 503), and reconnect is automatic.
      });
    }
    clientsByUrl.set(url, client);
  }
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}

/**
 * Real Redis adapter (node-redis) implementing the JSON `RedisClientLike` seam: strings
 * the value + parses reads, maps `{ex}` → node-redis `{ EX: seconds }`. Uses the shared
 * per-URL connection from `redisFor`. Only constructed when no fake client is injected.
 */
class NodeRedisAdapter implements RedisClientLike {
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async get(key: string): Promise<unknown> {
    const raw = await (await redisFor(this.url)).get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw as string) as unknown;
    } catch {
      // Corrupt / non-JSON blob → fail closed (null) like the store's trust-but-verify read.
      return null;
    }
  }

  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown> {
    const payload = JSON.stringify(value);
    const client = await redisFor(this.url);
    return opts && typeof opts.ex === 'number'
      ? client.set(key, payload, { EX: opts.ex })
      : client.set(key, payload);
  }

  async del(...keys: string[]): Promise<unknown> {
    return (await redisFor(this.url)).del(keys);
  }

  async keys(pattern: string): Promise<string[]> {
    return (await redisFor(this.url)).keys(pattern);
  }
}

export class RedisSessionStore implements ServerSessionStore {
  private readonly client: RedisClientLike;
  private readonly ttlMs: number;
  private readonly resolvedUrl: string | undefined;

  constructor(opts: RedisSessionStoreOptions = {}) {
    this.ttlMs = envTtlMs(opts);
    this.resolvedUrl = envUrl(opts);
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!this.resolvedUrl) {
        throw new Error(
          'RedisSessionStore requires REDIS_URL (redis:// or rediss://), or an injected client.',
        );
      }
      // node-redis RESP client: parses REDIS_URL incl. embedded username/password; supports
      // redis:// (insecure) and rediss:// (TLS). A missing/wrong URL throws → 503 at the seam.
      this.client = new NodeRedisAdapter(this.resolvedUrl);
    }
  }

  /** Resolved URL (for tests / diagnostics). NB: contains the embedded credential — never log. */
  url(): string | undefined {
    return this.resolvedUrl;
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
