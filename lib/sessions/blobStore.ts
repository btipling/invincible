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
import { createHash } from 'node:crypto';
import { isRedisSafeOpaqueId } from '../sessionCloudCaps';

/**
 * A content-addressed, append-only transcript object identifier. Stored as
 * `meta.transcriptPointer` on the envelope (`^[A-Za-z0-9_-]{1,512}$`).
 */
export type TranscriptObjectId = string;

/**
 * The ownership scope a transcript object is bound to. Every minted object id
 * carries the session's scope as a derivable prefix; the server re-derives it
 * from the session it is authorizing and rejects any pointer/object whose binding
 * does not match THIS session (reader's Major L2 IDOR via planted pointer).
 */
export type ObjectScope = { tenantId: string; userId: string; sessionId: string };

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
 * The **binding prefix** of a session-scoped transcript object id: a short content
 * digest of the ownership scope (`{tenantId,userId,sessionId}`) formatted as `t_…`.
 * The server re-derives this from the session it is authorizing and requires a
 * pointer/object to carry the matching prefix — a transcript object minted for one
 * session can never be planted onto another session's envelope or signed for a
 * foreign session. No secret involved: the digest is derived from ids the server
 * already knows; the *authorization* is that the server only accepts a pointer whose
 * binding matches THIS session, so guessability of the prefix is not a vulnerability
 * (a foreign digest simply never matches the session being authorized).
 */
export function objectBindingFor(scope: ObjectScope): string {
  // `|` cannot appear in Redis-safe opaque ids (`[A-Za-z0-9_-]`), so the digest is
  // collision-free across scope component boundaries.
  const digest = createHash('sha256')
    .update(`${scope.tenantId}|${scope.userId}|${scope.sessionId}`)
    .digest('hex')
    .slice(0, 12); // 48 bits; distinct per session scope (ids are Redis-safe)
  return `t_${digest}`;
}

/** Does this object id carry the binding prefix of the given session scope? */
export function isObjectIdBoundTo(objectId: string, scope: ObjectScope): boolean {
  // Redis-safe charset implied by `isTranscriptObjectId` before the prefix compare,
  // so a /glob/`:`-backed id can never alias the binding.
  return (
    isTranscriptObjectId(objectId) && objectId.startsWith(`${objectBindingFor(scope)}_`)
  );
}

/**
 * Generate a compact, **Redis-safe opaque**, session-bound transcript object id.
 *
 * This is the single source of the envelope pointer AND the Blob pathname — they
 * must be the same string so `meta.transcriptPointer` (which rides in the Redis
 * envelope and must be `^[A-Za-z0-9_-]{1,512}$`) always equals the object the
 * server signs reads for. The charset is `[A-Za-z0-9_]` (no `/`, no glob chars),
 * so it is safe as a Redis `meta` value AND as a Blob pathname (Blob pathnames do
 * not need to be hierarchical). Length is bounded well under 128.
 *
 * The id is **bound to its owning session**: it always opens with
 * `objectBindingFor(scope)` so the server can re-derive and verify that a
 * transcript object belongs to THIS session at envelope-write and read time
 * (reader's Major L2). The trailing random suffix keeps each mint distinct (a new
 * object per upload; the envelope pointer LWW-advances to the latest bound id).
 * The Blob namespace is intentionally **flat** (`t_…` pathname) — the security
 * property is the derivable binding prefix + server-side verification, not a
 * hierarchical `harness/{tenant}/{user}/{session}` prefix (reader's Nit L8).
 */
export function newBlobObjectId(scope: ObjectScope): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${objectBindingFor(scope)}_${rand}`;
}

/**
 * Provider-neutral transcript object store. Production default is Vercel Blob;
 * BYO S3/R2 buckets implement the same seam (config swap, no single-owner bind).
 */
export interface BlobTranscriptStore {
  readonly kind: 'vercel' | 'byo' | 'memory';
  /**
   * Mint a short-lived, scoped, credential-checked upload URL for a new append-only
   * transcript segment bound to the given ownership scope (the object id derives
   * its binding prefix from `scope`, so the server can re-derive and verify it).
   * Server holds the credential; the client never sees it.
   *
   * `scope` is REQUIRED and never defaulted: the object's binding prefix is derived
   * from it, so a caller that omits it would mint an unbound/shared-binding object
   * that can never be authorized for any session. Implementations THROW if `scope`
   * is omitted (reader's Nit — no invented shared dummy binding).
   */
  mintUpload(options: { scope: ObjectScope; contentType?: string }): Promise<MintedUpload>;
  /** Server-side read of an object (diagnostics / segment-aware fetch). */
  read(objectId: TranscriptObjectId): Promise<string | null>;
  /** Server-side preview URL for an object (signed). Optional. */
  readUrl(objectId: TranscriptObjectId): Promise<string | null>;
}

/** Redis-safe object-id charset re-exported. */
export { isRedisSafeOpaqueId } from '../sessionCloudCaps';
