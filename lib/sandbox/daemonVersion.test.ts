import { describe, expect, it } from 'vitest';
import {
  INVINCIBLE_SANDBOX_DAEMON_VERSION,
  SANDBOX_EXPECTED_DAEMON_VERSION_HEADER,
  SANDBOX_DAEMON_OUT_OF_DATE_CODE,
  sandboxDaemonOutOfDateError,
} from '../../sandbox/constants.mjs';
import {
  EXPECTED_SANDBOX_DAEMON_VERSION,
  EXPECTED_DAEMON_VERSION_HEADER,
  SANDBOX_DAEMON_OUT_OF_DATE_CODE as TS_OUT_OF_DATE_CODE,
  sandboxDaemonOutOfDateError as tsSandboxDaemonOutOfDateError,
} from './daemonVersion';

describe('sandbox daemon version parity', () => {
  it('TS EXPECTED_SANDBOX_DAEMON_VERSION mirrors constants.mjs', () => {
    // Prevents the dangerous case where one side is bumped and the other drifts:
    // the app would then reject every tool call (or silently miss an upgrade).
    expect(EXPECTED_SANDBOX_DAEMON_VERSION).toBe(INVINCIBLE_SANDBOX_DAEMON_VERSION);
  });

  it('expected-daemon-version header string matches constants.mjs', () => {
    // The daemon reads headers by their lowercase wire name; both sides must
    // emit/match the exact same key or the 426 gate silently never fires.
    expect(EXPECTED_DAEMON_VERSION_HEADER).toBe(SANDBOX_EXPECTED_DAEMON_VERSION_HEADER);
    expect(EXPECTED_DAEMON_VERSION_HEADER).toBe(EXPECTED_DAEMON_VERSION_HEADER.toLowerCase());
  });

  it('out-of-date `code` matches constants.mjs', () => {
    // Hosts / gateway code may key on the stable code to route 426 vs 502.
    expect(TS_OUT_OF_DATE_CODE).toBe(SANDBOX_DAEMON_OUT_OF_DATE_CODE);
  });

  it('exact out-of-date error string matches constants.mjs', () => {
    // Model-visible + operator-greppable; both sides must render identically.
    expect(tsSandboxDaemonOutOfDateError(2, 3)).toBe(
      sandboxDaemonOutOfDateError(2, 3),
    );
    expect(tsSandboxDaemonOutOfDateError(0, 1)).toBe(
      sandboxDaemonOutOfDateError(0, 1),
    );
  });
});
