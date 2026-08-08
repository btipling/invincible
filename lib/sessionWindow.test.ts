import { describe, expect, it } from 'vitest';
import {
  HARNESS_RING_MAX,
  HISTORY_PAGE,
  canLoadEarlier,
  earlierRingStart,
  latestRingStart,
  sliceMessagesForRing,
} from './sessionWindow';
import { makeMessage } from './sessionStore';

describe('latestRingStart', () => {
  it('is 0 when M ≤ ring', () => {
    expect(latestRingStart(0)).toBe(0);
    expect(latestRingStart(HARNESS_RING_MAX)).toBe(0);
    expect(latestRingStart(10)).toBe(0);
  });

  it('is M-ringMax when M > ring', () => {
    expect(latestRingStart(HARNESS_RING_MAX + 1)).toBe(1);
    expect(latestRingStart(HARNESS_RING_MAX + 12)).toBe(12);
    expect(latestRingStart(HARNESS_RING_MAX + 52)).toBe(52);
  });
});

describe('earlierRingStart', () => {
  it('steps back by HISTORY_PAGE', () => {
    expect(earlierRingStart(HISTORY_PAGE + 10)).toBe(10);
    expect(earlierRingStart(HISTORY_PAGE)).toBe(0);
    expect(earlierRingStart(HISTORY_PAGE - 1)).toBe(0);
  });

  it('clamps at 0', () => {
    expect(earlierRingStart(0)).toBe(0);
    expect(earlierRingStart(10)).toBe(0);
  });
});

describe('canLoadEarlier', () => {
  it('true only when start > 0', () => {
    expect(canLoadEarlier(0)).toBe(false);
    expect(canLoadEarlier(1)).toBe(true);
  });
});

describe('sliceMessagesForRing', () => {
  const total = HARNESS_RING_MAX + 12;
  const msgs = Array.from({ length: total }, (_, i) => makeMessage('user', `m${i}`));

  it('never exceeds ring max', () => {
    const slice = sliceMessagesForRing(msgs, 12);
    expect(slice).toHaveLength(HARNESS_RING_MAX);
    expect(slice[0]!.text).toBe('m12');
    expect(slice[HARNESS_RING_MAX - 1]!.text).toBe(`m${total - 1}`);
  });

  it('load earlier to 0 returns first ringMax messages', () => {
    const slice = sliceMessagesForRing(msgs, 0);
    expect(slice).toHaveLength(HARNESS_RING_MAX);
    expect(slice[0]!.text).toBe('m0');
    expect(slice[HARNESS_RING_MAX - 1]!.text).toBe(`m${HARNESS_RING_MAX - 1}`);
  });

  it('short session returns all', () => {
    const short = msgs.slice(0, 10);
    expect(sliceMessagesForRing(short, 0)).toHaveLength(10);
  });
});
