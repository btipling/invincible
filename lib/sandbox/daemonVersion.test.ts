import { describe, expect, it } from 'vitest';
import { INVINCIBLE_SANDBOX_DAEMON_VERSION } from '../../sandbox/constants.mjs';
import { EXPECTED_SANDBOX_DAEMON_VERSION } from './daemonVersion';

describe('sandbox daemon version parity', () => {
  it('TS EXPECTED_SANDBOX_DAEMON_VERSION mirrors constants.mjs', () => {
    // Prevents the dangerous case where one side is bumped and the other drifts:
    // the app would then reject every tool call (or silently miss an upgrade).
    expect(EXPECTED_SANDBOX_DAEMON_VERSION).toBe(INVINCIBLE_SANDBOX_DAEMON_VERSION);
  });
});
