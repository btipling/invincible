import { describe, expect, it, vi } from 'vitest';
import {
  isObjectIdBoundTo,
  isTranscriptObjectId,
  newBlobObjectId,
  objectBindingFor,
  type ObjectScope,
} from './blobStore';
import { MemoryBlobTranscriptStore, VercelBlobTranscriptStore } from './blobStores';

// Stub the Vercel Blob SDK so the Vercel store can be exercised without credentials
// or network. `issueSignedToken` / `presignUrl` are spied on so a test can assert the
// `maximumSizeInBytes` ceiling is forwarded to BOTH (the object-host enforcement path).
vi.mock('@vercel/blob', () => ({
  issueSignedToken: vi.fn(async () => ({
    clientSigningToken: 'client-signing-token',
    delegationToken: 'delegation-token',
    validUntil: Date.now() + 60 * 60 * 1000,
  })),
  presignUrl: vi.fn(async () => ({ presignedUrl: 'https://blob.example/upload' })),
}));
import { issueSignedToken, presignUrl } from '@vercel/blob';

const EIGHT_MIB = 8 * 1024 * 1024;

const SCOPE_A: ObjectScope = { tenantId: 'tenant-a', userId: 'user-a', sessionId: 'abc' };
const SCOPE_B: ObjectScope = { tenantId: 'tenant-a', userId: 'user-b', sessionId: 'xyz' };

/**
 * Phase 0 (#515) — transcript object store seam + memory double.
 */
