import { afterEach, describe, expect, it } from 'vitest';
import {
  type HarnessSessionRecord,
  RESERVED_META_KEYS,
  envelopeKeyString,
  isEnvelopeStore,
  isRedisSafeOpaqueId,
  validateMeta,
  validateMetaFields,
  validateSessionEnvelope,
  validateSessionRecord,
  validateSessionRecordKey,
  sessionKeyString,
  sessionPrefix,
} from './sessionStore';
import {
  HARNESS_SESSION_MAX_ATTACHED_SKILLS,
  HARNESS_SESSION_MAX_BODY_BYTES,
  HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES,
  HARNESS_SESSION_MAX_META_BYTES,
  HARNESS_SESSION_MAX_MSG_BYTES,
  PERSONA_SNAPSHOT_MAX_BYTES,
  REDIS_SAFE_OPAQUE_ID_MAX,
  REDIS_SAFE_OPAQUE_ID_RE,
} from '../sessionCloudCaps';
import { MemorySessionStore } from './memorySessionStore';
import {
  RedisSessionStore,
  setRedisClientFactoryForTests,
  resetRedisClientCacheForTests,
  type RedisClientLike,
} from './redisSessionStore';
import type { RedisClientType } from 'redis';

function makeRecord(overrides: Partial<HarnessSessionRecord> = {}): HarnessSessionRecord {
  return {
    id: 'sess_abc',
    userId: 'user-1',
    tenantId: 'tenant-1',
    createdAt: 1000,
    updatedAt: 0,
    messages: [],
    meta: {},
    ...overrides,
  };
}

/** Fake Redis client backed by a Map; records the last set key/opts for assertions. */
function fakeClient(map: Map<string, unknown> = new Map()) {
  const calls: { key: string; opts?: { ex?: number } }[] = [];
  const client: RedisClientLike = {
    async get(key) {
      return map.has(key) ? structuredClone(map.get(key)) : null;
    },
    async set(key, value, opts) {
      map.set(key, structuredClone(value));
      calls.push({ key, opts });
      return 'OK';
    },
    async del(...keys) {
      for (const k of keys) map.delete(k);
      return keys.length;
    },
    async keys(pattern) {
      const base = pattern.slice(0, -1);
      return [...map.keys()].filter((k) => k.startsWith(base));
    },
  };
  return { client, calls, map };
}

describe('sessionStore — key helpers', () => {
  it('builds single-record keys and per-user list prefixes with tenant:user scoping', () => {
    const key = { tenantId: 't1', userId: 'u1', sessionId: 's1' };
    expect(sessionKeyString(key)).toBe('harness:session:t1:u1:s1');
    expect(sessionPrefix({ tenantId: 't1', userId: 'u1' })).toBe('harness:session:t1:u1:*');
  });
});

describe('validateSessionRecord', () => {
  it('accepts a valid record (reuses caps + meta)', () => {
    const res = validateSessionRecord(makeRecord());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.id).toBe('sess_abc');
      expect(res.value.messages).toEqual([]);
      expect(res.value.meta).toEqual({});
    }
  });

  it('reuses message / id / updatedAt caps (max msg bytes, role, id)', () => {
    // message text over cap
    expect(
      validateSessionRecord(makeRecord({ messages: [{ id: 'm1', role: 'user', text: 'x'.repeat(262_144 + 1), at: 1 }] })).ok,
    ).toBe(false);
    // invalid role
    expect(
      validateSessionRecord(
        makeRecord({ messages: [{ id: 'm1', role: 'troll' as never, text: 'hi', at: 1 }] }),
      ).ok,
    ).toBe(false);
    // valid message
    expect(
      validateSessionRecord(
        makeRecord({ messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }] }),
      ).ok,
    ).toBe(true);
    // negative updatedAt
    expect(validateSessionRecord(makeRecord({ updatedAt: -1 })).ok).toBe(false);
    // empty id
    expect(validateSessionRecord(makeRecord({ id: '' })).ok).toBe(false);
  });

  it('rejects missing/invalid tenant/user/createdAt', () => {
    expect(validateSessionRecord(makeRecord({ tenantId: '' })).ok).toBe(false);
    expect(validateSessionRecord(makeRecord({ userId: 7 as never })).ok).toBe(false);
    expect(validateSessionRecord(makeRecord({ createdAt: -5 })).ok).toBe(false);
  });

  it('enforces the Redis-safe opaque charset on id/tenant/user (adv. L2 glob bleed)', () => {
    const globs = ['*', '?', '[', ']', 'a:b', 'a*b', 'a?b', 'a/b', 'a b', 'a.b'];
    for (const bad of globs) {
      expect(validateSessionRecord(makeRecord({ id: bad })).ok).toBe(false);
      expect(validateSessionRecord(makeRecord({ tenantId: bad })).ok).toBe(false);
      expect(validateSessionRecord(makeRecord({ userId: bad })).ok).toBe(false);
    }
    // allowed charset still passes
    for (const ok of ['sess_abc-1', 'user-1', 'tenant_1', 'UUID0123456789abcdEF', 'a']) {
      expect(validateSessionRecord(makeRecord({ id: ok })).ok).toBe(true);
      expect(validateSessionRecord(makeRecord({ tenantId: ok })).ok).toBe(true);
      expect(validateSessionRecord(makeRecord({ userId: ok })).ok).toBe(true);
    }
    expect(isRedisSafeOpaqueId('*')).toBe(false);
    expect(isRedisSafeOpaqueId('a:b')).toBe(false);
    expect(isRedisSafeOpaqueId('sess_abc-1')).toBe(true);
  });

  it('rejects keys/scopes with non-safe ids (would break the KEYS list prefix)', () => {
    expect(validateSessionRecordKey({ tenantId: 't', userId: 'u', sessionId: '*' }).ok).toBe(false);
    expect(validateSessionRecordKey({ tenantId: 't', userId: '*', sessionId: 's' }).ok).toBe(false);
    expect(validateSessionRecordKey({ tenantId: '*', userId: 'u', sessionId: 's' }).ok).toBe(false);
    expect(validateSessionRecordKey({ tenantId: 't', userId: 'u', sessionId: 's' }).ok).toBe(true);
  });
});

