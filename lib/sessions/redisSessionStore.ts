/**
 * Phase 1 (#412) — Redis `ServerSessionStore` via the node-redis RESP client.
 *
 * Config: a single `REDIS_URL` in `redis://` (or `rediss://` for TLS) wire format,
 * e.g. the Vercel/Upstash Redis integration's `REDIS_URL`
 * `redis://default:<secret>@<host>:<port>`. The URL is resolved **once at the
 * composition root** (`lib/di/index.ts`), which passes it explicitly — this store
 * never reads `process.env` itself. The connection is created lazily and
 * shared per-process (warm instance) so serverless calls reuse one socket instead of
 * leaking a connection per request; node-redis reconnects automatically after a live
 * socket drops (bounded reconnect — see `reconnectStrategy` below).
 *
 * **Fail-closed contract (adversarial L1/L6):** the RESP client is built with the
 * offline command queue disabled and a bounded `connectTimeout` + `reconnectStrategy`.
 * When Redis is unreachable / auth fails, `connect()` rejects instead of hanging, and
 * every command rejects instead of queueing on a not-ready client. The seam
 * (`harnessSessionsRedis.guardStore`) then maps that rejection to
 * `503 SESSION_STORE_UNAVAILABLE`. No 500s and no infinite serverless hangs.
 *
 * **Connect-cache hygiene (adversarial L1/P1):** the per-URL cache stores the
 * *connection promise*, not a bare client, and removes its entry when that promise
 * rejects. A failed `connect()` therefore can never leave a dead client cached as
 * `isOpen === true`; the next request builds a fresh client and retries. Concurrent
 * first-calls for the same URL share one in-flight attempt.
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
import { createClient, type RedisClientType, type RedisClientOptions } from 'redis';
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
  validateSessionEnvelope,
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
  /** Inject a fake client (tests). When omitted, build from `url`. */
  client?: RedisClientLike;
  /**
   * RESP wire-format URL (`redis://` or `rediss://`). Resolved once at the
   * composition root (`lib/di/index.ts` from `REDIS_URL`) and passed explicitly —
   * the store itself never reads `process.env` (adversarial nit L8 follow-up).
   * Required to build the real adapter when no `client` is injected.
   */
  url?: string;
  /** TTL in ms refreshed on each write (`put`). 0 (default) = no expiry. Not admin-read-refreshing. */
  ttlMs?: number;
}

/**
 * Bounded/fail-closed socket policy (adversarial L1/L8). `connectTimeout` caps the TCP
 * handshake; `reconnectStrategy` gives up (rejects `connect()`) instead of retrying
 * forever in a serverless function; `disableOfflineQueue` makes commands reject
 * immediately when the client isn't ready instead of silently queueing (the hang the
 * review called out).
 */
const CONNECT_TIMEOUT_MS = 5000;
const MAX_RECONNECTS = 5;
const RECONNECT_BASE_DELAY_MS = 100;

function socketPolicy(): RedisClientOptions['socket'] {
  return {
    connectTimeout: CONNECT_TIMEOUT_MS,
    reconnectStrategy: (retries: number) => {
      if (retries >= MAX_RECONNECTS) {
        // Returning an Error makes `connect()` reject → the seam maps it to
        // `503 SESSION_STORE_UNAVAILABLE` instead of hanging for `maxDuration`.
        return new Error(`redis: giving up after ${retries} reconnect attempts`);
      }
      return Math.min((retries + 1) * RECONNECT_BASE_DELAY_MS, RECONNECT_BASE_DELAY_MS * 5);
    },
  };
}

function defaultClientFactory(url: string): RedisClientType {
  return createClient({
    url,
    socket: socketPolicy(),
    disableOfflineQueue: true,
  });
}

/** Test seam — override the node-redis client constructor (e.g. a fake that rejects connect). */
type RedisClientFactory = (url: string) => RedisClientType;
let clientFactory: RedisClientFactory = defaultClientFactory;
export function setRedisClientFactoryForTests(factory: RedisClientFactory | null): void {
  clientFactory = factory ?? defaultClientFactory;
}

/**
 * Test seam — clear the module-global connection cache. Must precede setting a new
 * factory in tests so a previously-cached connection can't short-circuit a scenario
 * (e.g. a "failed connect is not retained and retries" assertion).
 */
export function resetRedisClientCacheForTests(): void {
  clientsByUrl.clear();
}

