import { describe, expect, it } from 'vitest';
import { isTranscriptObjectId, newBlobObjectId } from './blobStore';
import { MemoryBlobTranscriptStore } from './blobStores';

/**
 * Phase 0 (#515) — transcript object store seam + memory double.
 */
describe('blobStore — transcript object seam', () => {
  it('isTranscriptObjectId is Redis-safe opaque (charset for meta.transcriptPointer)', () => {
    expect(isTranscriptObjectId('tx_abc123-9')).toBe(true);
    for (const bad of ['*', 'a:b', 'has space', 'a/b', 'x'.repeat(129), 7, null, undefined]) {
      expect(isTranscriptObjectId(bad)).toBe(false);
    }
  });

  it('newBlobObjectId is a compact Redis-safe opaque id (no slashes / globs), valid as meta.transcriptPointer AND a Blob pathname', () => {
    // Reader's Blocker: a slashy pathname (`harness/{tenant}/{user}/{session}/…`)
    // is NOT a valid `meta.transcriptPointer`, so the minted id must be slash-free
    // and unguessable, and used verbatim as the Blob pathname.
    const id = newBlobObjectId();
    expect(isTranscriptObjectId(id)).toBe(true);
    expect(id).not.toContain('/');
    expect(id).not.toContain(':');
    expect(id.length).toBeLessThanOrEqual(128);
    // Uniqueness/unpredictability for two mints.
    expect(newBlobObjectId()).not.toBe(id);
  });

  it('MemoryBlobTranscriptStore mints a scoped upload URL + objectId and pages a read URL', async () => {
    const s = new MemoryBlobTranscriptStore();
    expect(s.kind).toBe('memory');
    const minted = await s.mintUpload({ keyPrefix: 'harness/t/u/s' });
    expect(typeof minted.uploadUrl).toBe('string');
    expect(minted.uploadUrl).toContain('memory://upload/');
    expect(isTranscriptObjectId(minted.objectId)).toBe(true);

    const readUrl = await s.readUrl(minted.objectId);
    expect(readUrl).toContain('memory://transcript/');
    const read = await s.read(minted.objectId);
    expect(read).toBeTruthy();

    // missing object
    await expect(s.readUrl('tx_missing')).resolves.toBeNull();
    await expect(s.read('tx_missing')).resolves.toBeNull();
  });
});
