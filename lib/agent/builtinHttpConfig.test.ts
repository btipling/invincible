import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUILTIN_HTTP_MAX_BYTES,
  DEFAULT_BUILTIN_HTTP_TIMEOUT_MS,
  MAX_BUILTIN_HTTP_MAX_BYTES,
  MAX_BUILTIN_HTTP_TIMEOUT_MS,
  MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS,
  resolveBuiltinHttpConfig,
} from './builtinHttpConfig';

describe('resolveBuiltinHttpConfig', () => {
  it('returns defaults when env is empty', () => {
    const c = resolveBuiltinHttpConfig({});
    expect(c.timeoutMs).toBe(DEFAULT_BUILTIN_HTTP_TIMEOUT_MS);
    expect(c.maxBytes).toBe(DEFAULT_BUILTIN_HTTP_MAX_BYTES);
  });

  it('resolves timeout and max bytes from env', () => {
    const c = resolveBuiltinHttpConfig({
      BUILTIN_HTTP_TIMEOUT_MS: '30000',
      BUILTIN_HTTP_MAX_BYTES: '1048576',
    });
    expect(c.timeoutMs).toBe(30_000);
    expect(c.maxBytes).toBe(1_048_576);
  });

  it('clamps timeout and max bytes to max', () => {
    const c = resolveBuiltinHttpConfig({
      BUILTIN_HTTP_TIMEOUT_MS: '9999999',
      BUILTIN_HTTP_MAX_BYTES: '999999999',
      BUILTIN_HTTP_SANDBOX_TIMEOUT_MS: '9999999',
    });
    expect(c.timeoutMs).toBe(MAX_BUILTIN_HTTP_TIMEOUT_MS);
    expect(c.maxBytes).toBe(MAX_BUILTIN_HTTP_MAX_BYTES);
    expect(c.sandboxTimeoutMs).toBe(MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS);
  });
});
