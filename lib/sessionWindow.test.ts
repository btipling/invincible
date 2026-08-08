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
    expect(latestRingStart(48)).toBe(0);
    expect(latestRingStart(10)).toBe(0);
  });

  it('is M-48 when M > ring', () => {
    expect(latestRingStart(49)).toBe(1);
    expect(latestRingStart(60)).toBe(12);
    expect(latestRingStart(100)).toBe(52);
  });
});

describe('earlierRingStart', () => {
  it('steps back by HISTORY_PAGE', () => {
    expect(earlierRingStart(36)).toBe(36 - HISTORY_PAGE);
    expect(earlierRingStart(12)).toBe(0);
    expect(earlierRingStart(30)).toBe(6);
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
  const msgs = Array.from({ length: 60 }, (_, i) => makeMessage('user', `m${i}`));

  it('never exceeds ring max', () => {
    const slice = sliceMessagesForRing(msgs, 12);
    expect(slice).toHaveLength(HARNESS_RING_MAX);
    expect(slice[0]!.text).toBe('m12');
    expect(slice[47]!.text).toBe('m59');
  });

  it('load earlier to 0 returns first 48', () => {
    const slice = sliceMessagesForRing(msgs, 0);
    expect(slice).toHaveLength(48);
    expect(slice[0]!.text).toBe('m0');
    expect(slice[47]!.text).toBe('m47');
  });

  it('short session returns all', () => {
    const short = msgs.slice(0, 10);
    expect(sliceMessagesForRing(short, 0)).toHaveLength(10);
  });
});
