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
  TranscriptObjectId,
} from './blobStore';
import { isTranscriptObjectId, newBlobObjectId } from './blobStore';

/** In-memory double: same seam, no real object store. Tests + dev fallback only. */
export class MemoryBlobTranscriptStore implements BlobTranscriptStore {
  readonly kind = 'memory' as const;
  private readonly objects = new Map<string, string>();

  async mintUpload(options?: { keyPrefix?: string; contentType?: string }): Promise<MintedUpload> {
    // Same compact Redis-safe id shape as the Vercel store, so a test-injected
    // memory double never mints an id that would fail `isTranscriptObjectId`.
    const id = newBlobObjectId();
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

  constructor(private readonly opts: { token: string; keyPrefix?: string }) {}

  async mintUpload(options?: { keyPrefix?: string; contentType?: string }): Promise<MintedUpload> {
    // The object id IS the Blob pathname AND the Redis envelope pointer (see
    // `newBlobObjectId`): a compact, unguessable, Redis-safe opaque string, never
    // a slashy hierarchical path — so the stored `meta.transcriptPointer` always
    // equals the object the server signs reads for, and `presignUrl`'s pathname
    // match holds. (A slashy `harness/{tenant}/{user}/{session}/{ts}_{uuid}`
    // pathname would fail `isTranscriptObjectId` and 400 every envelope upsert /
    // read — reader's Blocker.)
    const objectId = newBlobObjectId();
    const validUntil = Date.now() + 60 * 60 * 1000; // 1h
    const signed = await issueSignedToken({
      token: this.opts.token,
      pathname: objectId,
      operations: ['put'],
      validUntil,
      allowedContentTypes: options?.contentType ? [options.contentType] : undefined,
    });
    // Presign a control-plane scoped PUT: the client PUTs the segment to Blob directly.
    const { presignedUrl } = await presignUrl(
      { clientSigningToken: signed.clientSigningToken, delegationToken: signed.delegationToken },
      { access: 'private', operation: 'put', pathname: objectId, validUntil },
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
