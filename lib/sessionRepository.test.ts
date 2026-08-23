import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HARNESS_SESSION_MAX_BODY_BYTES,
  HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES,
  HARNESS_SESSION_MAX_MSG_BYTES,
} from './sessionCloudCaps';
import {
  createHttpSessionRepository,
  isEmptyOfDialogue,
  mergeAdoptedUsage,
  overlayEnvelopeMeta,
  parseCloudSessionSnapshot,
  parseSessionSummaryList,
  shouldAdoptServer,
  trimForCloudPut,
  cloudMetaFor,
  truncateUtf8,
  utf8ByteLength,
  type SessionSummary,
} from './sessionRepository';
import type { SessionSnapshot } from './sessionStore';

function snap(
  partial: Partial<SessionSnapshot> & { messages?: SessionSnapshot['messages'] },
): SessionSnapshot {
  return {
    id: partial.id ?? 'sess_test',
    updatedAt: partial.updatedAt ?? 1000,
    messages: partial.messages ?? [],
  };
}

describe('trimForCloudPut', () => {
  it('folds cwd + activeSandboxId into meta; drops host-absolute cwd / non-Redis-safe sandbox', () => {
    const out = trimForCloudPut({
      id: 'sess_a',
      updatedAt: 42,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
      cwd: 'workspace',
      activeSandboxId: 'sbx_abc123',
    });
    expect(out).toEqual({
      id: 'sess_a',
      updatedAt: 42,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
      meta: { logicalCwd: 'workspace', activeSandboxId: 'sbx_abc123' },
    });
    // no local-only carrier fields leak onto the wire body
    expect('cwd' in out).toBe(false);
    expect('activeSandboxId' in out).toBe(false);

    // host-absolute cwd + non-Redis-safe sandbox are dropped (fail-open to unset)
    const bad = trimForCloudPut({
      id: 'sess_b',
      updatedAt: 1,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
      cwd: '/etc',
      activeSandboxId: 'a:b',
    });
    expect(bad.meta).toBeUndefined();

    // no meta at all when neither carrier is set
    const bare = trimForCloudPut({ id: 'sess_c', updatedAt: 1, messages: [] });
    expect(bare.meta).toBeUndefined();
  });

  it('folds personaId into meta and drops non-Redis-safe personaId (phase 3 #488)', () => {
    const out = trimForCloudPut({
      id: 'sess_a',
      updatedAt: 2,
      messages: [],
      personaId: 'pers_abc123',
    });
    expect(out.meta).toEqual({ personaId: 'pers_abc123' });
    expect('personaId' in out).toBe(false); // carrier carries in meta, not top-level

    const bad = trimForCloudPut({
      id: 'sess_b',
      updatedAt: 2,
      messages: [],
      personaId: 'bad persona id',
    });
    expect(bad.meta).toBeUndefined();
  });

  it('folds the sticky attachedSlugs into reserved meta.attachedSkills so a host PUT carries the set (review Blocker)', () => {
    // A host PUT after an attach MUST carry the sticky set the server injected,
    // or the next turn's full-record meta rewrite would wipe it (review Blocker).
    const out = trimForCloudPut({
      id: 'sess_a',
      updatedAt: 3,
      messages: [],
      attachedSlugs: ['create-plan', 'review'],
    });
    expect(out.meta).toEqual({ attachedSkills: '["create-plan","review"]' });
    expect('attachedSlugs' in out).toBe(false); // carrier carries in meta, not top-level
  });

  it('detach-all: attachedSlugs:[] persists as "[]" (empty-set value)', () => {
    const out = trimForCloudPut({
      id: 'sess_a',
      updatedAt: 4,
      messages: [],
      attachedSlugs: [],
    });
    expect(out.meta).toEqual({ attachedSkills: '[]' });
  });

  it('undefined attachedSlugs omits the key (host hole = store clear)', () => {
    const out = trimForCloudPut({
      id: 'sess_a',
      updatedAt: 5,
      messages: [],
      cwd: 'w',
    });
    expect(out.meta).toEqual({ logicalCwd: 'w' });
    expect(out.meta?.attachedSkills).toBeUndefined();
  });

  it('folds selectedModel into meta.selectedModel; drops poison / non-self (plan #616)', () => {
    const out = trimForCloudPut({
      id: 'sess_a',
      updatedAt: 6,
      messages: [],
      selectedModel: 'anthropic/claude-a',
    });
    expect(out.meta).toEqual({ selectedModel: 'anthropic/claude-a' });
    expect('selectedModel' in out).toBe(false); // carrier carries in meta, not top-level

    // A poisoned selectedModel sanitizes to undefined → meta omitted entirely.
    const bad = trimForCloudPut({
      id: 'sess_b',
      updatedAt: 6,
      messages: [],
      selectedModel: 'not printable!',
    });
    expect(bad.meta).toBeUndefined();

    // Omitted → no selectedModel key.
    const bare = trimForCloudPut({ id: 'sess_c', updatedAt: 6, messages: [] });
    expect(bare.meta).toBeUndefined();
  });

  it('normalizes escaping `..` out of meta so a record can never diverge from the request cwd (review #453 residual)', () => {
    // A P1-legal-on-record `..` is normalized before it is persisted: it drops out
    // instead of round-tripping `..` into Redis (request sends `.` on any device).
    const escaping = trimForCloudPut({
      id: 'sess_d',
      updatedAt: 1,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
      cwd: '..',
    });
    expect(escaping.meta).toBeUndefined();

    const double = trimForCloudPut({
      id: 'sess_e',
      updatedAt: 1,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
      cwd: 'a/../../b',
    });
    expect(double.meta).toBeUndefined();

    // In-bounds `..` is collapsed to its normalized workspace-relative form (same
    // value the request path sends) — never persisted raw.
    const inBounds = trimForCloudPut({
      id: 'sess_f',
      updatedAt: 1,
      messages: [{ id: 'm1', role: 'user', text: 'hi', at: 1 }],
      cwd: 'a/b/../c',
    });
    expect(inBounds.meta).toEqual({ logicalCwd: 'a/c' });
  });

  it('keeps message count; body trim drops oldest when over the body cap', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `m_${i}`,
      role: 'user' as const,
      text: `t${i}`,
      at: i,
    }));
    const out = trimForCloudPut(snap({ messages }));
    expect(out.messages).toHaveLength(50);
    expect(out.messages[0]?.id).toBe('m_0');
    expect(out.messages.at(-1)?.id).toBe('m_49');
  });

  it('truncates oversize UTF-8 text', () => {
    const text = 'é'.repeat(HARNESS_SESSION_MAX_MSG_BYTES); // 2 bytes each → over cap
    expect(utf8ByteLength(text)).toBeGreaterThan(HARNESS_SESSION_MAX_MSG_BYTES);
    const out = trimForCloudPut(
      snap({
        messages: [{ id: 'm1', role: 'assistant', text, at: 1 }],
      }),
    );
    expect(utf8ByteLength(out.messages[0]!.text)).toBeLessThanOrEqual(
      HARNESS_SESSION_MAX_MSG_BYTES,
    );
  });

  it('default trim targets the Function-safe body cap (rollforward stay ≤ wire-safe, review #525 Blocker)', () => {
    // Each msg text truncates to HARNESS_SESSION_MAX_MSG_BYTES; 40 msgs ≈ 10.5 MiB,
    // far over the default rollforward Function-safe cap (2 MiB).
    const chunk = 'x'.repeat(1_000_000);
    const messages = Array.from({ length: 40 }, (_, i) => ({
      id: `m_${i}`,
      role: 'user' as const,
      text: chunk,
      at: i,
    }));
    // Default (rollforward) trim must land under HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES
    // so a one-shot full-record PUT to `/api/sessions/:id` can never exceed the
    // 4.5 MB Vercel Function payload ceiling (parent #512/#514 lock).
    const out = trimForCloudPut(snap({ messages }));
    const body = JSON.stringify({
      id: out.id,
      updatedAt: out.updatedAt,
      messages: out.messages,
    });
    expect(utf8ByteLength(body)).toBeLessThanOrEqual(HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES);
    expect(out.messages.length).toBeLessThan(40);
    expect(out.messages.at(-1)?.id).toBe('m_39');
  });

  it('explicit object cap lets the larger Blob-object ceiling through (envelope path, review #525 Blocker)', () => {
    // The envelope carrier ferries the transcript object client→Blob (never through a
    // Function), so its trim target is the generous 8 MiB OBJECT ceiling — legal because
    // it is not a Function body.
    const chunk = 'x'.repeat(1_000_000);
    const messages = Array.from({ length: 40 }, (_, i) => ({
      id: `m_${i}`,
      role: 'user' as const,
      text: chunk,
      at: i,
    }));
    const out = trimForCloudPut(snap({ messages }), HARNESS_SESSION_MAX_BODY_BYTES);
    const body = JSON.stringify({
      id: out.id,
      updatedAt: out.updatedAt,
      messages: out.messages,
    });
    // Under the 8 MiB object ceiling but OVER the 2 MiB Function-safe cap — proving the
    // split is real: a large body is only legal as a Blob object, never a Function body.
    expect(utf8ByteLength(body)).toBeLessThanOrEqual(HARNESS_SESSION_MAX_BODY_BYTES);
    expect(utf8ByteLength(body)).toBeGreaterThan(HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES);
    expect(out.messages.length).toBeLessThan(40);
    expect(out.messages.at(-1)?.id).toBe('m_39');
  });
});

