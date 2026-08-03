import { describe, expect, it } from 'vitest';
import { safeCallbackUrl } from './callbackUrl';

describe('safeCallbackUrl', () => {
  it('defaults empty to /harness', () => {
    expect(safeCallbackUrl(undefined)).toBe('/harness');
    expect(safeCallbackUrl('')).toBe('/harness');
    expect(safeCallbackUrl('   ')).toBe('/harness');
  });

  it('allows same-origin paths', () => {
    expect(safeCallbackUrl('/harness')).toBe('/harness');
    expect(safeCallbackUrl('/admin')).toBe('/admin');
    expect(safeCallbackUrl('/harness/foo')).toBe('/harness/foo');
  });

  it('rejects protocol-relative and absolute URLs', () => {
    expect(safeCallbackUrl('//evil.com')).toBe('/harness');
    expect(safeCallbackUrl('//evil.com/path')).toBe('/harness');
    expect(safeCallbackUrl('https://evil.com')).toBe('/harness');
    expect(safeCallbackUrl('http://evil.com')).toBe('/harness');
  });

  it('rejects backslash tricks', () => {
    expect(safeCallbackUrl('/\\evil.com')).toBe('/harness');
  });

  it('honors custom fallback', () => {
    expect(safeCallbackUrl('//x', '/login')).toBe('/login');
  });
});
