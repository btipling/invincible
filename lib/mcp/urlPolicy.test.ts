import { describe, expect, it } from 'vitest';
import { assertSafeMcpUrl } from './urlPolicy';

describe('assertSafeMcpUrl', () => {
  it('accepts https public hosts', () => {
    const r = assertSafeMcpUrl('https://mcp.exa.ai/mcp');
    expect(r).toEqual({ ok: true, href: 'https://mcp.exa.ai/mcp' });
  });

  it('rejects empty', () => {
    expect(assertSafeMcpUrl('').ok).toBe(false);
  });

  it('rejects http', () => {
    const r = assertSafeMcpUrl('http://mcp.exa.ai/mcp');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.error).toMatch(/https/i);
  });

  it('rejects userinfo credentials', () => {
    const r = assertSafeMcpUrl('https://user:pass@mcp.exa.ai/mcp');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.error).toMatch(/credentials/i);
  });

  it('rejects localhost and loopback', () => {
    expect(assertSafeMcpUrl('https://localhost/mcp').ok).toBe(false);
    expect(assertSafeMcpUrl('https://127.0.0.1/mcp').ok).toBe(false);
    expect(assertSafeMcpUrl('https://[::1]/mcp').ok).toBe(false);
  });

  it('rejects private IPv4 literals', () => {
    expect(assertSafeMcpUrl('https://10.0.0.5/mcp').ok).toBe(false);
    expect(assertSafeMcpUrl('https://192.168.1.1/mcp').ok).toBe(false);
    expect(assertSafeMcpUrl('https://172.16.0.1/mcp').ok).toBe(false);
  });

  it('rejects metadata hosts and link-local', () => {
    expect(assertSafeMcpUrl('https://169.254.169.254/latest').ok).toBe(false);
    expect(assertSafeMcpUrl('https://metadata.google.internal/').ok).toBe(
      false,
    );
  });

  it('rejects invalid url strings', () => {
    expect(assertSafeMcpUrl('not a url').ok).toBe(false);
  });
});
