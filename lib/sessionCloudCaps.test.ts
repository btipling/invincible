import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATUS_SLOT_MAX_BYTES } from './sessionCloudCaps';
import { MAX_STATUS_SLOT_LEN } from './harnessBridge';

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
