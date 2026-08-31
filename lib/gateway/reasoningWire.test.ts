import { describe, expect, it } from 'vitest';
import {
  GATEWAY_REASONING_WIRE,
  filterGatewayWireEfforts,
  isGatewayReasoningWire,
} from './reasoningWire';

describe('GATEWAY_REASONING_WIRE', () => {
  it('is the language-model enum (no max, no alias)', () => {
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

describe('filterGatewayWireEfforts', () => {
  it('drops max and junk; keeps xhigh; never aliases max to xhigh', () => {
    expect(
      filterGatewayWireEfforts(['low', 'high', 'max', 'xhigh', 'BAD', 'low']),
    ).toEqual(['low', 'high', 'xhigh']);
    expect(filterGatewayWireEfforts(['max'])).toEqual([]);
    expect(filterGatewayWireEfforts(['MAX'])).toEqual([]);
    expect(filterGatewayWireEfforts(['max'])).not.toContain('xhigh');
  });
});