describe('blobStore — transcript object seam', () => {
  it('isTranscriptObjectId is Redis-safe opaque (charset for meta.transcriptPointer)', () => {
    expect(isTranscriptObjectId('tx_abc123-9')).toBe(true);
    for (const bad of ['*', 'a:b', 'has space', 'a/b', 'x'.repeat(513), 7, null, undefined]) {
      expect(isTranscriptObjectId(bad)).toBe(false);
    }
  });

  it('newBlobObjectId is a compact Redis-safe opaque id (no slashes / globs), valid as meta.transcriptPointer AND a Blob pathname', () => {
    // Reader's Blocker: a slashy pathname (`harness/{tenant}/{user}/{session}/…`)
    // is NOT a valid `meta.transcriptPointer`, so the minted id must be slash-free
    // and unguessable, and used verbatim as the Blob pathname.
    const id = newBlobObjectId(SCOPE_A);
    expect(isTranscriptObjectId(id)).toBe(true);
    expect(id).not.toContain('/');
    expect(id).not.toContain(':');
    expect(id.length).toBeLessThanOrEqual(128);
    // Uniqueness/unpredictability for two mints (same scope → distinct objects).
    expect(newBlobObjectId(SCOPE_A)).not.toBe(id);
  });

  it('minted ids are bound to their owning session scope; foreign scopes never match (Major L2 binding)', () => {
    const a = newBlobObjectId(SCOPE_A);
    // Owned by its scope.
    expect(isObjectIdBoundTo(a, SCOPE_A)).toBe(true);
    // NOT owned by a different user/session scope — this is the property that closes
    // the plant-another-user's-pointer IDOR.
    expect(isObjectIdBoundTo(a, SCOPE_B)).toBe(false);
    // Deterministic derivable prefix across mints for the same scope.
    expect(a.startsWith(objectBindingFor(SCOPE_A))).toBe(true);
    expect(objectBindingFor(SCOPE_A)).not.toBe(objectBindingFor(SCOPE_B));
    // Non-id garbage and Redis-unsafe ids never match.
    expect(isObjectIdBoundTo('anything-else', SCOPE_A)).toBe(false);
    expect(isObjectIdBoundTo('a:b', SCOPE_A)).toBe(false);
  });

  it('MemoryBlobTranscriptStore mints a scoped upload URL + session-bound objectId and pages a read URL', async () => {
    const s = new MemoryBlobTranscriptStore();
    expect(s.kind).toBe('memory');
    const minted = await s.mintUpload({ scope: SCOPE_A, maxBytes: 8 * 1024 * 1024 });
    expect(typeof minted.uploadUrl).toBe('string');
    expect(minted.uploadUrl).toContain('memory://upload/');
    expect(isTranscriptObjectId(minted.objectId)).toBe(true);
    expect(isObjectIdBoundTo(minted.objectId, SCOPE_A)).toBe(true);

    const readUrl = await s.readUrl(minted.objectId);
    expect(readUrl).toContain('memory://transcript/');
    const read = await s.read(minted.objectId);
    expect(read).toBeTruthy();

    // missing object
    await expect(s.readUrl('tx_missing')).resolves.toBeNull();
    await expect(s.read('tx_missing')).resolves.toBeNull();
  });

  it('mintUpload REQUIRES an ownership scope — omitting it throws (no invented shared dummy binding, reader Nit)', async () => {
    // Tracking the reviewer's Nit: `scope` must not default to a shared dummy
    // `{t,u,s}` binding (a forgetful future caller would mint an object that can
    // never be authorized for any real session). Both impls throw on omission —
    // in both cases BEFORE any credential/network work, so no token is needed.
    const memory = new MemoryBlobTranscriptStore();
    // `{}` cast through `never`: exercises the runtime guard against a JS caller that
    // fails to supply `scope` (TS enforces it statically for TS callers, so the
    // assertion here is deliberate — it peels off only the compile-time requirement).
    await expect(memory.mintUpload({} as never)).rejects.toThrow(
      /requires an ownership scope/,
    );

    const vercel = new VercelBlobTranscriptStore({ token: 'not-read-when-scope-missing' });
    await expect(vercel.mintUpload({} as never)).rejects.toThrow(
      /requires an ownership scope/,
    );
  });

  it('mintUpload REQUIRES a positive integer maxBytes ceiling — omitting/invalid throws (review #525 Blob residual)', async () => {
    // `maxBytes` is never defaulted: an object without a byte ceiling reintroduces the
    // client-honor residual this seam exists to retire. Both impls throw on omission
    // / non-positive input.
    const memory = new MemoryBlobTranscriptStore();
    await expect(
      memory.mintUpload({ scope: SCOPE_A, maxBytes: undefined } as never),
    ).rejects.toThrow(/requires a positive integer maxBytes ceiling/);
    await expect(
      memory.mintUpload({ scope: SCOPE_A, maxBytes: 0 }),
    ).rejects.toThrow(/requires a positive integer maxBytes ceiling/);

    const vercel = new VercelBlobTranscriptStore({ token: 'rw-token' });
    await expect(
      vercel.mintUpload({ scope: SCOPE_A, maxBytes: undefined } as never),
    ).rejects.toThrow(/requires a positive integer maxBytes ceiling/);
    expect(issueSignedToken).not.toHaveBeenCalled();
  });

  it('VercelBlobTranscriptStore forwards maximumSizeInBytes to issueSignedToken AND presignUrl (object-host server-side ceiling)', async () => {
    vi.mocked(issueSignedToken).mockClear();
    vi.mocked(presignUrl).mockClear();

    const vercel = new VercelBlobTranscriptStore({ token: 'rw-token' });
    const minted = await vercel.mintUpload({ scope: SCOPE_A, maxBytes: EIGHT_MIB });

    expect(minted.uploadUrl).toBeTruthy();
    // issueSignedToken encodes the ceiling in the delegation (object-host enforced).
    expect(issueSignedToken).toHaveBeenCalledTimes(1);
    expect(vi.mocked(issueSignedToken).mock.calls[0]![0]).toMatchObject({
      maximumSizeInBytes: EIGHT_MIB,
    });
    // presignUrl mirrors it on the signed URL (vercel-blob-maximum-size-in-bytes), so
    // the CDN enforces the same ceiling on the client→Blob PUT.
    expect(presignUrl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(presignUrl).mock.calls[0]![1]).toMatchObject({
      maximumSizeInBytes: EIGHT_MIB,
    });
  });
});
