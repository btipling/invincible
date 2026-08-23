import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_MODEL_ID_LEN,
  REDIS_SAFE_OPAQUE_ID_MAX,
  STATUS_SLOT_MAX_BYTES,
  TURN_RUN_ID_MAX,
  TURN_STATUS_MAX_BYTES,
  TURN_STATUS_VALUES,
  sanitizeModelId,
  sanitizeTurnRunId,
  sanitizeTurnStatus,
} from './sessionCloudCaps';
import { MAX_MODEL_ID_LEN as BRIDGE_MAX_MODEL_ID_LEN, MAX_STATUS_SLOT_LEN } from './harnessBridge';

/**
 * Cross-layer equality lock for the status-slot byte cap (PR #543 #4). The 96
 * cap used to be a triplicated literal — one in `lib/sessionCloudCaps.ts`
 * (`STATUS_SLOT_MAX_BYTES`), one in `lib/harnessBridge.ts`
 * (`MAX_STATUS_SLOT_LEN`), and one in `native/harness/src/bridge.zig`
 * (`MAX_STATUS_SLOT_LEN`) — with the only "sync" being a comment, and no test
 * asserting the three agreed. `MAX_STATUS_SLOT_LEN` is now aliased to the single
 * host source `STATUS_SLOT_MAX_BYTES`; this test additionally pins the Zig side
 * so a 96→128 drift in `bridge.zig` fails the suite instead of splitting
 * host-accepts/Wasm-rejects (which a protocol-version bump would NOT catch).
 */
function zigMaxStatusSlotLen(): number {
  const src = readFileSync(
    resolve(process.cwd(), 'native/harness/src/bridge.zig'),
    'utf8',
  );
  const m = src.match(/pub\s+const\s+MAX_STATUS_SLOT_LEN\s*=\s*(\d+)\s*;/);
  if (!m) throw new Error('MAX_STATUS_SLOT_LEN not found in bridge.zig');
  return Number(m[1]);
}

describe('status-slot cap (single host source + Zig parity)', () => {
  it('host bridge MAX_STATUS_SLOT_LEN is the same single source as STATUS_SLOT_MAX_BYTES', () => {
    expect(MAX_STATUS_SLOT_LEN).toBe(STATUS_SLOT_MAX_BYTES);
  });

  it('Zig MAX_STATUS_SLOT_LEN agrees with the host cap (cross-layer)', () => {
    expect(zigMaxStatusSlotLen()).toBe(STATUS_SLOT_MAX_BYTES);
    expect(zigMaxStatusSlotLen()).toBe(MAX_STATUS_SLOT_LEN);
  });
});

/**
 * Cross-layer equality lock for the model-id byte cap (PR #618 re-run 3 Minor L6).
 * Mirrors `zigMaxStatusSlotLen()` — parses `bridge.zig` for `pub const MAX_MODEL_ID_LEN`
 * so a 128→64 drift fails the suite instead of splitting host-accepts/Wasm-rejects.
 */
function zigMaxModelIdLen(): number {
  const src = readFileSync(
    resolve(process.cwd(), 'native/harness/src/bridge.zig'),
    'utf8',
  );
  const m = src.match(/pub\s+const\s+MAX_MODEL_ID_LEN\s*=\s*(\d+)\s*;/);
  if (!m) throw new Error('MAX_MODEL_ID_LEN not found in bridge.zig');
  return Number(m[1]);
}

