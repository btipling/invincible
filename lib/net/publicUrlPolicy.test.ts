import { describe, expect, it } from 'vitest';
import {
  assertSafePublicHttps,
  type AssertSafePublicHttpsOptions,
} from './publicUrlPolicy';
import type { UrlPolicyLookup } from '../mcp/urlPolicy';

const noDns: AssertSafePublicHttpsOptions = { skipDns: true };

describe('assertSafePublicHttps', () => {
  it('accepts public https hosts (skip DNS)', async () => {
    const r = await assertSafePublicHttps('https://example.com/path', noDns);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.href).toMatch(/^https:\/\/example\.com\//);
  });

  it('rejects http', async () => {
    const r = await assertSafePublicHttps('http://example.com/', noDns);
    expect(r.ok).toBe(false);
  });

  it('rejects userinfo credentials', async () => {
    const r = await assertSafePublicHttps(
      'https://user:pass@example.com/',
      noDns,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects private IPs and metadata', async () => {
    expect((await assertSafePublicHttps('https://127.0.0.1/', noDns)).ok).toBe(
      false,
    );
    expect((await assertSafePublicHttps('https://10.0.0.1/', noDns)).ok).toBe(
      false,
    );
    expect(
      (await assertSafePublicHttps('https://169.254.169.254/', noDns)).ok,
    ).toBe(false);
    expect(
      (await assertSafePublicHttps('https://metadata.google.internal/', noDns))
        .ok,
    ).toBe(false);
  });

  it('rejects DNS that resolves to private addresses', async () => {
    const lookup: UrlPolicyLookup = async () => [
      { address: '10.1.2.3', family: 4 },
    ];
    const r = await assertSafePublicHttps('https://evil.example/', { lookup });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/private/i);
  });

  it('accepts DNS that resolves to public addresses', async () => {
    const lookup: UrlPolicyLookup = async () => [
      { address: '93.184.216.34', family: 4 },
    ];
    const r = await assertSafePublicHttps('https://example.com/', { lookup });
    expect(r.ok).toBe(true);
  });
});
