import { describe, expect, it } from 'vitest';
import { loadBridge } from './loadBridge';

describe('durable-turn int wasm supply (fail-closed, not it.fails)', () => {
  it('loads harness.wasm (fail-closed)', async () => {
    const bridge = await loadBridge();
    expect(bridge.protocolVersion()).toBeGreaterThanOrEqual(11);
  });
});
