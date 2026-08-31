import { describe, expect, it } from 'vitest';
import {
  GATEWAY_REASONING_WIRE,
  filterGatewayWireEfforts,
  isGatewayReasoningWire,
  toGatewayReasoningWire,
} from './reasoningWire';

describe('GATEWAY_REASONING_WIRE', () => {
  it('is the language-model enum (no max)', () => {
    expect([...GATEWAY_REASONING_WIRE]).toEqual([
      'provider-default',
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(GATEWAY_REASONING_WIRE.includes('max' as never)).toBe(false);
  });
});

describe('isGatewayReasoningWire', () => {
  it('accepts wire tokens and rejects lab / junk', () => {
    expect(isGatewayReasoningWire('low')).toBe(true);
    expect(isGatewayReasoningWire('xhigh')).toBe(true);
    expect(isGatewayReasoningWire('minimal')).toBe(true);
    expect(isGatewayReasoningWire('max')).toBe(false);
    expect(isGatewayReasoningWire('MAX')).toBe(false);
    expect(isGatewayReasoningWire('')).toBe(false);
  });
});

describe('toGatewayReasoningWire', () => {
  it('aliases max to xhigh; forwards wire tokens; drops garbage', () => {
    expect(toGatewayReasoningWire('max')).toBe('xhigh');
    expect(toGatewayReasoningWire('MAX')).toBe('xhigh');
    expect(toGatewayReasoningWire('xhigh')).toBe('xhigh');
    expect(toGatewayReasoningWire('low')).toBe('low');
    expect(toGatewayReasoningWire('nope')).toBeUndefined();
    expect(toGatewayReasoningWire('BAD TOKEN')).toBeUndefined();
    expect(toGatewayReasoningWire('')).toBeUndefined();
  });
});

describe('filterGatewayWireEfforts', () => {
  it('rewrites max to xhigh, dedupes, and drops junk', () => {
    expect(filterGatewayWireEfforts(['low', 'high', 'max'])).toEqual([
      'low',
      'high',
      'xhigh',
    ]);
    expect(
      filterGatewayWireEfforts(['low', 'high', 'max', 'xhigh', 'BAD', 'low']),
    ).toEqual(['low', 'high', 'xhigh']);
    expect(filterGatewayWireEfforts(['max'])).toEqual(['xhigh']);
    expect(filterGatewayWireEfforts(['MAX'])).toEqual(['xhigh']);
    expect(filterGatewayWireEfforts(['nope', 'v0'])).toEqual([]);
  });
});