describe('truncateUtf8', () => {
  it('preserves short strings', () => {
    expect(truncateUtf8('hello', 100)).toBe('hello');
  });

  it('does not split multi-byte sequences', () => {
    const s = 'aaéé';
    const out = truncateUtf8(s, 4); // a a + partial é
    expect(utf8ByteLength(out)).toBeLessThanOrEqual(4);
    expect(() => out).not.toThrow();
  });
});

describe('shouldAdoptServer / empty dialogue', () => {
  it('detects empty-of-dialogue (system only)', () => {
    expect(
      isEmptyOfDialogue(
        snap({
          messages: [{ id: 's', role: 'system', text: 'welcome', at: 1 }],
        }),
      ),
    ).toBe(true);
    expect(
      isEmptyOfDialogue(
        snap({
          messages: [{ id: 'u', role: 'user', text: 'hi', at: 1 }],
        }),
      ),
    ).toBe(false);
  });

  it('adopts strictly newer server', () => {
    const local = snap({ updatedAt: 100, messages: [{ id: 'u', role: 'user', text: 'a', at: 1 }] });
    const server = snap({
      updatedAt: 200,
      messages: [{ id: 'u', role: 'user', text: 'b', at: 1 }],
    });
    expect(shouldAdoptServer(local, server)).toBe(true);
    expect(shouldAdoptServer(server, local)).toBe(false);
  });

  it('equal updatedAt keeps local', () => {
    const local = snap({ updatedAt: 100, messages: [{ id: 'u', role: 'user', text: 'a', at: 1 }] });
    const server = snap({
      updatedAt: 100,
      messages: [{ id: 'u', role: 'user', text: 'b', at: 1 }],
    });
    expect(shouldAdoptServer(local, server)).toBe(false);
  });

  it('adopts server when local empty-of-dialogue', () => {
    const local = snap({
      updatedAt: 500,
      messages: [{ id: 's', role: 'system', text: 'welcome', at: 1 }],
    });
    const server = snap({
      updatedAt: 100,
      messages: [{ id: 'u', role: 'user', text: 'hi', at: 1 }],
    });
    expect(shouldAdoptServer(local, server)).toBe(true);
  });
});

