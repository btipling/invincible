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
  it('defaults to off', () => {
    const c = resolveBuiltinHttpConfig({});
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('off');
    expect(c.timeoutMs).toBe(DEFAULT_BUILTIN_HTTP_TIMEOUT_MS);
    expect(c.maxBytes).toBe(DEFAULT_BUILTIN_HTTP_MAX_BYTES);
  });

  it('enables sandbox mode', () => {
    const c = resolveBuiltinHttpConfig({ BUILTIN_HTTP_FETCH: 'sandbox' });
    expect(c.enabled).toBe(true);
    expect(c.mode).toBe('sandbox');
  });

  it('clamps timeout and max bytes', () => {
    const c = resolveBuiltinHttpConfig({
      BUILTIN_HTTP_FETCH: 'sandbox',
      BUILTIN_HTTP_TIMEOUT_MS: '999999',
      BUILTIN_HTTP_MAX_BYTES: '999999999',
      BUILTIN_HTTP_SANDBOX_TIMEOUT_MS: '999999',
    });
    expect(c.timeoutMs).toBe(MAX_BUILTIN_HTTP_TIMEOUT_MS);
    expect(c.maxBytes).toBe(MAX_BUILTIN_HTTP_MAX_BYTES);
    expect(c.sandboxTimeoutMs).toBe(MAX_BUILTIN_HTTP_SANDBOX_TIMEOUT_MS);
  });

  it('treats unknown mode as off', () => {
    expect(resolveBuiltinHttpConfig({ BUILTIN_HTTP_FETCH: 'yes' }).enabled).toBe(
      false,
    );
  });
});
