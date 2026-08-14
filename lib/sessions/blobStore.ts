/**
 * Phase 0 (#515) — transcript object store seam (Vercel Blob default; BYO S3/R2
 * behind the same interface). Server-only.
 *
 * This is the **fat-surface carrier**: the transcript — the only large part of a
 * session — lives in append-only **objects** in Vercel Blob (S3-backed), never in
 * Redis and never through a Function payload. The server holds the credential
 * (`BLOB_READ_WRITE_TOKEN`, or BYO bucket creds) and mints a **short-lived, scoped,
 * credential-checked upload URL** so the client uploads new segment objects
 * **directly to Blob** — no fat body through a Function. Reads page from object
 * URLs; the Redis envelope stays tiny.
 *
 * **Server-only.** Never imported from client/Wasm. The client uploads to Blob
 * using the minted URL; it never holds the credential.
 */
import { isRedisSafeOpaqueId } from '../sessionCloudCaps';

/**
 * A content-addressed, append-only transcript object identifier. Stored as
 * `meta.transcriptPointer` on the envelope (`^[A-Za-z0-9_-]{1,128}$`).
 */
export type TranscriptObjectId = string;

/** Mint result for a client→Blob upload. The URL is short-lived + scoped. */
export type MintedUpload = {
  /** Server-minted, short-lived, scoped upload URL the client PUTs the segment to. */
  uploadUrl: string;
  /** Object key/id the client must echo back so the envelope pointer advances. */
  objectId: TranscriptObjectId;
  /** Preview (GET) URL for server-side reads / diagnostics. Optional. */
  readUrl?: string;
};

export function isTranscriptObjectId(s: unknown): s is TranscriptObjectId {
  return typeof s === 'string' && isRedisSafeOpaqueId(s);
}

/**
 * Provider-neutral transcript object store. Production default is Vercel Blob;
 * BYO S3/R2 buckets implement the same seam (config swap, no single-owner bind).
 */
export interface BlobTranscriptStore {
  readonly kind: 'vercel' | 'byo' | 'memory';
  /**
   * Mint a short-lived, scoped, credential-checked upload URL for a new append-only
   * transcript segment. Server holds the credential; the client never sees it.
   */
  mintUpload(options?: {
    keyPrefix?: string;
    contentType?: string;
  }): Promise<MintedUpload>;
  /** Server-side read of an object (diagnostics / segment-aware fetch). */
  read(objectId: TranscriptObjectId): Promise<string | null>;
  /** Server-side preview URL for an object (signed). Optional. */
  readUrl(objectId: TranscriptObjectId): Promise<string | null>;
}

/** Redis-safe object-id charset re-exported. */
export { isRedisSafeOpaqueId } from '../sessionCloudCaps';