describe('parseCloudSessionSnapshot', () => {
  it('accepts valid body and rejects junk', () => {
    expect(
      parseCloudSessionSnapshot({
        id: 'sess_x',
        updatedAt: 1,
        messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      }),
    ).toEqual({
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
    });
    expect(parseCloudSessionSnapshot(null)).toBeNull();
    expect(parseCloudSessionSnapshot({ id: 'x', updatedAt: 1, messages: 'nope' })).toBeNull();
  });

  it('accepts and keeps a kind-7 skill_attached row (review #526 re-run 3 Blocker)', () => {
    // After `/foo`, the host PUTs the display-only `skill_attached` kind-7 row.
    // The rollforward GET / envelope transcript GET / 409-adopt parser MUST accept
    // it (and keep the row) or the whole record parses to null → `notfound`/`error`,
    // and the session looks gone on reload / device-switch / adopt.
    const body = {
      id: 'sess_x',
      updatedAt: 1,
      messages: [
        { id: 'm1', role: 'user', text: 'prompt', at: 1 },
        { id: 'm2', role: 'skill_attached', text: 'Skill attached: create-plan', at: 2 },
      ],
    };
    const out = parseCloudSessionSnapshot(body);
    expect(out).not.toBeNull();
    expect(out?.messages.map((m) => m.role)).toEqual(['user', 'skill_attached']);
    expect(out?.messages[1]?.text).toBe('Skill attached: create-plan');
  });

  it('rejects a record whose id differs from the resource id (confused-deputy)', () => {
    const body = {
      id: 'other-id',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
    };
    expect(parseCloudSessionSnapshot(body, 'expected-id')).toBeNull();
  });

  it('restores cwd + activeSandboxId from stored meta (sanitized, fail-open on poison)', () => {
    const body = {
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      meta: { logicalCwd: 'invincible/src', activeSandboxId: 'sbx_abc123' },
    };
    const out = parseCloudSessionSnapshot(body);
    expect(out?.cwd).toBe('invincible/src');
    expect(out?.activeSandboxId).toBe('sbx_abc123');

    // host-absolute cwd + non-Redis-safe sandbox drop to unset (never a sticky 400)
    const bad = parseCloudSessionSnapshot({
      ...body,
      meta: { logicalCwd: '/etc', activeSandboxId: 'a:b' },
    });
    expect(bad?.cwd).toBeUndefined();
    expect(bad?.activeSandboxId).toBeUndefined();

    // no meta → carrier fields unset
    const bare = parseCloudSessionSnapshot({ id: 's', updatedAt: 1, messages: [] });
    expect(bare?.cwd).toBeUndefined();
    expect(bare?.activeSandboxId).toBeUndefined();
  });

  it('restores personaId from stored meta.personaId; drops non-Redis-safe (phase 3 #488)', () => {
    const out = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      meta: { personaId: 'pers_1' },
    });
    expect(out?.personaId).toBe('pers_1');

    const bad = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      meta: { personaId: 'bad persona id' },
    });
    expect(bad?.personaId).toBeUndefined();
  });

  it('plan #616 — restores selectedModel from stored meta.selectedModel; drops poison to unset', () => {
    const out = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      meta: { selectedModel: 'anthropic/claude-a' },
    });
    expect(out?.selectedModel).toBe('anthropic/claude-a');

    // Poisoned / invalid → dropped to unset (never a sticky poison).
    const bad = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      meta: { selectedModel: 'not printable!' },
    });
    expect(bad?.selectedModel).toBeUndefined();

    // Omitted meta.selectedModel → field stays undefined (restore falls back to default).
    const bare = parseCloudSessionSnapshot({ id: 's', updatedAt: 1, messages: [] });
    expect(bare?.selectedModel).toBeUndefined();
  });

  it('backend-agents A1–A3 — restores turnRunId/turnStatus/turnStreamCursor from meta; poison → unset', () => {
    const out = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      meta: { turnRunId: 'run_abc_123', turnStatus: 'running', turnStreamCursor: 42 },
    });
    expect(out?.turnRunId).toBe('run_abc_123');
    expect(out?.turnStatus).toBe('running');
    expect(out?.turnStreamCursor).toBe(42);

    // `completed` is a first-class terminal member — preserved (C15's 409 stays live-only).
    const completed = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [],
      meta: { turnStatus: 'completed' },
    });
    expect(completed?.turnStatus).toBe('completed');

    // `turnStreamCursor=0` is a valid value — preserved (non-vacuous).
    const zero = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [],
      meta: { turnStreamCursor: 0 },
    });
    expect(zero?.turnStreamCursor).toBe(0);

    // Poisoned values (non-opaque run id / unknown enum / NaN / negative / over-cap)
    // drop to unset — never a sticky poison / 400.
    const bad = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [],
      meta: { turnRunId: 'not opaque!', turnStatus: 'RUNNING', turnStreamCursor: -1 },
    });
    expect(bad?.turnRunId).toBeUndefined();
    expect(bad?.turnStatus).toBeUndefined();
    expect(bad?.turnStreamCursor).toBeUndefined();

    const nan = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [],
      meta: { turnStreamCursor: Number.NaN },
    });
    expect(nan?.turnStreamCursor).toBeUndefined();

    // Omitted meta keys → fields stay undefined.
    const bare = parseCloudSessionSnapshot({ id: 's', updatedAt: 1, messages: [] });
    expect(bare?.turnRunId).toBeUndefined();
    expect(bare?.turnStatus).toBeUndefined();
    expect(bare?.turnStreamCursor).toBeUndefined();
  });

  it('restores the sticky attachedSlugs from reserved meta.attachedSkills (fail-closed on poison)', () => {
    const out = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      meta: { attachedSkills: '["create-plan","review"]' },
    });
    expect(out?.attachedSlugs).toEqual(['create-plan', 'review']);

    // `[]` (explicit detach-all) restores as an empty sticky set.
    const detached = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [],
      meta: { attachedSkills: '[]' },
    });
    expect(detached?.attachedSlugs).toEqual([]);

    // Malformed / foreign slug → fail-closed [] (never a sticky poison).
    const bad = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [],
      meta: { attachedSkills: 'not-json' },
    });
    expect(bad?.attachedSlugs).toEqual([]);

    // Omitted meta.attachedSkills → field stays undefined (not cleared).
    const bare = parseCloudSessionSnapshot({ id: 's', updatedAt: 1, messages: [] });
    expect(bare?.attachedSlugs).toBeUndefined();
  });

  it('normalizes an already-persisted escaping cwd on adopt/parse (review #453 residual)', () => {
    // A pre-fix record may still hold `..` in meta.logicalCwd; parsing must adopt
    // it with the same normalization the trim/request paths apply so the in-memory
    // snapshot never carries a value the agent cannot accept.
    const escaping = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      meta: { logicalCwd: '..' },
    });
    expect(escaping?.cwd).toBeUndefined();

    const inBounds = parseCloudSessionSnapshot({
      id: 'sess_y',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      meta: { logicalCwd: 'a/b/../c' },
    });
    expect(inBounds?.cwd).toBe('a/c');
  });

  it('restores usage from meta.usage; poison / non-provider / bad JSON → unset', () => {
    const clean = {
      source: 'provider' as const,
      prompt: 50,
      completion: 20,
      total: 70,
    };
    const out = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [],
      meta: { usage: JSON.stringify(clean) },
    });
    expect(out?.usage).toEqual(clean);

    const poison = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [],
      meta: { usage: '{nope' },
    });
    expect(poison?.usage).toBeUndefined();

    const estimated = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [],
      meta: { usage: JSON.stringify({ source: 'estimated', prompt: 9 }) },
    });
    expect(estimated?.usage).toBeUndefined();

    const nonString = parseCloudSessionSnapshot({
      id: 'sess_x',
      updatedAt: 1,
      messages: [],
      meta: { usage: clean },
    });
    expect(nonString?.usage).toBeUndefined();
  });
});

