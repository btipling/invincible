/**
 * Phase 0 (#515) — concrete transcript object stores behind the `BlobTranscriptStore`
 * seam (`lib/sessions/blobStore.ts`).
 *
 * - `MemoryBlobTranscriptStore` — in-memory double for tests + unconfigured/dev
 *   fallback. NOT production data (not durable, not shared).
 * - `VercelBlobTranscriptStore` — production default (Vercel Blob, S3-backed). Uses
 *   `issueSignedToken` + `presignUrl` to mint a **short-lived, scoped, credential-checked**
 *   object host upload (PUT) URL the client uploads **directly to Blob** — no fat body
 *   through a Function. Server holds `BLOB_READ_WRITE_TOKEN`; the client never sees it.
 *
 * Server-only. DI root resolves the configured store (see `lib/di/index.ts`).
 */
import {
  issueSignedToken,
  presignUrl,
} from '@vercel/blob';
import type {
  BlobTranscriptStore,
  MintedUpload,
  ObjectScope,
  TranscriptObjectId,
} from './blobStore';
import { isTranscriptObjectId, newBlobObjectId } from './blobStore';

/** In-memory double: same seam, no real object store. Tests + dev fallback only. */
export class MemoryBlobTranscriptStore implements BlobTranscriptStore {
  readonly kind = 'memory' as const;
  private readonly objects = new Map<string, string>();

  async mintUpload(options: {
    scope: ObjectScope;
    contentType?: string;
    maxBytes: number;
  }): Promise<MintedUpload> {
    // `scope` is REQUIRED — never defaulted to a shared dummy binding (a caller that
    // omits it would mint an object whose binding can't authorize for any session).
    if (!options?.scope) {
      throw new TypeError('mintUpload requires an ownership scope {tenantId,userId,sessionId}');
    }
    // `maxBytes` is REQUIRED — never defaulted (a caller that omits it would mint an
    // object with no byte ceiling, reintroducing the client-honor residual this seam
    // exists to retire).
    if (
      !Number.isInteger(options.maxBytes) ||
      !Number.isFinite(options.maxBytes) ||
      options.maxBytes < 1
    ) {
      throw new TypeError('mintUpload requires a positive integer maxBytes ceiling');
    }
    // Same compact Redis-safe, session-bound id shape as the Vercel store, so a
    // test-injected memory double never mints an id that would fail
    // `isTranscriptObjectId` / `isObjectIdBoundTo`.
    const id = newBlobObjectId(options.scope);
    const readUrl = `memory://transcript/${id}`;
    // Keep a placeholder body so a server-side readUrl resolves to empty until uploaded.
    this.objects.set(id, JSON.stringify({ empty: true }));
    return {
      uploadUrl: `memory://upload/${id}`,
      objectId: id,
      readUrl,
    };
  }

  async read(objectId: TranscriptObjectId): Promise<string | null> {
    return this.objects.get(objectId) ?? null;
  }

  async readUrl(objectId: TranscriptObjectId): Promise<string | null> {
    if (!isTranscriptObjectId(objectId)) return null;
    return this.objects.has(objectId) ? `memory://transcript/${objectId}` : null;
  }
}

/**
 * Production default — Vercel Blob. Mints a short-lived, scoped, credential-checked
 * **object-host PUT** URL via `issueSignedToken` (operations `['put']`, scoped pathname,
 * one-hour expiry) + `presignUrl`, so the client uploads the segment directly to Blob
 * (the object host), never through a Function. Reads page from a signed GET URL.
 *
 * The credential (`BLOB_READ_WRITE_TOKEN`) is resolved **once at the DI root** and passed
 * in — this store never reads `process.env`.
 */
export class VercelBlobTranscriptStore implements BlobTranscriptStore {
  readonly kind = 'vercel' as const;

  constructor(private readonly opts: { token: string }) {}

  async mintUpload(options: {
    scope: ObjectScope;
    contentType?: string;
    maxBytes: number;
  }): Promise<MintedUpload> {
    // `scope` is REQUIRED — never defaulted to a shared dummy binding (a caller that
    // omits it would mint an object whose binding can't authorize for any session).
    if (!options?.scope) {
      throw new TypeError('mintUpload requires an ownership scope {tenantId,userId,sessionId}');
    }
    // `maxBytes` is REQUIRED — never defaulted (a caller that omits it would mint an
    // object with no byte ceiling, reintroducing the client-honor residual this seam
    // exists to retire). Encoded into BOTH the delegation token (`issueSignedToken`)
    // and the presigned URL (`presignUrl`), so the Blob object host enforces the
    // ceiling server-side (`file_too_large`) — never dependent on a client trim.
    if (
      !Number.isInteger(options.maxBytes) ||
      !Number.isFinite(options.maxBytes) ||
      options.maxBytes < 1
    ) {
      throw new TypeError('mintUpload requires a positive integer maxBytes ceiling');
    }
    // The object id IS the Blob pathname AND the Redis envelope pointer (see
    // `newBlobObjectId`): a compact, unguessable, **session-bound**, Redis-safe
    // opaque string, never a slashy hierarchical path — so the stored
    // `meta.transcriptPointer` always equals the object the server signs reads
    // for and `presignUrl`'s pathname match holds. (A slashy
    // `harness/{tenant}/{user}/{session}/{ts}_{uuid}` pathname would fail
    // `isTranscriptObjectId` and 400 every envelope upsert / read — reader's
    // Blocker.) The binding prefix derived from `options.scope` lets the server
    // re-verify at envelope-write/read time that the pointer belongs to THIS
    // session (reader's Major L2).
    const objectId = newBlobObjectId(options.scope);
    const validUntil = Date.now() + 60 * 60 * 1000; // 1h
    const signed = await issueSignedToken({
      token: this.opts.token,
      pathname: objectId,
      operations: ['put'],
      validUntil,
      allowedContentTypes: options?.contentType ? [options.contentType] : undefined,
      // Server-side object-host ceiling: the presigned PUT carries
      // `vercel-blob-maximum-size-in-bytes` and the Vercel Blob host rejects any
      // over-size upload with `file_too_large` — a malicious client that skips its
      // own pre-upload trim is still bound (review #525 skill-wire plan, Blob residual).
      maximumSizeInBytes: options.maxBytes,
    });
    // Presign a control-plane scoped PUT: the client PUTs the segment to Blob directly.
    const { presignedUrl } = await presignUrl(
      { clientSigningToken: signed.clientSigningToken, delegationToken: signed.delegationToken },
      {
        access: 'private',
        operation: 'put',
        pathname: objectId,
        validUntil,
        // Mirrors the delegation ceiling on the signed URL so the CDN enforces it too.
        maximumSizeInBytes: options.maxBytes,
      },
    );
    return { uploadUrl: presignedUrl, objectId, readUrl: undefined };
  }

  async readUrl(objectId: TranscriptObjectId): Promise<string | null> {
    if (!isTranscriptObjectId(objectId)) return null;
    try {
      const signed = await issueSignedToken({
        token: this.opts.token,
        pathname: objectId,
        operations: ['get'],
        validUntil: Date.now() + 5 * 60 * 1000,
      });
      const { presignedUrl } = await presignUrl(
        { clientSigningToken: signed.clientSigningToken, delegationToken: signed.delegationToken },
        { access: 'private', operation: 'get', pathname: objectId },
      );
      return presignedUrl;
    } catch {
      return null;
    }
  }

  async read(objectId: TranscriptObjectId): Promise<string | null> {
    const url = await this.readUrl(objectId);
    if (!url) return null;
    try {
      const res = await fetch(url);
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }
}
