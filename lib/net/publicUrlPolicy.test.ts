import { describe, expect, it } from 'vitest';
import {
  assertSafePublicHttps,
  type UrlPolicyLookup,
} from './publicUrlPolicy';

const noDns = { skipDns: true as const };

describe('assertSafePublicHttps', () => {
  it('accepts https public hosts (skip DNS)', async () => {
    const r = await assertSafePublicHttps('https://example.com/path', noDns);
    expect(r).toEqual({ ok: true, href: 'https://example.com/path' });
  });

  it('rejects http', async () => {
    const r = await assertSafePublicHttps('http://example.com/', noDns);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.error).toMatch(/https/i);
  });

  it('rejects credentials', async () => {
    const r = await assertSafePublicHttps(
      'https://user:pass@example.com/',
      noDns,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects private / metadata', async () => {
    expect(
      (await assertSafePublicHttps('https://127.0.0.1/', noDns)).ok,
    ).toBe(false);
    expect(
      (await assertSafePublicHttps('https://10.0.0.1/', noDns)).ok,
    ).toBe(false);
    expect(
      (await assertSafePublicHttps('https://169.254.169.254/', noDns)).ok,
    ).toBe(false);
  });

  it('rejects DNS→private (injected lookup)', async () => {
    const lookup: UrlPolicyLookup = async () => [
      { address: '192.168.1.1', family: 4 },
    ];
    const r = await assertSafePublicHttps('https://evil.example/', { lookup });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected fail');
    expect(r.error).toMatch(/private/i);
  });

  it('accepts public DNS (injected)', async () => {
    const lookup: UrlPolicyLookup = async () => [
      { address: '93.184.216.34', family: 4 },
    ];
    const r = await assertSafePublicHttps('https://example.com/', { lookup });
    expect(r.ok).toBe(true);
  });
});
