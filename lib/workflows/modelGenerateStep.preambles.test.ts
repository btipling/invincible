/**
 * Plan #938 DoD rows 6–7 / adversarial-review #940 Minor:
 * `resolveInStepPreambles` must read `meta.workingNotes` even when the
 * persona/skills stores are ABSENT (the retired `return {}` guard).
 * In-memory envelope fake — no Redis / PGlite / Gateway.
 *
 * Also pins plan #941 / adversarial-review #943 Minor: in-step freshness
 * reminder fail-open (unbound pointer, missing blob, non-`{paths}` JSON).
 *
 * Imports the helpers from `inStepPreambles.ts` (not the `'use step'` file) so
 * the unit pin does not re-export a store graph into the workflow VM bundle.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKING_NOTES_MAX_BYTES } from '../sessionCloudCaps';
import { newBlobObjectId } from '../sessions/blobStore';

const readEnvelope = vi.fn();
const blobRead = vi.fn();

vi.mock('../tenancy/harnessSessionsRedis', () => ({
  resolveSessionStore: async () => ({
    ok: true as const,
    value: {
      get: vi.fn(),
      put: vi.fn(),
      list: vi.fn(),
      remove: vi.fn(),
      readEnvelope,
      upsertEnvelope: vi.fn(),
    },
  }),
  sessionKeyFor: (tenantId: string, userId: string, sessionId: string) => ({
    tenantId,
    userId,
    sessionId,
  }),
  resolveBlobStore: async () => ({
    ok: true as const,
    value: { read: blobRead },
  }),
}));

vi.mock('../tenancy/personaInject', () => ({
  resolvePersonaPreamble: vi.fn(async () => {
    throw new Error('persona store must not be required for the notes fold');
  }),
}));

vi.mock('../tenancy/skillInject', () => ({
  resolveSkillPreamble: vi.fn(async () => {
    throw new Error('skills store must not be required for the notes fold');
  }),
}));

import { resolveInStepPreambles, resolveInStepFreshnessReminder } from './inStepPreambles';

const SCOPE = {
  userId: 'user-1',
  sessionId: 'sess-1',
  tenantId: 'tenant-1',
};

describe('resolveInStepPreambles — working-notes fold (plan #938 / adversarial #940)', () => {
  afterEach(() => {
    readEnvelope.mockReset();
    blobRead.mockReset();
  });

  it('reads meta.workingNotes when persona/skills stores are absent (widened guard)', async () => {
    readEnvelope.mockResolvedValue({
      id: 'sess-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      createdAt: 1,
      updatedAt: 1,
      meta: { workingNotes: 'finding: the auth seam lives in lib/tenancy/session.ts' },
    });
    // No userPersonas / userSkills on services — the old early-return would
    // drop the notes block here.
    const out = await resolveInStepPreambles({ ...SCOPE, services: {} });
    expect(out.notesPreamble).toBe(
      'finding: the auth seam lives in lib/tenancy/session.ts',
    );
    expect(out.personaPreamble).toBeUndefined();
    expect(out.skillsPreamble).toBeUndefined();
    expect(readEnvelope).toHaveBeenCalled();
  });

  it('omits the notes block when the envelope has none (zero tokens)', async () => {
    readEnvelope.mockResolvedValue({
      id: 'sess-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      createdAt: 1,
      updatedAt: 1,
      meta: {},
    });
    const out = await resolveInStepPreambles({ ...SCOPE, services: {} });
    expect(out.notesPreamble).toBeUndefined();
    expect(out).toEqual({});
  });

  it('drops an over-cap notes block to unset (never truncates, never fails the round)', async () => {
    readEnvelope.mockResolvedValue({
      id: 'sess-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      createdAt: 1,
      updatedAt: 1,
      meta: { workingNotes: 'x'.repeat(WORKING_NOTES_MAX_BYTES + 1) },
    });
    const out = await resolveInStepPreambles({ ...SCOPE, services: {} });
    expect(out.notesPreamble).toBeUndefined();
  });

  it('fail-open: envelope read throw → no notes block (round still proceeds)', async () => {
    readEnvelope.mockRejectedValue(new Error('redis down'));
    const out = await resolveInStepPreambles({ ...SCOPE, services: {} });
    expect(out.notesPreamble).toBeUndefined();
    expect(out).toEqual({});
  });
});

describe('resolveInStepFreshnessReminder — fail-open (plan #941 / adversarial #943)', () => {
  const frScope = { tenantId: SCOPE.tenantId, userId: SCOPE.userId, sessionId: SCOPE.sessionId };

  afterEach(() => {
    blobRead.mockReset();
  });

  it('bound pointer + {paths} JSON → rendered reminder', async () => {
    const pointer = newBlobObjectId(frScope);
    blobRead.mockResolvedValue(JSON.stringify({ paths: ['src/foo.ts'] }));
    const text = await resolveInStepFreshnessReminder({ pointer, scope: frScope });
    expect(text).toBeDefined();
    expect(text).toContain('Error: File-freshness law for this session');
    expect(text).toContain('- src/foo.ts');
    expect(blobRead).toHaveBeenCalledWith(pointer);
  });

  it('opaque-but-unbound pointer → undefined (confused-deputy, no blob read)', async () => {
    const text = await resolveInStepFreshnessReminder({
      pointer: 't_ffffffffffff_abc123',
      scope: frScope,
    });
    expect(text).toBeUndefined();
    expect(blobRead).not.toHaveBeenCalled();
  });

  it('bound pointer, missing blob → undefined', async () => {
    const pointer = newBlobObjectId(frScope);
    blobRead.mockResolvedValue(null);
    const text = await resolveInStepFreshnessReminder({ pointer, scope: frScope });
    expect(text).toBeUndefined();
  });

  it('bound pointer, non-{paths} JSON (transcript-shaped) → undefined', async () => {
    const pointer = newBlobObjectId(frScope);
    blobRead.mockResolvedValue(JSON.stringify({ id: 's', messages: [] }));
    const text = await resolveInStepFreshnessReminder({ pointer, scope: frScope });
    expect(text).toBeUndefined();
  });

  it('bound pointer, {paths:[]} → undefined (zero-read prior turn, no fold)', async () => {
    const pointer = newBlobObjectId(frScope);
    blobRead.mockResolvedValue(JSON.stringify({ paths: [] }));
    const text = await resolveInStepFreshnessReminder({ pointer, scope: frScope });
    expect(text).toBeUndefined();
  });

  it('adversarial #943 — bound pointer + {paths, omitted} → rendered marker', async () => {
    const pointer = newBlobObjectId(frScope);
    blobRead.mockResolvedValue(
      JSON.stringify({ paths: ['keep/me.ts'], omitted: 5 }),
    );
    const text = await resolveInStepFreshnessReminder({ pointer, scope: frScope });
    expect(text).toBeDefined();
    expect(text).toContain('- keep/me.ts');
    expect(text).toContain('(\u2026 5 earlier paths omitted)');
  });
});
