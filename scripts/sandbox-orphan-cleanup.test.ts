import { describe, expect, it } from 'vitest';
import {
  isOrphanCandidate,
  selectOrphanCandidates,
  ORPHAN_AGE_MS,
  PRODUCT_NAME_PREFIXES,
} from './sandbox-orphan-cleanup.mjs';

describe('sandbox-orphan-cleanup filters', () => {
  const now = 1_700_000_000_000;

  it('never selects names on the DB denylist', () => {
    const denylist = new Set(['inv-workspace-abc', 'inv-http-xyz']);
    expect(
      isOrphanCandidate(
        { name: 'inv-workspace-abc', persistent: true, createdAt: now - ORPHAN_AGE_MS * 2 },
        denylist,
        now,
      ),
    ).toBe(false);
    expect(
      isOrphanCandidate(
        { name: 'inv-http-xyz', persistent: false, createdAt: now - ORPHAN_AGE_MS * 2 },
        denylist,
        now,
      ),
    ).toBe(false);
  });

  it('selects product prefixes not in denylist by default', () => {
    const denylist = new Set<string>();
    for (const p of PRODUCT_NAME_PREFIXES) {
      expect(
        isOrphanCandidate(
          { name: `${p}deadbeef`, persistent: true, createdAt: now },
          denylist,
          now,
        ),
      ).toBe(true);
    }
  });

  it('does not select non-product ephemerals unless includeNonProduct', () => {
    const denylist = new Set<string>();
    const oldEph = {
      name: 'sbx_ephemeral_1',
      persistent: false,
      createdAt: now - ORPHAN_AGE_MS,
    };
    expect(isOrphanCandidate(oldEph, denylist, now)).toBe(false);
    expect(isOrphanCandidate(oldEph, denylist, now, { includeNonProduct: true })).toBe(
      true,
    );
    expect(
      isOrphanCandidate(
        {
          name: 'sbx_ephemeral_1',
          persistent: false,
          createdAt: now - ORPHAN_AGE_MS + 1,
        },
        denylist,
        now,
        { includeNonProduct: true },
      ),
    ).toBe(false);
  });

  it('does not select persistent non-product names even with includeNonProduct', () => {
    expect(
      isOrphanCandidate(
        {
          name: 'my-long-lived',
          persistent: true,
          createdAt: now - ORPHAN_AGE_MS * 10,
        },
        new Set(),
        now,
        { includeNonProduct: true },
      ),
    ).toBe(false);
  });

  it('selectOrphanCandidates defaults to product prefixes only', () => {
    const out = selectOrphanCandidates(
      [
        { name: 'inv-http-gone', persistent: true, createdAt: now },
        { name: 'keep-me', persistent: true, createdAt: now },
        {
          name: 'old-eph',
          persistent: false,
          createdAt: now - ORPHAN_AGE_MS * 2,
        },
      ],
      ['keep-me'],
      now,
    );
    expect(out.map((c) => c.name)).toEqual(['inv-http-gone']);
  });

  it('selectOrphanCandidates can include non-product when opted in', () => {
    const out = selectOrphanCandidates(
      [
        { name: 'inv-http-gone', persistent: true, createdAt: now },
        { name: 'keep-me', persistent: true, createdAt: now },
        {
          name: 'old-eph',
          persistent: false,
          createdAt: now - ORPHAN_AGE_MS * 2,
        },
      ],
      ['keep-me'],
      now,
      { includeNonProduct: true },
    );
    expect(out.map((c) => c.name).sort()).toEqual(['inv-http-gone', 'old-eph']);
  });
});
