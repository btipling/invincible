import { describe, expect, it } from 'vitest';
import { formatElapsedSeconds } from './elapsedTime';

describe('formatElapsedSeconds', () => {
  it('renders sub-minute as 0:ss (no left-pad hour, two-digit seconds)', () => {
    expect(formatElapsedSeconds(0)).toBe('0:00');
    expect(formatElapsedSeconds(5)).toBe('0:05');
    expect(formatElapsedSeconds(9)).toBe('0:09');
    expect(formatElapsedSeconds(59)).toBe('0:59');
  });

  it('renders minutes as m:ss', () => {
    expect(formatElapsedSeconds(60)).toBe('1:00');
    expect(formatElapsedSeconds(62)).toBe('1:02');
    expect(formatElapsedSeconds(727)).toBe('12:07');
    expect(formatElapsedSeconds(3599)).toBe('59:59');
  });

  it('renders an hour+ as h:mm:ss with a two-digit minute', () => {
    expect(formatElapsedSeconds(3600)).toBe('1:00:00');
    expect(formatElapsedSeconds(3723)).toBe('1:02:03');
    expect(formatElapsedSeconds(7215)).toBe('2:00:15');
  });

  it('clamps negative / NaN input so the chip never shows a stray value', () => {
    expect(formatElapsedSeconds(-1)).toBe('0:00');
    expect(formatElapsedSeconds(-50)).toBe('0:00');
    expect(formatElapsedSeconds(Number.NaN)).toBe('0:00');
    expect(formatElapsedSeconds(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});