describe('cloudMetaFor usage fold', () => {
  it('folds a sanitized summary; omits when unset', () => {
    const usage = { source: 'provider' as const, prompt: 4, completion: 1, total: 5 };
    const folded = cloudMetaFor({
      id: 's',
      updatedAt: 1,
      messages: [],
      usage,
    });
    expect(folded).toEqual({ usage: JSON.stringify(usage) });
    expect(cloudMetaFor({ id: 's', updatedAt: 1, messages: [] })).toBeUndefined();
  });

  it('usage-only snap still emits meta.usage (empty-conjunction includes usage)', () => {
    const usage = { source: 'provider' as const, prompt: 2 };
    const meta = cloudMetaFor({ id: 's', updatedAt: 1, messages: [], usage });
    expect(meta?.usage).toBe(JSON.stringify(usage));
    expect(meta?.logicalCwd).toBeUndefined();
    expect(trimForCloudPut({ id: 's', updatedAt: 1, messages: [], usage }).meta).toEqual({
      usage: JSON.stringify(usage),
    });
  });

  it('backend-agents A1–A3 — folds the three turn carriers; omits when poison; completed + 0 preserved', () => {
    const meta = cloudMetaFor({
      id: 's',
      updatedAt: 1,
      messages: [],
      turnRunId: 'run_1',
      turnStatus: 'running',
      turnStreamCursor: 7,
    } as SessionSnapshot);
    expect(meta).toEqual({ turnRunId: 'run_1', turnStatus: 'running', turnStreamCursor: 7 });

    // Carrier fields ride in meta, not at the top level (cloud PUT wire shape).
    expect('turnRunId' in (cloudMetaFor({ id: 's', updatedAt: 1, messages: [], turnRunId: 'r_1' }) ?? {}))
      .toBe(true);

    // `completed` is a first-class terminal member (preserved); cursor 0 is valid.
    const terminal = cloudMetaFor({
      id: 's',
      updatedAt: 1,
      messages: [],
      turnStatus: 'completed',
      turnStreamCursor: 0,
    } as SessionSnapshot);
    expect(terminal).toEqual({ turnStatus: 'completed', turnStreamCursor: 0 });

    // A carrier unset → that key omitted (absent = clear contract intact).
    const partial = cloudMetaFor({ id: 's', updatedAt: 1, messages: [], turnRunId: 'run_2' });
    expect(partial).toEqual({ turnRunId: 'run_2' });

    // Poisoned carrier values drop-to-unset and are omitted (never a sticky 400).
    const poisoned = cloudMetaFor({
      id: 's',
      updatedAt: 1,
      messages: [],
      turnRunId: 'not opaque!',
      turnStatus: 'RUNNING',
      turnStreamCursor: -5,
    } as unknown as SessionSnapshot);
    expect(poisoned).toBeUndefined();

    // No carriers set → no meta.
    expect(cloudMetaFor({ id: 's', updatedAt: 1, messages: [] })).toBeUndefined();
  });
});

