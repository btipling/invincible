/**
 * Phase 1 (#412) — Redis `ServerSessionStore` via `@upstash/redis` REST.
 * Serverless-safe (no persistent sockets). BYO-configured via `SESSION_REDIS_URL`
 * / `SESSION_REDIS_TOKEN` (also honours `UPSTASH_REDIS_REST_URL`/`_TOKEN`).
 * Idle TTL optional (`SESSION_REDIS_TTL_MS`), default `0` = no expiry.
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
  assertValidSessionRecord,
  sessionKeyString,
  sessionPrefix,
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
  /** Idle TTL in ms. 0 (default) = no expiry. */
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

  /** Resolved token (never logged; for tests / diagnostics only). */
  token(): string | undefined {
    return this.resolvedToken;
  }

  async get(key: SessionRecordKey): Promise<HarnessSessionRecord | null> {
    const raw = await this.client.get(sessionKeyString(key));
    return raw == null ? null : (raw as HarnessSessionRecord);
  }

  async put(key: SessionRecordKey, record: HarnessSessionRecord): Promise<PutResult> {
    assertValidSessionRecord(record);
    const existing = await this.get(key);
    if (existing && record.updatedAt < existing.updatedAt) {
      return { status: 'conflict', server: existing };
    }
    const k = sessionKeyString(key);
    if (this.ttlMs > 0) {
      await this.client.set(k, record, { ex: secondsFromMs(this.ttlMs) });
    } else {
      await this.client.set(k, record);
    }
    return { status: 'stored', record };
  }

  async list(scope: SessionListScope): Promise<HarnessSessionRecord[]> {
    const matches = await this.client.keys(sessionPrefix(scope));
    const records: HarnessSessionRecord[] = [];
    for (const k of matches) {
      const raw = await this.client.get(k);
      if (raw == null) continue;
      records.push(raw as HarnessSessionRecord);
    }
    return records;
  }

  async remove(key: SessionRecordKey): Promise<boolean> {
    const k = sessionKeyString(key);
    const existing = await this.client.get(k);
    if (existing == null) return false;
    await this.client.del(k);
    return true;
  }
}
