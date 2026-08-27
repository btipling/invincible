import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HarnessBridge,
  type HarnessBridgeExports,
} from '../lib/harnessBridge';

/**
 * Fail-closed real-Wasm loader (same rule as `lib/harnessChat.wasm-int.test.ts`).
 * Missing or pre-v11 artifact **throws** — never `it.skip`.
 */
const WASM_CANDIDATES = [
  resolve(__dirname, '../public/harness/harness.wasm'),
  resolve(__dirname, '../native/dist/harness/harness.wasm'),
];

function loadWasmBytes(): Buffer {
  for (const p of WASM_CANDIDATES) {
    if (existsSync(p)) return readFileSync(p);
  }
  throw new Error(
    'No harness.wasm found. Run `scripts/fetch-harness-artifact.mjs` (needs the ' +
      'build-harness artifact) or `./native/harness/build.sh` to make a protocol-v11 ' +
      'wasm available before the durable-turn int rows can pass.',
  );
}

export async function loadBridge(): Promise<HarnessBridge> {
  const bytes = loadWasmBytes();
  const module = await WebAssembly.compile(bytes as unknown as BufferSource);
  const imports = WebAssembly.Module.imports(module);
  const dvuiStub: Record<string, (...args: unknown[]) => unknown> = {};

  for (const imp of imports) {
    if (imp.kind === 'function' && dvuiStub[imp.name] === undefined) {
      dvuiStub[imp.name] = imp.name === 'wasm_read' ? () => 0 : () => {};
    }
  }
  dvuiStub['wasm_refresh'] = () => {};

  const instance = await WebAssembly.instantiate(module, { dvui: dvuiStub });
  const exports = instance.exports as unknown as HarnessBridgeExports & {
    inv_protocol_version: () => number;
  };
  if (typeof exports.inv_protocol_version !== 'function') {
    throw new Error('harness.wasm missing inv_protocol_version');
  }
  const from = HarnessBridge.fromInstance(instance);
  if (!from.ok) {
    throw new Error(from.error);
  }
  return from.bridge;
}
