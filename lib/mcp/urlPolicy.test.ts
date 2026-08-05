import { describe, expect, it } from 'vitest';
import { assertSafeMcpUrl, type UrlPolicyLookup } from './urlPolicy';

/** Skip real DNS for pure policy unit tests unless testing DNS path. */
const noDns = { skipDns: true as const };

describe('assertSafeMcpUrl', () => {
  it('accepts https public hosts (literal policy, skip DNS)', async () => {
    const r = await assertSafeMcpUrl('https://mcp.exa.ai/mcp', noDns);
    expect(r).toEqual({ ok: true, href: 'https://mcp.exa.ai/mcp' });
  });

  it('rejects empty', async () => {
    expect((await assertSafeMcpUrl('')).ok).toBe(false);
  });

  it('rejects http', async () => {
    const r = await assertSafeMcpUrl('http://mcp.exa.ai/mcp', noDns);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.error).toMatch(/https/i);
  });

  it('rejects userinfo credentials', async () => {
    const r = await assertSafeMcpUrl('https://user:pass@mcp.exa.ai/mcp', noDns);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.error).toMatch(/credentials/i);
  });

  it('rejects localhost and loopback', async () => {
    expect((await assertSafeMcpUrl('https://localhost/mcp', noDns)).ok).toBe(
      false,
    );
    expect((await assertSafeMcpUrl('https://127.0.0.1/mcp', noDns)).ok).toBe(
      false,
    );
    expect((await assertSafeMcpUrl('https://[::1]/mcp', noDns)).ok).toBe(
      false,
    );
  });

  it('rejects private IPv4 literals', async () => {
    expect((await assertSafeMcpUrl('https://10.0.0.5/mcp', noDns)).ok).toBe(
      false,
    );
    expect((await assertSafeMcpUrl('https://192.168.1.1/mcp', noDns)).ok).toBe(
      false,
    );
    expect((await assertSafeMcpUrl('https://172.16.0.1/mcp', noDns)).ok).toBe(
      false,
    );
  });

  it('rejects metadata hosts and link-local', async () => {
    expect(
      (await assertSafeMcpUrl('https://169.254.169.254/latest', noDns)).ok,
    ).toBe(false);
    expect(
      (await assertSafeMcpUrl('https://metadata.google.internal/', noDns)).ok,
    ).toBe(false);
  });

  it('rejects invalid url strings', async () => {
    expect((await assertSafeMcpUrl('not a url', noDns)).ok).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 private and metadata (Node hex form)', async () => {
    // Node normalizes dotted form → ::ffff:HHHH:LLLL
    const cases = [
      'https://[::ffff:127.0.0.1]/mcp',
      'https://[::ffff:10.0.0.1]/mcp',
      'https://[::ffff:169.254.169.254]/latest',
      'https://[::ffff:7f00:1]/mcp',
      'https://[::ffff:a9fe:a9fe]/latest',
      'https://[::ffff:a00:1]/mcp',
    ];
    for (const u of cases) {
      const r = await assertSafeMcpUrl(u, noDns);
      expect(r.ok, u).toBe(false);
    }
  });

  it('rejects trailing-dot blocklist and localhost FQDN forms', async () => {
    expect(
      (await assertSafeMcpUrl('https://metadata.google.internal./', noDns)).ok,
    ).toBe(false);
    expect((await assertSafeMcpUrl('https://localhost./mcp', noDns)).ok).toBe(
      false,
    );
    expect(
      (await assertSafeMcpUrl('https://localhost.localdomain/mcp', noDns)).ok,
    ).toBe(false);
  });

  it('rejects DNS answers that are private (injected lookup)', async () => {
    const lookup: UrlPolicyLookup = async () => [
      { address: '10.0.0.5', family: 4 },
    ];
    const r = await assertSafeMcpUrl('https://evil.example/mcp', { lookup });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.error).toMatch(/private/i);
  });

  it('rejects DNS failure fail-closed', async () => {
    const lookup: UrlPolicyLookup = async () => {
      throw new Error('ENOTFOUND');
    };
    const r = await assertSafeMcpUrl('https://no-such-host.invalid/mcp', {
      lookup,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.error).toMatch(/resolved/i);
  });

  it('accepts public DNS answers (injected lookup)', async () => {
    const lookup: UrlPolicyLookup = async () => [
      { address: '93.184.216.34', family: 4 },
    ];
    const r = await assertSafeMcpUrl('https://example.com/mcp', { lookup });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.href).toBe('https://example.com/mcp');
  });
});