describe('meta — schema-typed reserved (parent #411 lock)', () => {
  it('allows absent / null / empty meta as {}', () => {
    expect(validateMeta(undefined).ok).toBe(true);
    expect(validateMeta(null).ok).toBe(true);
    expect(validateSessionRecord(makeRecord({ meta: undefined })).ok).toBe(true);
  });

  it('rejects non-object meta', () => {
    expect(validateMeta('nope').ok).toBe(false);
    expect(validateMeta([]).ok).toBe(false);
    expect(
      validateSessionRecord(
        makeRecord({ meta: ('secret? no' as unknown) as HarnessSessionRecord['meta'] }),
      ).ok,
    ).toBe(false);
  });

  it('accepts only reserved keys; rejects unknown keys', () => {
    expect(RESERVED_META_KEYS).toEqual([
      'activeSandboxId',
      'logicalCwd',
      'legacySnapshotId',
      'title',
      'personaId',
      'personaSnapshot',
      'transcriptPointer',
      'checkpointPointer',
      'attachedSkills',
      'selectedModel',
      'reasoningEffort',
      'resolvedProvider',
      'usage',
      'turnRunId',
      'turnStatus',
      'turnStreamCursor',
    ]);
    for (const k of RESERVED_META_KEYS) {
      // `attachedSkills` is a JSON-encoded string; `usage` is a JSON UsageSummary
      // string. Use a valid value so the reserved-key acceptance loop passes.
      const rawMeta: unknown = {
        [k]:
          k === 'attachedSkills'
            ? '[]'
            : k === 'usage'
              ? JSON.stringify({ source: 'provider', prompt: 1, completion: 1, total: 2 })
              : 'x',
      };
      const res = validateSessionRecord(
        makeRecord({ meta: rawMeta as HarnessSessionRecord['meta'] }),
      );
      expect(res.ok).toBe(true);
    }
    const badMeta: unknown = { arbitrary: 'x' };
    expect(validateSessionRecord(makeRecord({ meta: badMeta as HarnessSessionRecord['meta'] })).ok).toBe(false);
  });

  it('rejects oversized meta (size cap), accepts opaque scalar values without sniffing', () => {
    // Whole-meta cap raised 4096 → 20480 (parent #485 lock): a single <= cap string is fine,
    // an over-budget combined meta JSON fails closed.
    expect(
      validateSessionRecord(
        makeRecord({
          meta: { personaSnapshot: 'x'.repeat(PERSONA_SNAPSHOT_MAX_BYTES) },
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateSessionRecord(
        makeRecord({ meta: { personaSnapshot: 'x'.repeat(HARNESS_SESSION_MAX_META_BYTES + 1) } }),
      ).ok,
    ).toBe(false);
    // Opaque passthrough: a secret-looking value inside a reserved key is allowed — the
    // reserved key set + cap is the contract, not free-form "secret-looking" sniffing.
    expect(
      validateSessionRecord(makeRecord({ meta: { legacySnapshotId: 'sess_tok_0123456789abcdef', activeSandboxId: 'sbx-1' } })).ok,
    ).toBe(true);
  });

  it('plan #616 — accepts a valid meta.selectedModel and DROPS a poisoned one to unset (never 400)', () => {
    // Valid printable-ASCII model id ≤ 128 (catalog string) is preserved.
    const ok = validateSessionRecord(
      makeRecord({ meta: { selectedModel: 'anthropic/claude-a' } as HarnessSessionRecord['meta'] }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.meta.selectedModel).toBe('anthropic/claude-a');

    // Poisoned values (non-string, empty, control chars / non-printable, over-length)
    // are DROPPED to unset (the key is omitted) — the record still validates (never 400).
    for (const bad of [
      'has space',
      'x'.repeat(129),
      42 as unknown,
      undefined as unknown,
      'with\u0007control',
    ]) {
      const res = validateSessionRecord(
        makeRecord({ meta: { selectedModel: bad } as HarnessSessionRecord['meta'] }),
      );
      expect(res.ok).toBe(true); // drop-to-unset, not a 400
      if (res.ok) expect(res.value.meta.selectedModel).toBeUndefined();
    }

    // Unknown keys are STILL rejected (reserved-key contract intact).
    expect(
      validateSessionRecord(
        makeRecord({ meta: { notReserved: 1 } as HarnessSessionRecord['meta'] }),
      ).ok,
    ).toBe(false);
  });

  it('plan #616 — validateMeta drops a poisoned selectedModel but keeps it omitted from meta', () => {
    const res = validateSessionRecord(
      makeRecord({ meta: { selectedModel: 'not printable...' } as unknown as HarnessSessionRecord['meta'] }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect('selectedModel' in res.value.meta).toBe(false);
      expect(res.value.meta.selectedModel).toBeUndefined();
    }
  });

  it('plan #898 — accepts a valid meta.reasoningEffort and DROPS a poisoned one to unset (never 400)', () => {
    const ok = validateSessionRecord(
      makeRecord({ meta: { reasoningEffort: 'low' } as HarnessSessionRecord['meta'] }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.meta.reasoningEffort).toBe('low');

    const maxOk = validateSessionRecord(
      makeRecord({ meta: { reasoningEffort: 'max' } as HarnessSessionRecord['meta'] }),
    );
    expect(maxOk.ok).toBe(true);
    if (maxOk.ok) expect(maxOk.value.meta.reasoningEffort).toBe('max');

    for (const bad of ['has space', 'x'.repeat(33), 42 as unknown]) {
      const res = validateSessionRecord(
        makeRecord({ meta: { reasoningEffort: bad } as HarnessSessionRecord['meta'] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.meta.reasoningEffort).toBeUndefined();
    }
  });

  it('plan #906 — accepts a valid meta.resolvedProvider and DROPS a poisoned one to unset (never 400)', () => {
    const ok = validateSessionRecord(
      makeRecord({ meta: { resolvedProvider: 'togetherai' } as HarnessSessionRecord['meta'] }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.meta.resolvedProvider).toBe('togetherai');

    const labelOk = validateSessionRecord(
      makeRecord({ meta: { resolvedProvider: 'Together AI' } as HarnessSessionRecord['meta'] }),
    );
    expect(labelOk.ok).toBe(true);
    if (labelOk.ok) expect(labelOk.value.meta.resolvedProvider).toBe('togetherai');

    for (const bad of ['https://x', 'moonshotai/kimi-k3', 'x'.repeat(33), 42 as unknown]) {
      const res = validateSessionRecord(
        makeRecord({ meta: { resolvedProvider: bad } as HarnessSessionRecord['meta'] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.meta.resolvedProvider).toBeUndefined();
    }
  });

  it('plan #795 — accepts a valid Redis-safe meta.turnRunId and DROPS a poisoned one to unset (never 400)', () => {
    // A Workflow run id is Redis-safe opaque (`[A-Za-z0-9_-]{1,512}`); trimmed + preserved.
    const ok = validateSessionRecord(
      makeRecord({ meta: { turnRunId: 'run_abc-123DEF' } as HarnessSessionRecord['meta'] }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.meta.turnRunId).toBe('run_abc-123DEF');
    // Whitespace is trimmed by `sanitizeTurnRunId`; the STORED value is the trimmed
    // id, not the raw padded string — pinned at the record level so a future
    // raw-`v` regression is caught (adversarial-review PR #820 Nit L6).
    const trimmed = validateSessionRecord(
      makeRecord({ meta: { turnRunId: '  run_abc  ' } as HarnessSessionRecord['meta'] }),
    );
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) expect(trimmed.value.meta.turnRunId).toBe('run_abc');

    // Poisoned values (non-string, empty, non-opaque chars, over-length, glob / `:` /
    // space / `?`) are DROPPED to unset (the key is omitted) — the record still
    // validates, never 400s. A Workflow run id is never a session id (parent lock).
    for (const bad of [
      'run a:b',
      '*',
      'a?b',
      'has space',
      'a.b',
      'run/abc',
      'x'.repeat(513),
      42 as unknown,
      undefined as unknown,
    ]) {
      const res = validateSessionRecord(
        makeRecord({ meta: { turnRunId: bad } as HarnessSessionRecord['meta'] }),
      );
      expect(res.ok).toBe(true); // drop-to-unset, not a 400
      if (res.ok) {
        expect('turnRunId' in res.value.meta).toBe(false);
        expect(res.value.meta.turnRunId).toBeUndefined();
      }
    }

    // The reserved-key contract is intact: unknown keys are STILL rejected.
    expect(
      validateSessionRecord(makeRecord({ meta: { notReserved: 1 } as HarnessSessionRecord['meta'] })).ok,
    ).toBe(false);
  });

  it('plan #795 — validateMeta round-trips turnRunId and omits poison (reserved-key + cap intact)', () => {
    const res = validateMeta({ turnRunId: 'run_abc123-def' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.turnRunId).toBe('run_abc123-def');
    // Poisoned / oversized / non-opaque → `meta` is ok but the key is omitted.
    const poison = validateMeta({ turnRunId: 'x'.repeat(513) });
    expect(poison.ok).toBe(true);
    if (poison.ok) expect('turnRunId' in poison.value).toBe(false);
    const nonOpaque = validateMeta({ turnRunId: 'a:b' });
    expect(nonOpaque.ok).toBe(true);
    if (nonOpaque.ok) expect('turnRunId' in nonOpaque.value).toBe(false);
    // Envelope path shares the same drop-to-unset.
    const env = validateSessionEnvelope({ ...makeRecord(), meta: { turnRunId: 'a\x00b' } });
    expect(env.ok).toBe(true);
    if (env.ok) expect('turnRunId' in env.value.meta).toBe(false);
  });

  it('plan #796 — accepts a valid meta.turnStatus member (incl. terminal completed) and DROPS poison to unset (never 400)', () => {
    // Every member is a valid, preservable carrier — `completed` is a first-class
    // terminal value, NOT special-cased/rejected (later C15 live-only 409 needs it).
    for (const member of ['idle', 'running', 'cancelling', 'completed']) {
      const res = validateSessionRecord(
        makeRecord({ meta: { turnStatus: member } as HarnessSessionRecord['meta'] }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.meta.turnStatus).toBe(member);
    }
    // Record-level: completed is pinned to the exact stored value (non-vacuous).
    const done = validateSessionRecord(
      makeRecord({ meta: { turnStatus: 'completed' } as HarnessSessionRecord['meta'] }),
    );
    expect(done.ok).toBe(true);
    if (done.ok) expect(done.value.meta.turnStatus).toBe('completed');

    // Poisoned / case-folded / unknown / non-member / over-length values are DROPPED
    // to unset (the key is omitted) — the record still validates, never 400s.
    for (const bad of [
      'done',
      'pending',
      'RUNNING',
      'Running',
      ' finished ',
      'x'.repeat(65),
      '' as unknown,
      42 as unknown,
      undefined as unknown,
    ]) {
      const res = validateSessionRecord(
        makeRecord({ meta: { turnStatus: bad } as HarnessSessionRecord['meta'] }),
      );
      expect(res.ok).toBe(true); // drop-to-unset, not a 400
      if (res.ok) {
        expect('turnStatus' in res.value.meta).toBe(false);
        expect(res.value.meta.turnStatus).toBeUndefined();
      }
    }

    // The reserved-key contract is intact: unknown keys are STILL rejected.
    expect(
      validateSessionRecord(makeRecord({ meta: { notReserved: 1 } as HarnessSessionRecord['meta'] })).ok,
    ).toBe(false);
  });

  it('plan #796 — validateMeta round-trips turnStatus and omits poison (reserved-key + cap intact)', () => {
    const ok = validateMeta({ turnStatus: 'completed' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.turnStatus).toBe('completed');
    // Poisoned / unknown / case-folded → `meta` is ok but the key is omitted.
    const poison = validateMeta({ turnStatus: 'x'.repeat(65) });
    expect(poison.ok).toBe(true);
    if (poison.ok) expect('turnStatus' in poison.value).toBe(false);
    const unknown = validateMeta({ turnStatus: 'pending' });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect('turnStatus' in unknown.value).toBe(false);
    const folded = validateMeta({ turnStatus: 'Running' });
    expect(folded.ok).toBe(true);
    if (folded.ok) expect('turnStatus' in folded.value).toBe(false);
    // Envelope path shares the same drop-to-unset.
    const env = validateSessionEnvelope({ ...makeRecord(), meta: { turnStatus: ' FINISHED ' } });
    expect(env.ok).toBe(true);
    if (env.ok) expect('turnStatus' in env.value.meta).toBe(false);
  });

  it('plan #797 — accepts a valid non-negative meta.turnStreamCursor (incl. offset 0) and DROPS poison to unset (never 400)', () => {
    // 0 is a legit first-attach offset — pinned at the record level (non-vacuous).
    const zero = validateSessionRecord(
      makeRecord({ meta: { turnStreamCursor: 0 } as HarnessSessionRecord['meta'] }),
    );
    expect(zero.ok).toBe(true);
    if (zero.ok) expect(zero.value.meta.turnStreamCursor).toBe(0);

    const mid = validateSessionRecord(
      makeRecord({ meta: { turnStreamCursor: 12345 } as HarnessSessionRecord['meta'] }),
    );
    expect(mid.ok).toBe(true);
    if (mid.ok) expect(mid.value.meta.turnStreamCursor).toBe(12345);

    // Poisoned (negative / NaN / Infinity / non-integer / >cap / string / non-number)
    // are DROPPED to unset (the key is omitted) — the record still validates, never 400s.
    for (const bad of [
      -1,
      -0.5,
      NaN,
      Infinity,
      0.5,
      1_000_000_001, // > TURN_STREAM_CURSOR_MAX
      '42' as unknown,
      '0' as unknown,
      '' as unknown,
      null as unknown,
      undefined as unknown,
      true as unknown,
    ]) {
      const res = validateSessionRecord(
        makeRecord({ meta: { turnStreamCursor: bad } as HarnessSessionRecord['meta'] }),
      );
      expect(res.ok).toBe(true); // drop-to-unset, not a 400
      if (res.ok) {
        expect('turnStreamCursor' in res.value.meta).toBe(false);
        expect(res.value.meta.turnStreamCursor).toBeUndefined();
      }
    }

    // The reserved-key contract is intact: unknown keys are STILL rejected.
    expect(
      validateSessionRecord(makeRecord({ meta: { notReserved: 1 } as HarnessSessionRecord['meta'] })).ok,
    ).toBe(false);
  });

  it('plan #797 — validateMeta round-trips turnStreamCursor and omits poison (reserved-key + cap intact)', () => {
    const ok = validateMeta({ turnStreamCursor: 12345 });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.turnStreamCursor).toBe(12345);
    const zero = validateMeta({ turnStreamCursor: 0 });
    expect(zero.ok).toBe(true);
    if (zero.ok) expect('turnStreamCursor' in zero.value).toBe(true);
    // Poisoned / negative / over-cap / string → `meta` is ok but the key is omitted.
    const poison = validateMeta({ turnStreamCursor: 1_000_000_001 });
    expect(poison.ok).toBe(true);
    if (poison.ok) expect('turnStreamCursor' in poison.value).toBe(false);
    const negative = validateMeta({ turnStreamCursor: -1 });
    expect(negative.ok).toBe(true);
    if (negative.ok) expect('turnStreamCursor' in negative.value).toBe(false);
    const nan = validateMeta({ turnStreamCursor: NaN });
    expect(nan.ok).toBe(true);
    if (nan.ok) expect('turnStreamCursor' in nan.value).toBe(false);
    const str = validateMeta({ turnStreamCursor: '42' });
    expect(str.ok).toBe(true);
    if (str.ok) expect('turnStreamCursor' in str.value).toBe(false);
    // Envelope path shares the same drop-to-unset.
    const env = validateSessionEnvelope({ ...makeRecord(), meta: { turnStreamCursor: Infinity } });
    expect(env.ok).toBe(true);
    if (env.ok) expect('turnStreamCursor' in env.value.meta).toBe(false);
  });

  it('plan #797 — turnStreamCursor coexists with turnRunId as a DISTINCT reserved key (never folded into turnRunId)', () => {
    const res = validateSessionRecord(
      makeRecord({
        meta: { turnRunId: 'run_abc-123', turnStreamCursor: 7 } as HarnessSessionRecord['meta'],
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.meta.turnRunId).toBe('run_abc-123');
      expect(res.value.meta.turnStreamCursor).toBe(7);
      // Distinct keys — the cursor is never folded into the run id.
      expect('turnStreamCursor' in res.value.meta).toBe(true);
    }
  });
});

describe('validateMetaFields — P1 session-carrier semantic checks (#452)', () => {
  it('accepts / normalizes workspace-relative logicalCwd; rejects host-absolute / control / non-string', () => {
    expect(validateMetaFields({}).ok).toBe(true);
    expect(validateMetaFields({ logicalCwd: 'a/b' }).ok).toBe(true);
    expect(validateMetaFields({ logicalCwd: '.' }).ok).toBe(true);
    expect(validateMetaFields({ logicalCwd: 'src' }).ok).toBe(true);
    // normalized (trimmed)
    const ok = validateMetaFields({ logicalCwd: '  invincible/src  ' });
    expect(ok.ok && ok.value.logicalCwd).toBe('invincible/src');
    // rejected: empty / host-absolute / drive / UNC / controls
    for (const bad of ['', '/etc', 'C:\\Windows', '\\\\host', 'foo\u0000bar']) {
      expect(validateMetaFields({ logicalCwd: bad }).ok).toBe(false);
    }
    expect(validateMetaFields({ logicalCwd: 42 as never }).ok).toBe(false);
  });

  it('accepts Redis-safe activeSandboxId or empty/absent; rejects non-Redis-safe / oversize', () => {
    expect(validateMetaFields({ activeSandboxId: 'sbx_abc123' }).ok).toBe(true);
    expect(validateMetaFields({ activeSandboxId: '' }).ok).toBe(true);
    expect(validateMetaFields({}).ok).toBe(true);
    for (const bad of ['a:b', '*', 'a?b', 'a|b', 'x'.repeat(513), 42 as never]) {
      expect(validateMetaFields({ activeSandboxId: bad as never }).ok).toBe(false);
    }
  });

  it('validateSessionRecord (reused by PUT + mint) rejects invalid carrier meta', () => {
    expect(
      validateSessionRecord(makeRecord({ meta: { logicalCwd: '/etc' } as HarnessSessionRecord['meta'] })).ok,
    ).toBe(false);
    expect(
      validateSessionRecord(makeRecord({ meta: { activeSandboxId: '*' } as HarnessSessionRecord['meta'] })).ok,
    ).toBe(false);
    expect(
      validateSessionRecord(
        makeRecord({ meta: { logicalCwd: 'src', activeSandboxId: 'sbx_a' } as HarnessSessionRecord['meta'] }),
      ).ok,
    ).toBe(true);
  });
});

describe('meta persona keys (parent #485 lock, phase 1 #486)', () => {
  it('accepts Redis-safe personaId or absent; rejects non-Redis-safe / oversize', () => {
    expect(validateMetaFields({ personaId: 'pers_abc-123' }).ok).toBe(true);
    expect(validateMetaFields({}).ok).toBe(true);
    expect(validateMetaFields({ personaId: undefined }).ok).toBe(true);
    for (const bad of ['a:b', '*', 'a?b', 'x'.repeat(513), 42 as never]) {
      expect(validateMetaFields({ personaId: bad as never }).ok).toBe(false);
    }
  });

  it('accepts personaSnapshot up to PERSONA_SNAPSHOT_MAX_BYTES; rejects over / non-string', () => {
    expect(validateMetaFields({ personaSnapshot: 'short text' }).ok).toBe(true);
    expect(
      validateMetaFields({
        personaSnapshot: 'x'.repeat(PERSONA_SNAPSHOT_MAX_BYTES),
      }).ok,
    ).toBe(true);
    expect(
      validateMetaFields({
        personaSnapshot: 'x'.repeat(PERSONA_SNAPSHOT_MAX_BYTES + 1),
      }).ok,
    ).toBe(false);
    expect(validateMetaFields({ personaSnapshot: 7 as never }).ok).toBe(false);
  });

  it('personaSnapshot counts toward the raised whole-meta budget and replays near the cap', () => {
    // A near-cap snapshot fits the raised 1 MiB total alongside a personaId.
    const near = 'x'.repeat(PERSONA_SNAPSHOT_MAX_BYTES);
    const res = validateSessionRecord(
      makeRecord({ meta: { personaId: 'pers_1', personaSnapshot: near } as HarnessSessionRecord['meta'] }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.meta.personaSnapshot).toBe(near);
      expect(res.value.meta.personaId).toBe('pers_1');
    }
    // Snapshot alone larger than the WHOLE meta budget fails closed (never a lie).
    expect(
      validateSessionRecord(
        makeRecord({ meta: { personaSnapshot: 'x'.repeat(HARNESS_SESSION_MAX_META_BYTES + 1) } as HarnessSessionRecord['meta'] }),
      ).ok,
    ).toBe(false);
  });

  it('constants are locked to the generous #514 budget (512 KiB snapshot + 1 MiB total)', () => {
    expect(PERSONA_SNAPSHOT_MAX_BYTES).toBe(512 * 1024);
    expect(HARNESS_SESSION_MAX_META_BYTES).toBe(1024 * 1024);
    // Internal consistency: a full snapshot + reserved headroom must fit the total.
    expect(PERSONA_SNAPSHOT_MAX_BYTES).toBeLessThan(HARNESS_SESSION_MAX_META_BYTES);
  });

  it('caps are locked to the generous #514 budget (8 MiB object, 2 MiB Function body, 262144 msg, opaque-id 512/RE)', () => {
    // 8 MiB body cap = Blob transcript-object ceiling (client→Blob), parent #512 lock.
    expect(HARNESS_SESSION_MAX_BODY_BYTES).toBe(8 * 1024 * 1024);
    // Function-carried full-record body is a SEPARATE wire-safe cap (≤ 4.5 MB ceiling)
    // so a generous object cap can never re-enable a one-shot Function >4.5 MB body.
    expect(HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES).toBe(2 * 1024 * 1024);
    expect(HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES).toBeLessThan(4.5 * 1024 * 1024);
    expect(HARNESS_SESSION_MAX_MSG_BYTES).toBe(262_144); // ring msg cap unchanged
    expect(REDIS_SAFE_OPAQUE_ID_MAX).toBe(512);
    expect(REDIS_SAFE_OPAQUE_ID_RE.source).toContain('{1,512}');
    // a 512-char opaque id is accepted; 513 rejected
    expect(isRedisSafeOpaqueId('a'.repeat(512))).toBe(true);
    expect(isRedisSafeOpaqueId('a'.repeat(513))).toBe(false);
  });
});

describe('MemorySessionStore', () => {
  const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 's1' };

  it('round-trips get/put/list/remove', async () => {
    const s = new MemorySessionStore();
    await expect(s.get(key)).resolves.toBeNull();
    await s.put(key, makeRecord({ id: 's1' }));
    expect((await s.get(key))?.id).toBe('s1');
    expect((await s.list({ tenantId: 'tenant-1', userId: 'user-1' })).map((r) => r.id)).toEqual(['s1']);
    await expect(s.remove(key)).resolves.toBe(true);
    await expect(s.remove(key)).resolves.toBe(false);
    await expect(s.get(key)).resolves.toBeNull();
  });

  it('create preserves supplied id/createdAt/updatedAt (incl 0); upsert bumps updatedAt; stale -> conflict', async () => {
    const s = new MemorySessionStore();
    const created = makeRecord({ id: 's1', createdAt: 1000, updatedAt: 0 });
    const r = await s.put(key, created);
    expect(r.status).toBe('stored');
    const afterCreate = await s.get(key);
    // create does NOT auto-bump updatedAt (sealed 0 preserved) and keeps createdAt
    expect(afterCreate?.updatedAt).toBe(0);
    expect(afterCreate?.createdAt).toBe(1000);

    // upsert with a newer updatedAt keeps createdAt, advances updatedAt
    await s.put(key, makeRecord({ id: 's1', createdAt: 1000, updatedAt: 2000 }));
    const afterUpd = await s.get(key);
    expect(afterUpd?.updatedAt).toBe(2000);
    expect(afterUpd?.createdAt).toBe(1000);

    // a stale write is rejected with the server record
    const rr = await s.put(key, makeRecord({ id: 's1', createdAt: 1000, updatedAt: 1500 }));
    expect(rr.status).toBe('conflict');
    if (rr.status === 'conflict') expect(rr.server.updatedAt).toBe(2000);
  });

  it('upsert preserves STORED createdAt even when the caller supplies a different one (adv. L1/L6 non-vacuous)', async () => {
    const s = new MemorySessionStore();
    await s.put(key, makeRecord({ id: 's1', createdAt: 1000, updatedAt: 0 }));
    // Caller wrongfully bumps createdAt; the store must keep the original.
    await s.put(key, makeRecord({ id: 's1', createdAt: 9999, updatedAt: 2000 }));
    const r = await s.get(key);
    expect(r?.createdAt).toBe(1000);
    expect(r?.updatedAt).toBe(2000);
  });

  it('rejects a key/record identity mismatch (confused-deputy guard, adv. L2)', async () => {
    const s = new MemorySessionStore();
    const mismatch = { ...key, userId: 'attacker' };
    await expect(
      s.put(mismatch, makeRecord({ id: 's1', tenantId: 'tenant-1', userId: 'u1' })),
    ).rejects.toThrow(/must match the session key/);
    await expect(
      s.put(key, makeRecord({ id: 'other-session' })),
    ).rejects.toThrow(/must match the session key/);
    await expect(
      s.put(key, makeRecord({ id: 's1', tenantId: 'other-tenant' })),
    ).rejects.toThrow(/must match the session key/);
  });

  it('rejects unsafe ids at the store boundary (get/put/list/remove)', async () => {
    const s = new MemorySessionStore();
    const badKey = { tenantId: 't1', userId: '*', sessionId: 's1' };
    await expect(s.get(badKey)).rejects.toThrow(/Invalid session key/);
    await expect(s.put(badKey, makeRecord({ id: 's1' }))).rejects.toThrow(/Invalid session key/);
    await expect(s.remove(badKey)).rejects.toThrow(/Invalid session key/);
    await expect(s.list({ tenantId: 't1', userId: '*' })).rejects.toThrow(/Invalid session list scope/);
  });

  it('list is scoped to the {tenant,user} prefix only', async () => {
    const s = new MemorySessionStore();
    const cases = [
      ['t1', 'u1', 'a'],
      ['t1', 'u1', 'b'],
      ['t1', 'u2', 'c'],
      ['t2', 'u1', 'd'],
      ['t1', 'u1x', 'e'], // longer user id must NOT match prefix u1:
    ] as const;
    for (const [tenantId, userId, id] of cases) {
      await s.put({ tenantId, userId, sessionId: id }, makeRecord({ id, tenantId, userId }));
    }
    const ids = (await s.list({ tenantId: 't1', userId: 'u1' })).map((r) => r.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('rejects an invalid record at the store boundary', async () => {
    const s = new MemorySessionStore();
    await expect(
      s.put(key, { ...makeRecord(), meta: { notReserved: 1 } as HarnessSessionRecord['meta'] }),
    ).rejects.toThrow(/not a reserved key/);
  });
});

describe('RedisSessionStore', () => {
  it('uses opts.url verbatim; ignores REDIS_URL (env resolution moved to the root, nit L8)', () => {
    const prev = { ...process.env };
    try {
      // The store body no longer reads `process.env`: even with REDIS_URL set, a
      // client-injected store reports only the explicit `url` (or undefined).
      process.env.REDIS_URL = 'redis://default:secret@dragons.example:6379';
      const store = new RedisSessionStore({
        client: fakeClient().client,
        url: 'rediss://default:pw@host:6380',
      });
      expect(store.url()).toBe('rediss://default:pw@host:6380');

      // No url given → url() is undefined (env is NOT consulted).
      const noUrl = new RedisSessionStore({ client: fakeClient().client });
      expect(noUrl.url()).toBeUndefined();
    } finally {
      process.env = prev;
    }
  });

  it('throws when no client and no url are provided (env not consulted)', () => {
    const prev = { ...process.env };
    try {
      process.env.REDIS_URL = 'redis://default:secret@ignored.example:6379';
      expect(() => new RedisSessionStore()).toThrow(/REDIS_URL/);
    } finally {
      process.env = prev;
    }
  });

  it('issues harness:session:{tenant}:{user}:{id} keys, lists per-user prefix, applies TTL ex', async () => {
    const { client, calls } = fakeClient();
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };

    const noTtl = new RedisSessionStore({ client, ttlMs: 0 });
    await noTtl.put(key, makeRecord({ id: 'id' }));
    expect(calls.at(-1)?.key).toBe('harness:session:tenant-1:user-1:id');
    expect(calls.at(-1)?.opts).toBeUndefined(); // no `ex` when TTL 0

    expect((await noTtl.get(key))?.id).toBe('id');
    expect((await noTtl.list({ tenantId: 'tenant-1', userId: 'user-1' })).map((r) => r.id)).toEqual(['id']);
    await expect(noTtl.remove(key)).resolves.toBe(true);
    await expect(noTtl.get(key)).resolves.toBeNull();

    const withTtl = new RedisSessionStore({ client, ttlMs: 1500 });
    await withTtl.put(key, makeRecord({ id: 'id' }));
    expect(calls.at(-1)?.opts).toEqual({ ex: 2 }); // ceil(1500/1000)
  });

  it('enforces LWW on put via the injected client', async () => {
    const { client } = fakeClient();
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };
    await store.put(key, makeRecord({ id: 'id', updatedAt: 5000 }));
    const rr = await store.put(key, makeRecord({ id: 'id', updatedAt: 4000 }));
    expect(rr.status).toBe('conflict');
    if (rr.status === 'conflict') expect(rr.server.updatedAt).toBe(5000);
  });

  it('rejects an invalid record at the store boundary', async () => {
    const { client } = fakeClient();
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };
    await expect(
      store.put(key, { ...makeRecord(), meta: { unknownMeta: 1 } as HarnessSessionRecord['meta'] }),
    ).rejects.toThrow(/not a reserved key/);
  });

  it('upsert preserves STORED createdAt (caller-bumped createdAt is overwritten back)', async () => {
    const { client } = fakeClient();
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };
    await store.put(key, makeRecord({ id: 'id', createdAt: 1000, updatedAt: 0 }));
    await store.put(key, makeRecord({ id: 'id', createdAt: 9999, updatedAt: 2000 }));
    expect((await store.get(key))?.createdAt).toBe(1000);
    expect((await store.get(key))?.updatedAt).toBe(2000);
  });

  it('rejects a key/record identity mismatch and unsafe ids at the Redis boundary', async () => {
    const { client } = fakeClient();
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };
    await expect(
      store.put({ ...key, userId: 'attacker' }, makeRecord({ id: 'id', userId: 'u' })),
    ).rejects.toThrow(/must match the session key/);
    await expect(
      store.put(
        { tenantId: 'tenant-1', userId: 'user-1', sessionId: '*' },
        makeRecord({ id: 'ok', tenantId: 'tenant-1', userId: 'user-1' }),
      ),
    ).rejects.toThrow(/Invalid session key/);
    await expect(store.get({ tenantId: 'tenant-1', userId: 'user-1', sessionId: '*' })).rejects.toThrow(/Invalid session key/);
    await expect(store.list({ tenantId: 'tenant-1', userId: '*' })).rejects.toThrow(/Invalid session list scope/);
  });

  it('drops schema-valid but identity-mismatched blobs on read (read-path re-bind, adv. re-run Minor L2)', async () => {
    const map = new Map<string, unknown>();
    const { client } = fakeClient(map);
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };

    // A schema-valid blob whose OWN identity does NOT match the key it lives under
    // (e.g. hand-edited Redis / bad migration): schema passes, bind fails → null.
    map.set('harness:session:tenant-1:user-1:id', {
      id: 'id',
      tenantId: 'tenant-1',
      userId: 'other-user', // identity mismatch
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      meta: {},
    });
    await expect(store.get(key)).resolves.toBeNull();
    expect(await store.list({ tenantId: 'tenant-1', userId: 'user-1' })).toEqual([]);

    // Same for tenant off-by-one and session-id mismatch.
    map.clear();
    map.set('harness:session:tenant-1:user-1:id', makeRecord({ id: 'id', tenantId: 'tenant-9', updatedAt: 1 }));
    await expect(store.get(key)).resolves.toBeNull();
    map.set('harness:session:tenant-1:user-1:id', makeRecord({ id: 'different', updatedAt: 1 }));
    await expect(store.get(key)).resolves.toBeNull();
  });

  it('memory double mirrors the read-path identity re-bind (fail closed)', async () => {
    const s = new MemorySessionStore();
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };
    await s.put(key, makeRecord({ id: 'id' }));
    // A valid record under its own key still round-trips.
    expect((await s.get(key))?.id).toBe('id');
    // Corrupt the double's map directly so it no longer matches its key → get fails closed.
    (s as unknown as { store: Map<string, unknown> }).store.set(
      'harness:session:tenant-1:user-1:other',
      makeRecord({ id: 'other', tenantId: 'tenant-1', userId: 'user-1', updatedAt: 1 }),
    );
    expect((await s.get({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'other' }))?.id).toBe('other');
    // A record bound to a DIFFERENT sessionId than its key is dropped from list/get.
    (s as unknown as { store: Map<string, unknown> }).store.set(
      'harness:session:tenant-1:user-1:stray',
      makeRecord({ id: 'not_the_key', updatedAt: 1 }),
    );
    expect(
      (await s.list({ tenantId: 'tenant-1', userId: 'user-1' })).map((r) => r.id),
    ).toEqual(['id', 'other']);
    await expect(
      s.get({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'stray' }),
    ).resolves.toBeNull();
  });

  it('trust-but-verifies reads from Redis: corrupt blobs yield null / are skipped (adv. minor L1)', async () => {
    const map = new Map<string, unknown>();
    const { client } = fakeClient(map);
    const store = new RedisSessionStore({ client });
    const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'id' };

    // Hand-edited / corrupt value (unknown meta key) under a well-formed key.
    map.set('harness:session:tenant-1:user-1:id', {
      id: 'id',
      userId: 'user-1',
      tenantId: 'tenant-1',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      meta: { smuggled: 1 },
    });
    await expect(store.get(key)).resolves.toBeNull();

    // A valid sibling plus a corrupt one: list skips the corrupt blob.
    await store.put(key, makeRecord({ id: 'id', updatedAt: 5 }));
    await store.put(
      { tenantId: 'tenant-1', userId: 'user-1', sessionId: 'other' },
      makeRecord({ id: 'other', updatedAt: 5 }),
    );
    map.set('harness:session:tenant-1:user-1:corrupt', { meta: { smuggled: 1 } });
    const ids = (await store.list({ tenantId: 'tenant-1', userId: 'user-1' })).map((r) => r.id).sort();
    expect(ids).toEqual(['id', 'other']);
  });
});

describe('envelope carrier (phase 0 #515)', () => {
  const key = { tenantId: 'tenant-1', userId: 'user-1', sessionId: 's1' };

  it('meta accepts the reserved transcriptPointer key; rejects non-Redis-safe pointers', () => {
    expect(validateMeta({ transcriptPointer: 'tx_abc123' }).ok).toBe(true);
    expect(validateMetaFields({ transcriptPointer: 'tx_abc123' }).ok).toBe(true);
    for (const bad of ['a:b', '*', 'has space', 'x'.repeat(513), 7 as never]) {
      expect(validateMetaFields({ transcriptPointer: bad as never }).ok).toBe(false);
    }
    const rec = makeRecord({ meta: { transcriptPointer: 'tx_abc123' } });
    const res = validateSessionRecord(rec);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.meta.transcriptPointer).toBe('tx_abc123');
  });

  it('plan #800 (B6) — accepts a valid Redis-safe meta.checkpointPointer and DROPS a poisoned one to unset (never 400)', () => {
    // The checkpoint pointer is the sibling of `transcriptPointer` (same Redis-safe
    // opaque rule) but a DISTINCT reserved key — the checkpoint is its own Blob
    // surface, never folded into the transcript pointer. The BODY never rides in meta.
    const ok = validateSessionRecord(
      makeRecord({ meta: { checkpointPointer: 'cp_abc-123DEF' } as HarnessSessionRecord['meta'] }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.meta.checkpointPointer).toBe('cp_abc-123DEF');
    expect(validateMeta({ checkpointPointer: 'cp_abc123' }).ok).toBe(true);

    // Poisoned / null / non-opaque (glob, `:`, space, `.`, `/`, over-length, non-string)
    // are DROPPED to unset (the key is omitted) — the record still validates, never 400s
    // (same drop-to-unset decision as the A1–A3 turn carriers).
    for (const bad of [
      'cp a:b',
      '*',
      'a?b',
      'has space',
      'a.b',
      'cp/abc',
      'x'.repeat(513),
      42 as unknown,
      undefined as unknown,
      null as unknown,
    ]) {
      const res = validateSessionRecord(
        makeRecord({ meta: { checkpointPointer: bad } as HarnessSessionRecord['meta'] }),
      );
      expect(res.ok).toBe(true); // drop-to-unset, not a 400
      if (res.ok) {
        expect('checkpointPointer' in res.value.meta).toBe(false);
        expect(res.value.meta.checkpointPointer).toBeUndefined();
      }
    }

    // The reserved-key contract is intact: unknown keys are STILL rejected.
    expect(
      validateSessionRecord(makeRecord({ meta: { notReserved: 1 } as HarnessSessionRecord['meta'] })).ok,
    ).toBe(false);
  });

  it('plan #800 (B6) — validateMeta round-trips checkpointPointer and omits poison; distinct from transcriptPointer', () => {
    const ok = validateMeta({ checkpointPointer: 'cp_abc123-def' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.checkpointPointer).toBe('cp_abc123-def');

    // Poisoned / oversized / non-opaque → `meta` is ok but the key is omitted.
    const poison = validateMeta({ checkpointPointer: 'x'.repeat(513) });
    expect(poison.ok).toBe(true);
    if (poison.ok) expect('checkpointPointer' in poison.value).toBe(false);
    const nonOpaque = validateMeta({ checkpointPointer: 'a:b' });
    expect(nonOpaque.ok).toBe(true);
    if (nonOpaque.ok) expect('checkpointPointer' in nonOpaque.value).toBe(false);

    // Envelope path shares the same drop-to-unset, never a 400.
    const env = validateSessionEnvelope({ ...makeRecord(), meta: { checkpointPointer: 'a b' } });
    expect(env.ok).toBe(true);
    if (env.ok) expect('checkpointPointer' in env.value.meta).toBe(false);

    // Sibling keys coexist independently — the checkpoint pointer is distinct from the
    // transcript pointer, and a poisoned checkpoint pointer never disturbs a valid one.
    const both = validateSessionRecord(
      makeRecord({
        meta: { transcriptPointer: 'tx_1', checkpointPointer: 'cp_1' } as HarnessSessionRecord['meta'],
      }),
    );
    expect(both.ok).toBe(true);
    if (both.ok) {
      expect(both.value.meta.transcriptPointer).toBe('tx_1');
      expect(both.value.meta.checkpointPointer).toBe('cp_1');
    }
    const mixed = validateSessionRecord(
      makeRecord({
        meta: { transcriptPointer: 'tx_1', checkpointPointer: 'a:b' } as HarnessSessionRecord['meta'],
      }),
    );
    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.value.meta.transcriptPointer).toBe('tx_1');
      expect('checkpointPointer' in mixed.value.meta).toBe(false);
    }
  });

  it('meta.accepts attachedSkills as a JSON-encoded string of slugs (#514)', () => {
    expect(validateMeta({ attachedSkills: ["create-plan"] }).ok).toBe(false);
    expect(validateMeta({ attachedSkills: '["create-plan","v11"]' }).ok).toBe(true);
    expect(validateMetaFields({ attachedSkills: '["create-plan","v11"]' }).ok).toBe(true);
    // raw array (scalar-only envelope) fails closed
    expect(validateMetaFields({ attachedSkills: ['"create-plan"' ] as never }).ok).toBe(false);
    // non-array / malformed / empty-slug JSON fails closed
    for (const bad of ['not-json', '{}', '"just-a-string"', '[1]', '[""]', '   ']) {
      expect(validateMetaFields({ attachedSkills: bad }).ok).toBe(false);
    }
    const rec = makeRecord({ meta: { attachedSkills: '["create-plan"]' } });
    const res = validateSessionRecord(rec);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.meta.attachedSkills).toBe('["create-plan"]');
  });

  it('meta.attachedSkills rejects non-slug strings and over-count (review #525 Minor L1)', () => {
    // Each entry must be a valid skill slug (`SKILL_SLUG_RE`, single source in caps).
    expect(validateMetaFields({ attachedSkills: '["../x"]' }).ok).toBe(false);
    expect(validateMetaFields({ attachedSkills: '["HAS SPACE"]' }).ok).toBe(false);
    expect(validateMetaFields({ attachedSkills: '["Upper/Case"]' }).ok).toBe(false);
    expect(validateMetaFields({ attachedSkills: '["has:colon"]' }).ok).toBe(false);
    expect(validateMetaFields({ attachedSkills: '["-noleadingletter"]' }).ok).toBe(false);
    expect(validateMetaFields({ attachedSkills: '["A"]' }).ok).toBe(false); // uppercase start illegal
    // Valid slugs pass (single lowercase letter is a legal slug).
    expect(validateMetaFields({ attachedSkills: '["a","create-plan","review_2","x9"]' }).ok).toBe(true);
    // A hard count cap prevents an unbounded slug list from being stuffed into meta.
    const many = Array.from({ length: HARNESS_SESSION_MAX_ATTACHED_SKILLS + 1 }, (_, i) => `skill_${i}`);
    expect(validateMetaFields({ attachedSkills: JSON.stringify(many) }).ok).toBe(false);
    const atCap = Array.from({ length: HARNESS_SESSION_MAX_ATTACHED_SKILLS }, (_, i) => `skill_${i}`);
    expect(validateMetaFields({ attachedSkills: JSON.stringify(atCap) }).ok).toBe(true);
  });

  it('meta.usage accepts a clean JSON-string summary and never 400s on poison', () => {
    const clean = JSON.stringify({ source: 'provider', prompt: 12, completion: 3, total: 15 });
    const ok = validateMeta({ usage: clean });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.usage).toBe(clean);
    }
    const rec = validateSessionRecord(makeRecord({ meta: { usage: clean } }));
    expect(rec.ok).toBe(true);
    if (rec.ok) expect(rec.value.meta.usage).toBe(clean);

    // Object / number / bad JSON / non-provider / oversize-poison → ok, key absent.
    for (const bad of [
      { source: 'provider', prompt: 1 },
      12,
      '{not json',
      JSON.stringify({ source: 'estimated', prompt: 9 }),
      JSON.stringify({ source: 'provider' }),
    ]) {
      const res = validateMeta({ usage: bad });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.usage).toBeUndefined();
      expect(validateMetaFields({ usage: bad as never }).ok).toBe(true);
    }

    // Unknown keys still 400.
    expect(validateMeta({ usage: clean, sneaky: 1 }).ok).toBe(false);
  });

  it('validateSessionEnvelope validates ownership + LWW updatedAt + reserved meta (never messages)', () => {
    expect(validateSessionEnvelope({ ...makeRecord(), messages: [] }).ok).toBe(true);
    expect(
      validateSessionEnvelope({
        id: 'sess_abc',
        tenantId: 'tenant-1',
        userId: 'user-1',
        createdAt: 1000,
        updatedAt: 5,
        meta: { transcriptPointer: 'tx_abc123' },
      }).ok,
    ).toBe(true);
    // unknown meta key rejected
    expect(
      validateSessionEnvelope({ ...makeRecord(), meta: { sneaky: 1 } }).ok,
    ).toBe(false);
    // non-Redis-safe pointer rejected
    expect(
      validateSessionEnvelope({
        ...makeRecord(),
        meta: { transcriptPointer: 'a:b' },
      }).ok,
    ).toBe(false);
    // invalid updatedAt rejected
    expect(validateSessionEnvelope({ ...makeRecord(), updatedAt: -1 }).ok).toBe(false);
  });

  it('plan #800 (B6) — MemorySessionStore: envelope round-trips meta.checkpointPointer (stored, read back; body never in meta)', async () => {
    const s = new MemorySessionStore();
    const up = await s.upsertEnvelope(key, {
      id: 's1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      updatedAt: 100,
      meta: { transcriptPointer: 'tx_a', checkpointPointer: 'cp_obj1' },
    });
    expect(up.status).toBe('stored');
    const read = await s.readEnvelope(key);
    expect(read?.meta.checkpointPointer).toBe('cp_obj1');
    expect(read?.meta.transcriptPointer).toBe('tx_a');
    // The checkpoint BODY never rides in the envelope `meta` — only the object id does.
    expect((read?.meta as Record<string, unknown>).checkpointBody).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain('{role:'); // no checkpoint body smuggled in
    // A stale write can't clobber the stored pointer via an older LWW.
    const stale = await s.upsertEnvelope(key, {
      id: 's1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      updatedAt: 50,
      meta: { checkpointPointer: 'cp_stale' },
    });
    expect(stale.status).toBe('conflict');
    if (stale.status === 'conflict') expect(stale.server.meta.checkpointPointer).toBe('cp_obj1');
  });

  it('Memory/Redis implement the additive envelope seam (isEnvelopeStore)', async () => {
    expect(isEnvelopeStore(new MemorySessionStore())).toBe(true);
    expect(isEnvelopeStore(new RedisSessionStore({ client: fakeClient().client }))).toBe(true);
  });

  it('MemorySessionStore: upsertEnvelope writes only the envelope; LWW + createdAt preserved', async () => {
    const s = new MemorySessionStore();
    const r1 = await s.upsertEnvelope(key, {
      id: 's1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      updatedAt: 100,
      meta: { transcriptPointer: 'tx_a' },
    });
    expect(r1.status).toBe('stored');
    if (r1.status === 'stored') expect(r1.envelope.meta.transcriptPointer).toBe('tx_a');

    const read1 = await s.readEnvelope(key);
    expect(read1?.updatedAt).toBe(100);
    expect(read1?.meta.transcriptPointer).toBe('tx_a');

    // stale upsert → conflict with server envelope
    const stale = await s.upsertEnvelope(key, {
      id: 's1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      updatedAt: 50,
      meta: { transcriptPointer: 'tx_b' },
    });
    expect(stale.status).toBe('conflict');
    if (stale.status === 'conflict') expect(stale.server.meta.transcriptPointer).toBe('tx_a');

    // newer upsert advances pointer + keeps createdAt
    const createdAtBefore = read1?.createdAt ?? 0;
    const r2 = await s.upsertEnvelope(key, {
      id: 's1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      updatedAt: 200,
      meta: { transcriptPointer: 'tx_b' },
    });
    if (r2.status === 'stored') {
      expect(r2.envelope.meta.transcriptPointer).toBe('tx_b');
      expect(r2.envelope.createdAt).toBe(createdAtBefore);
    }
  });

  it('MemorySessionStore: readEnvelope rolls forward from a legacy whole-blob record', async () => {
    const s = new MemorySessionStore();
    await s.put(key, makeRecord({ id: 's1', updatedAt: 7, meta: { title: 'legacy' } }));
    const env = await s.readEnvelope(key);
    expect(env?.updatedAt).toBe(7);
    expect(env?.meta.title).toBe('legacy');
    expect(env).not.toHaveProperty('messages');
  });

  it('MemorySessionStore: upsertEnvelope rejects identity mismatch', async () => {
    const s = new MemorySessionStore();
    await expect(
      s.upsertEnvelope(key, { id: 'other', userId: 'user-1', tenantId: 'tenant-1', updatedAt: 1 }),
    ).rejects.toThrow(/identity must match/);
  });

  it('RedisSessionStore: envelope written under harness:envelope:… and read back; TTL refresh', async () => {
    const { client, calls, map } = fakeClient();
    const store = new RedisSessionStore({ client, ttlMs: 1500 });
    const key2 = { tenantId: 't', userId: 'u', sessionId: 's' };
    const up = await store.upsertEnvelope(key2, {
      id: 's',
      userId: 'u',
      tenantId: 't',
      updatedAt: 5,
      meta: { transcriptPointer: 'tx_x' },
    });
    expect(up.status).toBe('stored');
    const keyString = envelopeKeyString(key2);
    expect(keyString).toBe('harness:envelope:t:u:s');
    expect(map.has(keyString)).toBe(true);
    expect(calls.at(-1)?.opts).toEqual({ ex: 2 });
    const env = await store.readEnvelope(key2);
    expect(env?.meta.transcriptPointer).toBe('tx_x');
    // legacy whole-blob untouched
    expect(map.has(sessionKeyString(key2))).toBe(false);
  });

  it('RedisSessionStore: LWW on envelope; identity-mismatched envelope fails closed', async () => {
    const mapA = new Map<string, unknown>();
    const { client } = fakeClient(mapA);
    const store = new RedisSessionStore({ client });
    const k = { tenantId: 't', userId: 'u', sessionId: 's' };
    await store.upsertEnvelope(k, { id: 's', userId: 'u', tenantId: 't', updatedAt: 10 });
    const stale = await store.upsertEnvelope(k, {
      id: 's',
      userId: 'u',
      tenantId: 't',
      updatedAt: 5,
    });
    expect(stale.status).toBe('conflict');

    // schema-valid but mis-ownered envelope → read fails closed (null)
    const mapB = new Map<string, unknown>();
    mapB.set('harness:envelope:t:u:s', {
      id: 's',
      userId: 'other',
      tenantId: 't',
      createdAt: 1,
      updatedAt: 1,
      meta: {},
    });
    const store2 = new RedisSessionStore({ client: fakeClient(mapB).client });
    await expect(store2.readEnvelope(k)).resolves.toBeNull();
  });
});

describe('RedisSessionStore — RESP connect lifecycle (adversarial L1/L6)', () => {
  const URL = 'redis://default:secret@connect-lifecycle.test:6379';
  const originalEnv = { ...process.env };

  /** A minimal node-redis-shaped fake whose `connect()` rejects the first time. */
  function buildConnectSimulator(rejectFirst: boolean) {
    let connectCalls = 0;
    const builds = [] as string[];
    const make = (url: string): RedisClientType => {
      builds.push(url);
      const isOpen = { value: false };
      const client = {
        isOpen: false,
        on() {
          return client;
        },
        async connect() {
          connectCalls++;
          if (rejectFirst && connectCalls === 1) {
            throw new Error('CONNECT_FAILED');
          }
          isOpen.value = true;
          client.isOpen = true;
          return client;
        },
        async disconnect() {
          client.isOpen = false;
        },
        async get() {
          return null;
        },
        async set() {
          return 'OK';
        },
        async del() {
          return 0;
        },
        async keys() {
          return [];
        },
      };
      return client as unknown as RedisClientType;
    };
    return { make, builds, connectCount: () => connectCalls };
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    resetRedisClientCacheForTests();
    setRedisClientFactoryForTests(null);
  });

  it('a failed connect is NOT retained in the per-URL cache; the next call rebuilds and retries', async () => {
    const sim = buildConnectSimulator(true /* reject first connect */);
    setRedisClientFactoryForTests(sim.make);
    resetRedisClientCacheForTests();

    const store = new RedisSessionStore({ url: URL }); // no client → real adapter path through redisFor
    const key = { tenantId: 't1', userId: 'u1', sessionId: 's1' };

    // First command: connect() rejects → store.get rejects (surfaced as 503 by the seam).
    await expect(store.get(key)).rejects.toThrow(/CONNECT_FAILED/);
    expect(sim.builds.length).toBe(1);
    expect(sim.connectCount()).toBe(1);

    // Second command: the cache entry was dropped on that rejection, so a fresh client
    // is built and connect() retried (now succeeds) → no sticky poison on a warm isolate.
    await expect(store.get(key)).resolves.toBeNull();
    expect(sim.builds.length).toBe(2);
    expect(sim.connectCount()).toBe(2);
  });

  it('concurrent first-calls for the same URL share ONE in-flight connect (single socket)', async () => {
    let connectResolvers = [] as ((v: unknown) => void)[];
    const builds = [] as string[];
    const factory = (url: string): RedisClientType => {
      builds.push(url);
      const client = {
        isOpen: false,
        on() {
          return client;
        },
        async connect() {
          await new Promise((resolve) => connectResolvers.push(resolve));
          client.isOpen = true;
          return client;
        },
        async disconnect() {
          client.isOpen = false;
        },
        async get() {
          return null;
        },
        async set() {
          return 'OK';
        },
        async del() {
          return 0;
        },
        async keys() {
          return [];
        },
      };
      return client as unknown as RedisClientType;
    };
    setRedisClientFactoryForTests(factory);
    resetRedisClientCacheForTests();

    const store = new RedisSessionStore({ url: URL });
    const key = { tenantId: 't1', userId: 'u1', sessionId: 'a' };
    const p1 = store.get(key);
    const p2 = store.get(key);
    // Both requests resolve the SAME cached in-flight promise → exactly one factory build.
    expect(builds.length).toBe(1);
    for (const r of connectResolvers.splice(0)) r(undefined);
    await p1;
    await p2;
    expect(builds.length).toBe(1);
  });
});