function secondsFromMs(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

const ATTACHED_ERROR_HANDLER = Symbol.for('invincible.redis.errorHandlerAttached');

function buildClient(url: string): RedisClientType {
  const client = clientFactory(url);
  if (!(client as unknown as Record<symbol, boolean>)[ATTACHED_ERROR_HANDLER]) {
    (client as unknown as Record<symbol, boolean>)[ATTACHED_ERROR_HANDLER] = true;
    client.on('error', () => {
      // Swallow background 'error' events (reconnect failures); command promises reject
      // individually and are mapped to 503 at the seam.
    });
  }
  return client;
}

/**
 * Per-process cache of node-redis **connection promises** keyed by URL, so every store
 * instance in a warm serverless function reuses ONE socket rather than opening (and
 * leaking) one per request. Connections are established lazily on first command.
 *
 * Fail-closed hygiene: a rejected promise removes its own cache entry, so a failed
 * `connect()` never leaves a cronically `isOpen === true` dead client behind (one of the
 * review's P1 blockers). Concurrent first-calls for the same URL share one in-flight
 * attempt. The cache is intentionally module-global (not per-store) so multiple
 * RedisSessionStore instances share the socket within a warm isolate.
 */
const clientsByUrl = new Map<string, Promise<RedisClientType>>();

function redisFor(url: string): Promise<RedisClientType> {
  let pending = clientsByUrl.get(url);
  if (pending) return pending;

  const client = buildClient(url);
  pending = (async () => {
    try {
      if (!client.isOpen) {
        await client.connect();
      }
      return client;
    } catch (err) {
      // Never cache a client whose connect() failed. `node-redis` marks `isOpen = true`
      // synchronously on connect, so a plain `isOpen` check can't distinguish a dead
      // client from a healthy one — we must refuse to retain it.
      try {
        void client.disconnect();
      } catch {
        /* ignore */
      }
      throw err;
    }
  })();

  clientsByUrl.set(url, pending);
  // On rejection, drop the cache entry so the next call builds a fresh client + retries.
  void pending.catch(() => {
    if (clientsByUrl.get(url) === pending) clientsByUrl.delete(url);
  });
  return pending;
}

/**
 * Real Redis adapter (node-redis) implementing the JSON `RedisClientLike` seam: strings
 * the value + parses reads, maps `{ex}` → node-redis `{ EX: seconds }`. Uses the shared
 * per-URL connection from `redisFor`. Only constructed when no fake client is injected.
 * All command/connect failures reject → mapped to `503 SESSION_STORE_UNAVAILABLE` by the
 * seam's `guardStore`.
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

export class RedisSessionStore implements ServerSessionStore, BackfillMarkerStore {
  private readonly client: RedisClientLike;
  private readonly ttlMs: number;
  private readonly resolvedUrl: string | undefined;

  constructor(opts: RedisSessionStoreOptions = {}) {
    // `url`/`ttlMs` are resolved at the composition root and passed explicitly — the
    // store no longer reads `process.env` (adversarial nit L8 follow-up). `client` and
    // `url` may both be absent only in the direct/legacy test path (`url()` → undefined);
    // building the real adapter without a URL throws → 503 at the seam.
    this.ttlMs =
      opts.ttlMs !== undefined && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
        ? Math.floor(opts.ttlMs)
        : 0;
    this.resolvedUrl = opts.url?.trim() || undefined;
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!this.resolvedUrl) {
        throw new Error(
          'RedisSessionStore requires url (RESP redis:// or rediss:// wire format), or an injected client. ' +
            'URL is resolved once at the composition root (set REDIS_URL); the store itself never reads process.env.',
        );
      }
      // node-redis RESP client: parses the URL incl. embedded username/password; supports
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

  /**
   * Phase 0 (#515): read only the envelope (`harness:envelope:...`), never the
   * transcript. Trust-but-verify on read, same as `get`: a schema-valid but
   * mis-ownered envelope fails closed (null). When no envelope key exists,
   * roll-forward derives the envelope from a legacy whole-blob record.
   */
  async readEnvelope(key: SessionRecordKey): Promise<SessionEnvelope | null> {
    assertValidSessionRecordKey(key);
    const raw = await this.client.get(envelopeKeyString(key));
    if (raw != null) {
      const parsed = validateSessionEnvelope(raw);
      return parsed.ok &&
        parsed.value.tenantId === key.tenantId &&
        parsed.value.userId === key.userId &&
        parsed.value.id === key.sessionId
        ? parsed.value
        : null;
    }
    const legacy = await this.get(key);
    return legacy ? envelopeFromRecord(legacy) : null;
  }

  /**
   * Phase 0 (#515): upsert only the envelope (LWW on `updatedAt`, `createdAt`
   * preserved, TTL applied on write). Never touches a transcript object.
   */
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
      return { status: 'conflict', server: existing };
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
    const k = envelopeKeyString(key);
    if (this.ttlMs > 0) {
      await this.client.set(k, envelope, { ex: secondsFromMs(this.ttlMs) });
    } else {
      await this.client.set(k, envelope);
    }
    return { status: 'stored', envelope };
  }

  async hasBackfillMarker(scope: SessionListScope): Promise<boolean> {
    assertValidSessionListScope(scope);
    return (await this.client.get(backfillMarkerKey(scope))) != null;
  }

  async setBackfillMarker(scope: SessionListScope): Promise<void> {
    assertValidSessionListScope(scope);
    await this.client.set(backfillMarkerKey(scope), { v: 1 });
  }
}