describe('sanitizeModelId (plan #616 — selected-model carrier predicate + cap)', () => {
  it('single host source: harnessBridge aliases the caps MAX_MODEL_ID_LEN (no drift)', () => {
    // harnessBridge re-exports the caps constant; a second literal would drift.
    expect(BRIDGE_MAX_MODEL_ID_LEN).toBe(MAX_MODEL_ID_LEN);
    expect(MAX_MODEL_ID_LEN).toBe(128);
  });

  it('Zig MAX_MODEL_ID_LEN agrees with the host cap (cross-layer parity, PR #618 review #7)', () => {
    expect(zigMaxModelIdLen()).toBe(MAX_MODEL_ID_LEN);
    expect(zigMaxModelIdLen()).toBe(128);
  });

  it('Zig setSelectedModel(index) raises pending; selectModelById does not (PR #618 re-run 5 Minor L6)', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'native/harness/src/bridge.zig'),
      'utf8',
    );
    const sliceFn = (sig: string): string => {
      const start = src.indexOf(sig);
      if (start < 0) throw new Error(`${sig} not found in bridge.zig`);
      const from = src.slice(start);
      const nextPub = from.indexOf('\npub fn ', 1);
      const nextExport = from.indexOf('\nexport fn ', 1);
      let end = from.length;
      if (nextPub > 0) end = Math.min(end, nextPub);
      if (nextExport > 0) end = Math.min(end, nextExport);
      return from.slice(0, end);
    };
    const indexFn = sliceFn('pub fn setSelectedModel(index: u32)');
    const byIdFn = sliceFn('pub fn selectModelById(id: []const u8)');
    expect(indexFn).toContain('has_pending_model_change = true');
    expect(byIdFn).not.toContain('has_pending_model_change = true');
  });

  it('keeps valid printable-ASCII provider/model ids (incl. / . : + -)', () => {
    expect(sanitizeModelId('anthropic/claude-a')).toBe('anthropic/claude-a');
    expect(sanitizeModelId('provider/model.big:x+y-123')).toBe('provider/model.big:x+y-123');
    // trims surrounding whitespace
    expect(sanitizeModelId('  openai/gpt-b  ')).toBe('openai/gpt-b');
  });

  it('drops non-string / empty / non-printable / over-length (drop-to-unset)', () => {
    expect(sanitizeModelId(undefined)).toBeUndefined();
    expect(sanitizeModelId(42)).toBeUndefined();
    expect(sanitizeModelId('')).toBeUndefined();
    expect(sanitizeModelId('   ')).toBeUndefined();
    expect(sanitizeModelId('has space')).toBeUndefined();
    expect(sanitizeModelId('tab\there')).toBeUndefined();
    expect(sanitizeModelId('ctrl\u0007here')).toBeUndefined();
    expect(sanitizeModelId('x'.repeat(MAX_MODEL_ID_LEN + 1))).toBeUndefined();
  });

  it('cap-bound: the 128-byte model id rides the tiny envelope far below the meta cap (row 13)', () => {
    // The carrier is ≤ 128 bytes — a tiny fraction of the 1 MiB whole-meta budget,
    // and far below the 4.5 MB Function ceiling (Caps table in plan #616).
    expect(MAX_MODEL_ID_LEN).toBeLessThanOrEqual(1024 * 1024);
    expect(MAX_MODEL_ID_LEN).toBeLessThan(4.5 * 1024 * 1024);
    // A 128-char printable id is accepted; 129 rejected.
    expect(sanitizeModelId('a'.repeat(MAX_MODEL_ID_LEN))).toBe('a'.repeat(MAX_MODEL_ID_LEN));
    expect(sanitizeModelId('a'.repeat(MAX_MODEL_ID_LEN + 1))).toBeUndefined();
  });
});

// Plan #795 (backend-agents A1): reserved `meta.turnRunId` is a Workflow run id
// carried in the tiny session envelope. A NEW cap that reuses the existing
// Redis-safe opaque ceiling — no existing cap value changed (no human gate).
describe('sanitizeTurnRunId + TURN_RUN_ID_MAX (plan #795 — Workflow run-id carrier)', () => {
  it('TURN_RUN_ID_MAX is a NEW cap that reuses the existing opaque ceiling exactly', () => {
    // NEW cap = the existing REDIS_SAFE_OPAQUE_ID_MAX by reference (not a new tight
    // number, not a change to the existing cap). Far below the 1 MiB meta budget.
    expect(TURN_RUN_ID_MAX).toBe(REDIS_SAFE_OPAQUE_ID_MAX);
    expect(TURN_RUN_ID_MAX).toBe(512);
    expect(TURN_RUN_ID_MAX).toBeLessThan(1024 * 1024);
    expect(TURN_RUN_ID_MAX).toBeLessThan(4.5 * 1024 * 1024);
  });

  it('accepts a trimmed Redis-safe opaque run id (charset [A-Za-z0-9_-], ≤ 512)', () => {
    expect(sanitizeTurnRunId('run_abc-123DEF')).toBe('run_abc-123DEF');
    expect(sanitizeTurnRunId('run_abc')).toBe('run_abc');
    expect(sanitizeTurnRunId('  2cvk_f1l0p9heqtzB7cX  ')).toBe('2cvk_f1l0p9heqtzB7cX');
    // at the exact cap length is accepted
    expect(sanitizeTurnRunId('a'.repeat(TURN_RUN_ID_MAX))).toBe('a'.repeat(TURN_RUN_ID_MAX));
  });

  it('drops non-string / empty / whitespace / over-length (drop-to-unset)', () => {
    expect(sanitizeTurnRunId(undefined)).toBeUndefined();
    expect(sanitizeTurnRunId(42)).toBeUndefined();
    expect(sanitizeTurnRunId(null)).toBeUndefined();
    expect(sanitizeTurnRunId('')).toBeUndefined();
    expect(sanitizeTurnRunId('   ')).toBeUndefined();
    expect(sanitizeTurnRunId('x'.repeat(TURN_RUN_ID_MAX + 1))).toBeUndefined();
  });

  it('drops non-opaque values (glob / `:` / space / `.` / `/` / `?` — Redis-safe opaque enforced)', () => {
    for (const bad of ['*', '?', 'a:b', 'has space', 'a.b', 'a/b', 'a[b', 'a]b', 'a|b', 'a,b']) {
      expect(sanitizeTurnRunId(bad)).toBeUndefined();
    }
  });
});