describe('overlayEnvelopeMeta', () => {
  it('envelope values win; absent envelope keys clear transcript (replace)', () => {
    const transcript = {
      id: 's',
      updatedAt: 1,
      messages: [],
      cwd: 'old/path',
      activeSandboxId: 'sbx_old',
      usage: { source: 'provider' as const, prompt: 1 },
      selectedModel: 'anthropic/claude-a',
      attachedSlugs: ['create-plan'],
      personaId: 'pers_old',
    };
    const over = overlayEnvelopeMeta(transcript, {
      activeSandboxId: 'sbx_new',
      logicalCwd: 'new/path',
      usage: JSON.stringify({ source: 'provider', prompt: 9, completion: 1, total: 10 }),
      selectedModel: 'openai/gpt-a',
      attachedSkills: '["plan-review"]',
      personaId: 'pers_new',
    });
    expect(over.activeSandboxId).toBe('sbx_new');
    expect(over.cwd).toBe('new/path');
    expect(over.usage).toEqual({ source: 'provider', prompt: 9, completion: 1, total: 10 });
    expect(over.selectedModel).toBe('openai/gpt-a');
    expect(over.attachedSlugs).toEqual(['plan-review']);
    expect(over.personaId).toBe('pers_new');

    const cleared = overlayEnvelopeMeta(transcript, { transcriptPointer: 'tx_1' });
    expect(cleared.cwd).toBeUndefined();
    expect(cleared.activeSandboxId).toBeUndefined();
    expect(cleared.usage).toBeUndefined();
    expect(cleared.selectedModel).toBeUndefined();
    expect(cleared.attachedSlugs).toBeUndefined();
    expect(cleared.personaId).toBeUndefined();
  });

  it('backend-agents A1–A3 — overlays the three turn carriers; absent/poison clears', () => {
    const transcript: SessionSnapshot = {
      id: 's',
      updatedAt: 1,
      messages: [],
      turnRunId: 'run_old',
      turnStatus: 'running',
      turnStreamCursor: 5,
    };
    // A valid envelope meta wins on all three carriers.
    const over = overlayEnvelopeMeta(transcript, {
      turnRunId: 'run_new',
      turnStatus: 'completed',
      turnStreamCursor: 9,
    });
    expect(over.turnRunId).toBe('run_new');
    expect(over.turnStatus).toBe('completed');
    expect(over.turnStreamCursor).toBe(9);

    // Absent envelope key clears the field (RESERVED_META_KEYS replace contract).
    const cleared = overlayEnvelopeMeta(transcript, { transcriptPointer: 'tx_1' });
    expect(cleared.turnRunId).toBeUndefined();
    expect(cleared.turnStatus).toBeUndefined();
    expect(cleared.turnStreamCursor).toBeUndefined();

    // Poison envelope values also clear.
    const poison = overlayEnvelopeMeta(transcript, {
      turnRunId: 'bad:id',
      turnStatus: 'Running',
      turnStreamCursor: -1,
    });
    expect(poison.turnRunId).toBeUndefined();
    expect(poison.turnStatus).toBeUndefined();
    expect(poison.turnStreamCursor).toBeUndefined();

    // Mid-turn one-key update: a writer that copies the prior meta forward keeps the
    // unchanged siblings (copy-then-override, so one-key meta cannot clear them).
    const sibling = overlayEnvelopeMeta(transcript, {
      turnRunId: 'run_old',
      turnStatus: 'cancelling',
      turnStreamCursor: 5,
    });
    expect(sibling.turnRunId).toBe('run_old');
    expect(sibling.turnStatus).toBe('cancelling');
    expect(sibling.turnStreamCursor).toBe(5);
  });

  it('backend-agents A4 — fold → parse → overlay round-trips all three carriers; poison never sticks', () => {
    const snap: SessionSnapshot = {
      id: 's',
      updatedAt: 1,
      messages: [{ id: 'm', role: 'user', text: 't', at: 1 }],
      turnRunId: 'run_abc',
      turnStatus: 'completed',
      turnStreamCursor: 12,
    };
    // Fold → the reserved meta the envelope PUT carries.
    const meta = cloudMetaFor(snap);
    expect(meta).toEqual({ turnRunId: 'run_abc', turnStatus: 'completed', turnStreamCursor: 12 });

    // Restore from the transcript body (parse) then overlay the envelope meta — the
    // same two-step the envelope read does (getEnvelope → parse + overlay).
    const parsed = parseCloudSessionSnapshot({ ...snap, meta });
    const round = overlayEnvelopeMeta(parsed!, meta);
    expect(round.turnRunId).toBe('run_abc');
    expect(round.turnStatus).toBe('completed');
    expect(round.turnStreamCursor).toBe(12);

    // A poisoned envelope meta can never stick a carrier through the round trip.
    const poisonedEnv = overlayEnvelopeMeta(round, {
      turnRunId: 'bad:id',
      turnStatus: 'Running',
      turnStreamCursor: Number.POSITIVE_INFINITY,
    });
    expect(poisonedEnv.turnRunId).toBeUndefined();
    expect(poisonedEnv.turnStatus).toBeUndefined();
    expect(poisonedEnv.turnStreamCursor).toBeUndefined();
  });
});

describe('mergeAdoptedUsage (plan #626 test 5)', () => {
  const usageA = { source: 'provider' as const, prompt: 42, completion: 10, total: 52 };
  const usageB = { source: 'provider' as const, prompt: 8, completion: 2, total: 10 };

  it('same id: server has usage → server wins', () => {
    const out = mergeAdoptedUsage(
      { id: 'a', updatedAt: 10, messages: [], usage: usageA },
      { id: 'a', updatedAt: 5, messages: [], usage: usageB },
    );
    expect(out.usage).toEqual(usageA);
    expect(out.updatedAt).toBe(10);
  });

  it('same id: server has no usage → keep local', () => {
    const out = mergeAdoptedUsage(
      { id: 'a', updatedAt: 10, messages: [] },
      { id: 'a', updatedAt: 5, messages: [], usage: usageA },
    );
    expect(out.usage).toEqual(usageA);
    expect(out.updatedAt).toBe(10);
  });

  it('same id: neither has usage → undefined', () => {
    const out = mergeAdoptedUsage(
      { id: 'a', updatedAt: 10, messages: [] },
      { id: 'a', updatedAt: 5, messages: [] },
    );
    expect(out.usage).toBeUndefined();
  });

  it('different id: server-only (no merge)', () => {
    const out = mergeAdoptedUsage(
      { id: 'b', updatedAt: 10, messages: [] },
      { id: 'a', updatedAt: 5, messages: [], usage: usageA },
    );
    expect(out.usage).toBeUndefined();
    expect(out.id).toBe('b');
  });

  it('different id: server has usage → keep server', () => {
    const out = mergeAdoptedUsage(
      { id: 'b', updatedAt: 10, messages: [], usage: usageA },
      { id: 'a', updatedAt: 5, messages: [], usage: usageB },
    );
    expect(out.usage).toEqual(usageA);
    expect(out.id).toBe('b');
  });
});

