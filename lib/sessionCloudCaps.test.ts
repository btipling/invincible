import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_MODEL_ID_LEN,
  STATUS_SLOT_MAX_BYTES,
  sanitizeModelId,
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