// Plan #796 (backend-agents A2): reserved `meta.turnStatus` is a fixed enum
// carrier (`idle | running | cancelling | completed`). NEW cap
// (`TURN_STATUS_MAX_BYTES`) riding a tiny envelope value — no existing cap
// changed (no human gate). `completed` is a first-class terminal member, not
// special-cased.
describe('sanitizeTurnStatus + TURN_STATUS_MAX_BYTES (plan #796 — turn-status carrier)', () => {
  it('TURN_STATUS_MAX_BYTES is a NEW generous cap (longest member `cancelling` = 10) riding the tiny envelope', () => {
    expect(TURN_STATUS_MAX_BYTES).toBe(64);
    // Generous vs the longest real member, far below the 1 MiB whole-meta budget
    // and the 4.5 MB Function wire — belt-and-suspenders over the exact-enum check.
    expect(TURN_STATUS_MAX_BYTES).toBeGreaterThanOrEqual(10);
    expect(TURN_STATUS_MAX_BYTES).toBeLessThan(1024 * 1024);
    expect(TURN_STATUS_MAX_BYTES).toBeLessThan(4.5 * 1024 * 1024);
  });

  it('single-source enum exposes exactly the four members (shared validator + host source)', () => {
    expect(TURN_STATUS_VALUES).toEqual(['idle', 'running', 'cancelling', 'completed']);
  });

  it('accepts each member — including the terminal `completed` — preserved exactly', () => {
    for (const member of TURN_STATUS_VALUES) {
      expect(sanitizeTurnStatus(member)).toBe(member);
    }
    expect(sanitizeTurnStatus('completed')).toBe('completed');
  });

  it('drops non-string / empty / whitespace-padded members (no trim-into-member, no case-fold)', () => {
    expect(sanitizeTurnStatus(undefined)).toBeUndefined();
    expect(sanitizeTurnStatus(42)).toBeUndefined();
    expect(sanitizeTurnStatus(null)).toBeUndefined();
    expect(sanitizeTurnStatus('')).toBeUndefined();
    expect(sanitizeTurnStatus('   ')).toBeUndefined();
    // padded member is poison here — the value is checked against exact members only
    expect(sanitizeTurnStatus('  idle  ')).toBeUndefined();
  });

  it('drops case-folded and unknown enum values (drop-to-unset)', () => {
    for (const bad of ['Running', 'RUNNING', 'Cancelling', 'done', 'pending', 'paused', 'awaiting']) {
      expect(sanitizeTurnStatus(bad)).toBeUndefined();
    }
  });

  it('drops over-length values (TURN_STATUS_MAX_BYTES + 1)', () => {
    expect(sanitizeTurnStatus('a'.repeat(TURN_STATUS_MAX_BYTES))).toBeUndefined(); // not a member
    expect(sanitizeTurnStatus('x'.repeat(TURN_STATUS_MAX_BYTES + 1))).toBeUndefined();
  });
});