describe('parseSessionSummaryList', () => {
  it('parses summaries with optional title', () => {
    const out = parseSessionSummaryList([
      { id: 'a', createdAt: 1, updatedAt: 2, title: 'title' },
      { id: 'b' },
    ]);
    expect(out).toEqual([
      { id: 'a', createdAt: 1, updatedAt: 2, title: 'title' },
      { id: 'b' },
    ] satisfies SessionSummary[]);
  });

  it('rejects list with a malformed row', () => {
    expect(parseSessionSummaryList([{ id: 'a' }, { updatedAt: 3 }])).toBeNull();
    expect(parseSessionSummaryList('nope')).toBeNull();
  });
});

describe('createHttpSessionRepository (id-shaped)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';

  function record(id: string, upto: number, messages = [{ id: 'm1', role: 'user' as const, text: 'hi', at: 1 }]) {
    return { id, updatedAt: upto, messages };
  }

  it('create() mints distinct server ids (createFirst mints the first)', async () => {
    const created: SessionSnapshot[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        const id = crypto.randomUUID();
        const s = { id, updatedAt: 0, messages: [] };
        created.push(s);
        return Response.json(s);
      }
      return Response.json(record(idA, 1), { status: 200 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    const first = await repo.createFirst();
    const second = await repo.create();
    expect(first.action).toBe('ok');
    expect(second.action).toBe('ok');
    expect(first.action === 'ok' && second.action === 'ok').toBe(true);
    if (first.action === 'ok' && second.action === 'ok') {
      expect(first.snapshot.id).not.toBe(second.snapshot.id);
      expect(first.snapshot.messages).toHaveLength(0);
    }
  });

  it('put() coalesces per session and writes body id == path id == snapshot.id', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT') {
        calls.push({ url: String(_url), body: JSON.parse(String(init?.body)) });
        return Response.json(record(idA, 10, [{ id: 'm', role: 'user', text: 'x', at: 1 }]), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    let local = snap({ id: idA, updatedAt: 10, messages: [{ id: 'm', role: 'user', text: 'x', at: 1 }] });
    repo.put(idA, local);
    local = { ...local, updatedAt: 20, messages: [{ id: 'm', role: 'user', text: 'y', at: 2 }] };
    repo.put(idA, local);
    local = { ...local, updatedAt: 30, messages: [{ id: 'm', role: 'user', text: 'z', at: 3 }] };
    repo.put(idA, local);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    // Every PUT resolved to the canonical resource + body.id == idA.
    for (const c of calls) {
      expect(c.url).toBe(`/api/sessions/${idA}`);
      expect((c.body as { id: string }).id).toBe(idA);
    }
    // Last (pending) is the newest snapshot.
    expect((calls.at(-1)!.body as { messages: { text: string }[] }).messages.at(-1)!.text).toBe(
      'z',
    );
  });

  it('put() fails closed when snapshot.id != resource id (no network call)', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const repo = createHttpSessionRepository({ fetchImpl });
    repo.put(idB, snap({ id: idA }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('remove() issues DELETE for that id only and not others', async () => {
    const dels: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'DELETE') dels.push(String(url));
      return Response.json(record(idA, 1), { status: 200 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    await repo.remove(idA);
    expect(dels).toEqual([`/api/sessions/${idA}`]);
  });

  it('remove() during in-flight PUT issues a compensatory DELETE after PUT lands', async () => {
    let resolvePut!: (r: Response) => void;
    const putGate = new Promise<Response>((r) => {
      resolvePut = r;
    });
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'PUT') return putGate;
      return new Response(null, { status: 204 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    repo.put(idA, snap({ id: idA, updatedAt: 1 }));
    await Promise.resolve();
    expect(calls.some((c) => c.startsWith('PUT'))).toBe(true);
    await repo.remove(idA);
    expect(calls.filter((c) => c.startsWith('DELETE')).length).toBe(1);
    resolvePut(Response.json(record(idA, 1, []), { status: 200 }));
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.startsWith('DELETE')).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('epoch guard prevents Clear (remove) from resurrecting', async () => {
    let resolvePut!: (r: Response) => void;
    const putGate = new Promise<Response>((r) => {
      resolvePut = r;
    });
    const puts: string[] = [];
    const dels: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PUT') {
        puts.push(String(url));
        return putGate;
      }
      if (method === 'DELETE') dels.push(String(url));
      return Response.json(record(idA, 1), { status: 200 });
    });
    const repo = createHttpSessionRepository({ fetchImpl });
    repo.put(idA, snap({ id: idA, updatedAt: 1 }));
    await Promise.resolve();
    await repo.remove(idA);
    // Pending cleared → no further PUT fires after remove (only the original in-flight).
    resolvePut(Response.json(record(idA, 1, []), { status: 200 }));
    await vi.waitFor(() => expect(dels.length).toBeGreaterThanOrEqual(2));
    expect(puts).toHaveLength(1);
  });

  it('409 on put adopts server body via onAdopt', async () => {
    const server = { id: idA, updatedAt: 300, messages: [{ id: 'm', role: 'user', text: 'win', at: 1 }] };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return Response.json(server, { status: 409 });
      return new Response(null, { status: 204 });
    });
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({ fetchImpl, onAdopt });
    repo.put(idA, snap({ id: idA, updatedAt: 100, messages: [] }));
    await vi.waitFor(() => expect(onAdopt).toHaveBeenCalledWith(server));
  });

  it('409 adopt is refused when live active session is a different id (switch mid-put)', async () => {
    const server = {
      id: idA,
      updatedAt: 300,
      messages: [{ id: 'm', role: 'user', text: 'win', at: 1 }],
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return Response.json(server, { status: 409 });
      return new Response(null, { status: 204 });
    });
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({
      fetchImpl,
      onAdopt,
      // Simulates the active session being a *different* one while PUT(A) is in flight.
      getLocal: () => snap({ id: idB, updatedAt: 50, messages: [] }),
    });
    repo.put(idA, snap({ id: idA, updatedAt: 100, messages: [] }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it('409 adopt still fires when the live active session matches the put target id', async () => {
    const server = {
      id: idA,
      updatedAt: 300,
      messages: [{ id: 'm', role: 'user', text: 'win', at: 1 }],
    };
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return Response.json(server, { status: 409 });
      return new Response(null, { status: 204 });
    });
    const onAdopt = vi.fn();
    const repo = createHttpSessionRepository({
      fetchImpl,
      onAdopt,
      getLocal: () => snap({ id: idA, updatedAt: 100, messages: [] }),
    });
    repo.put(idA, snap({ id: idA, updatedAt: 100, messages: [] }));
    await vi.waitFor(() => expect(onAdopt).toHaveBeenCalledWith(server));
  });

  it('401 disables the repository', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'auth' }, { status: 401 }));
    const repo = createHttpSessionRepository({ fetchImpl });
    const res = await repo.get(idA);
    expect(res.action).toBe('disabled');
    expect(repo.enabled).toBe(false);
  });

  it('get() returns notfound on 404 (and leaves the repo enabled)', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'missing', code: 'NOT_FOUND' }, { status: 404 }),
    );
    const repo = createHttpSessionRepository({ fetchImpl });
    expect((await repo.get(idA)).action).toBe('notfound');
    expect(repo.enabled).toBe(true);
  });

  it('get() fails closed when the fetched id does not match the requested id', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(record(idB, 1, [{ id: 'm', role: 'user', text: 'x', at: 1 }]), { status: 200 }),
    );
    const repo = createHttpSessionRepository({ fetchImpl });
    const res = await repo.get(idA);
    expect(res.action).toBe('error');
  });

  it('list() returns summaries', async () => {
    const summary: SessionSummary[] = [{ id: idA, updatedAt: 1, title: 't' }];
    const fetchImpl = vi.fn(async () => Response.json(summary, { status: 200 }));
    const repo = createHttpSessionRepository({ fetchImpl });
    const res = await repo.list();
    expect(res.action).toBe('ok');
    if (res.action === 'ok') expect(res.sessions).toEqual(summary);
  });
});

describe('createHttpSessionRepository — envelope carrier (phase 0 #515)', () => {
  const idA = '11111111-1111-4111-8111-111111111111';
  const UPLOAD_URL = 'https://blob.example/upload';

  /** Routes fetches like the live server: mint → client→Blob → envelope. */
  function envelopeFetch(opts: { uploadStatus?: number } = {}) {
    const calls: string[] = [];
    const putBody: unknown[] = [];
    const mints: string[] = [];
    const uploadStatus = opts.uploadStatus ?? 200;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${u}`);
      if (method === 'POST' && u.endsWith('/transcript')) {
        mints.push(u);
        return Response.json({ uploadUrl: UPLOAD_URL, objectId: 'tx_obj1' }, { status: 200 });
      }
      if (u === UPLOAD_URL) {
        putBody.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: uploadStatus });
      }
      if (u.startsWith('https://blob.example/') && method === 'GET') {
        // Signed client→Blob read of the transcript object.
        return Response.json(
          {
            id: idA,
            updatedAt: 30,
            messages: [{ id: 'm', role: 'user', text: 'hi', at: 1 }],
            meta: {},
          },
          { status: 200 },
        );
      }
      if (method === 'GET' && u.endsWith('/envelope')) {
        // echo back only the object the session envelope points to
        return Response.json(
          {
            id: idA,
            updatedAt: 30,
            meta: { transcriptPointer: 'tx_obj1' },
            transcriptReadUrl: `${UPLOAD_URL}/read?obj=tx_obj1`,
          },
          { status: 200 },
        );
      }
      if (method === 'PUT' && u.endsWith('/envelope')) {
        putBody.push(JSON.parse(String(init?.body)));
        return Response.json({ id: idA }, { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    return { fetchImpl, calls, putBody, mints };
  }

  it('carrier getter reflects opts.carrier; default is roll-forward', () => {
    expect(createHttpSessionRepository({ carrier: 'envelope' }).carrier).toBe('envelope');
    expect(createHttpSessionRepository().carrier).toBe('rollforward');
    expect(createHttpSessionRepository({ carrier: 'rollforward' }).carrier).toBe('rollforward');
  });

  it('put() on the envelope carrier does mint → client→Blob → pushEnvelope; never a full-record PUT', async () => {
    const { fetchImpl, calls, putBody, mints } = envelopeFetch();
    const repo = createHttpSessionRepository({ fetchImpl, carrier: 'envelope' });
    const local = snap({
      id: idA,
      updatedAt: 30,
      messages: [{ id: 'm', role: 'user', text: 'hi', at: 1 }],
      cwd: 'workspace',
    });
    repo.put(idA, local);
    await vi.waitFor(() => {
      expect(mints.length).toBeGreaterThanOrEqual(1);
    });
    await vi.waitFor(() => {
      expect(putBody.length).toBeGreaterThanOrEqual(2); // Blob object + envelope
    });
    // No one-shot full-record PUT against `/api/sessions/:id` on the hot path.
    expect(calls.some((c) => c.startsWith('PUT /api/sessions/') && !c.includes('/envelope'))).toBe(
      false,
    );
    // The Blob object stores the full record shape; the envelope carries the pointer.
    const [blobBody, envBody] = putBody as [Record<string, unknown>, Record<string, unknown>];
    expect(blobBody.id).toBe(idA);
    expect((blobBody.messages as { text: string }[])[0]).toMatchObject({ text: 'hi' });
    expect(envBody).toMatchObject({ id: idA, updatedAt: 30 });
    expect((envBody.meta as { transcriptPointer: string }).transcriptPointer).toBe('tx_obj1');
  });

  it('fail-closed: non-2xx client→Blob upload does NOT advance the envelope pointer (reader Minor L1)', async () => {
    const { fetchImpl, calls, putBody, mints } = envelopeFetch({ uploadStatus: 500 });
    const repo = createHttpSessionRepository({ fetchImpl, carrier: 'envelope' });
    repo.put(idA, snap({ id: idA, updatedAt: 1, messages: [] }));
    await vi.waitFor(() => expect(mints.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 10));
    // Exactly one client→Blob attempt; zero envelope PUTs (pointer must not advance).
    expect(calls.filter((c) => c === `PUT ${UPLOAD_URL}`)).toHaveLength(1);
    expect(calls.some((c) => c.endsWith('/envelope') && c.startsWith('PUT'))).toBe(false);
    expect(calls.some((c) => c.startsWith('PUT /api/sessions/') && !c.includes('/envelope'))).toBe(
      false,
    );
    void putBody;
  });

  it('get() on the envelope carrier reads envelope → transcript object and reconstructs the snapshot', async () => {
    const { fetchImpl } = envelopeFetch();
    const repo = createHttpSessionRepository({ fetchImpl, carrier: 'envelope' });
    const res = await repo.get(idA);
    expect(res.action).toBe('ok');
    if (res.action === 'ok') {
      expect(res.snapshot.id).toBe(idA);
      expect(res.snapshot.updatedAt).toBe(30);
    }
  });

  it('get() overlays envelope bind/cwd/usage over the transcript body', async () => {
    const usage = { source: 'provider', prompt: 11, completion: 2, total: 13 };
    const blobUrl = `${UPLOAD_URL}/read?obj=tx_obj1`;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && u.endsWith('/envelope')) {
        return Response.json(
          {
            id: idA,
            updatedAt: 30,
            meta: {
              transcriptPointer: 'tx_obj1',
              activeSandboxId: 'sbx_env',
              logicalCwd: 'from/envelope',
              usage: JSON.stringify(usage),
            },
            transcriptReadUrl: blobUrl,
          },
          { status: 200 },
        );
      }
      if (u === blobUrl) {
        return Response.json(
          {
            id: idA,
            updatedAt: 30,
            messages: [{ id: 'm', role: 'user', text: 'hi', at: 1 }],
            meta: {
              activeSandboxId: 'sbx_tx',
              logicalCwd: 'from/transcript',
              usage: JSON.stringify({ source: 'provider', prompt: 1 }),
            },
          },
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    });
    const repo = createHttpSessionRepository({ fetchImpl, carrier: 'envelope' });
    const res = await repo.get(idA);
    expect(res.action).toBe('ok');
    if (res.action === 'ok') {
      expect(res.snapshot.activeSandboxId).toBe('sbx_env');
      expect(res.snapshot.cwd).toBe('from/envelope');
      expect(res.snapshot.usage).toEqual(usage);
    }
  });

  it('backend-agents A4 — get() on the envelope carrier restores all three turn carriers (put → pull)', async () => {
    // Matrix row 12: the envelope Redis round-trip. A snapshot folded via cloudMetaFor
    // lands in the envelope meta; the envelope read (parse transcript + overlay meta)
    // must restore all three carriers, and poison never sticks.
    const blobUrl = `${UPLOAD_URL}/read?obj=tx_obj1`;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && u.endsWith('/envelope')) {
        return Response.json(
          {
            id: idA,
            updatedAt: 30,
            meta: {
              transcriptPointer: 'tx_obj1',
              turnRunId: 'run_env_2',
              turnStatus: 'completed',
              turnStreamCursor: 9,
            },
            transcriptReadUrl: blobUrl,
          },
          { status: 200 },
        );
      }
      if (u === blobUrl) {
        return Response.json(
          {
            id: idA,
            updatedAt: 30,
            messages: [{ id: 'm', role: 'user', text: 'hi', at: 1 }],
            meta: { turnRunId: 'run_tx_1', turnStatus: 'running', turnStreamCursor: 3 },
          },
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    });
    const repo = createHttpSessionRepository({ fetchImpl, carrier: 'envelope' });
    const res = await repo.get(idA);
    expect(res.action).toBe('ok');
    if (res.action === 'ok') {
      // Envelope (last full desired set) wins over the transcript-body meta.
      expect(res.snapshot.turnRunId).toBe('run_env_2');
      expect(res.snapshot.turnStatus).toBe('completed');
      expect(res.snapshot.turnStreamCursor).toBe(9);
    }
  });

  it('a 401 from the Blob object host does NOT disable the repo (reader Minor L1)', async () => {
    // A 401 from the Blob host (cross-origin signed URL expired / blip) is NOT an
    // Auth.js sign-out — the repo must stay enabled and surface a transient error.
    const blobUrl = `${UPLOAD_URL}/read?obj=tx_obj1`;
    let envelopeReads = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && u.endsWith('/envelope')) {
        envelopeReads += 1;
        return Response.json(
          {
            id: idA,
            updatedAt: 30,
            meta: { transcriptPointer: 'tx_obj1' },
            transcriptReadUrl: blobUrl,
          },
          { status: 200 },
        );
      }
      if (u === blobUrl) return new Response(null, { status: 401 });
      return new Response(null, { status: 204 });
    });
    const repo = createHttpSessionRepository({ fetchImpl, carrier: 'envelope' });
    const res = await repo.get(idA);
    // Transient error — NOT disabled (the whole repo must not go dark on a Blob 401).
    expect(res.action).toBe('error');
    expect(repo.enabled).toBe(true);
    // A subsequent pull still reaches the envelope (repo still live).
    const again = await repo.get(idA);
    expect(again.action).toBe('error');
    expect(envelopeReads).toBeGreaterThanOrEqual(2);
  });
});
