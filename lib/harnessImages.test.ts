import { describe, expect, it } from 'vitest';
import {
  extractCandidateImageUrls,
  harnessImageSessionGeneration,
  isImageBodyWithinCap,
  isSafeImageUrl,
  MAX_IMAGE_FETCH_BYTES,
  MAX_IMAGE_URL_LEN,
  readResponseBodyCapped,
  resetHarnessImageSession,
} from './harnessImages';

describe('isSafeImageUrl', () => {
  it('allows http(s) only', () => {
    expect(isSafeImageUrl('https://example.com/a.png')).toBe(true);
    expect(isSafeImageUrl('http://example.com/a.png')).toBe(true);
    expect(isSafeImageUrl('HTTPS://EXAMPLE.COM/A.PNG')).toBe(true);
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeImageUrl('data:image/png;base64,xx')).toBe(false);
    expect(isSafeImageUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeImageUrl('/relative.png')).toBe(false);
    expect(isSafeImageUrl('')).toBe(false);
  });

  it('rejects overlong URLs', () => {
    const long = `https://example.com/${'a'.repeat(MAX_IMAGE_URL_LEN)}`;
    expect(isSafeImageUrl(long)).toBe(false);
  });
});

describe('extractCandidateImageUrls', () => {
  it('extracts and dedupes https images', () => {
    const md = `
![a](https://cdn.example.com/a.png)
Inline ![b](https://cdn.example.com/b.png) text
Again ![a](https://cdn.example.com/a.png)
`;
    expect(extractCandidateImageUrls(md)).toEqual([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
    ]);
  });

  it('skips unsafe schemes', () => {
    const md = `
![x](javascript:alert(1))
![y](data:image/png;base64,abc)
![z](https://ok.example/z.png)
![r](/relative.png)
`;
    expect(extractCandidateImageUrls(md)).toEqual(['https://ok.example/z.png']);
  });

  it('handles empty alt', () => {
    expect(extractCandidateImageUrls('![](https://example.com/x.png)')).toEqual([
      'https://example.com/x.png',
    ]);
  });
});

describe('isImageBodyWithinCap', () => {
  it('enforces 1.5 MiB', () => {
    expect(isImageBodyWithinCap(1)).toBe(true);
    expect(isImageBodyWithinCap(MAX_IMAGE_FETCH_BYTES)).toBe(true);
    expect(isImageBodyWithinCap(MAX_IMAGE_FETCH_BYTES + 1)).toBe(false);
    expect(isImageBodyWithinCap(0)).toBe(false);
  });
});

describe('resetHarnessImageSession', () => {
  it('bumps session generation', () => {
    const before = harnessImageSessionGeneration();
    resetHarnessImageSession();
    expect(harnessImageSessionGeneration()).toBe(before + 1);
    resetHarnessImageSession();
    expect(harnessImageSessionGeneration()).toBe(before + 2);
  });
});

describe('readResponseBodyCapped', () => {
  it('rejects when Content-Length exceeds cap', async () => {
    const res = new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-length': String(MAX_IMAGE_FETCH_BYTES + 1) },
    });
    expect(await readResponseBodyCapped(res)).toBeNull();
  });

  it('accepts small body', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const res = new Response(bytes, {
      headers: { 'content-length': '4' },
    });
    const buf = await readResponseBodyCapped(res);
    expect(buf).not.toBeNull();
    expect(new Uint8Array(buf!).length).toBe(4);
  });
});

describe('titled image destinations', () => {
  it('extracts bare url when double-quoted title present', () => {
    expect(
      extractCandidateImageUrls(
        '![Random test image](https://cdn.example.com/a.png "Random test image")',
      ),
    ).toEqual(['https://cdn.example.com/a.png']);
  });

  it('extracts bare url for single-quoted and paren titles', () => {
    expect(
      extractCandidateImageUrls("![a](https://cdn.example.com/a.png 'cap')"),
    ).toEqual(['https://cdn.example.com/a.png']);
    expect(
      extractCandidateImageUrls('![a](https://cdn.example.com/a.png (cap))'),
    ).toEqual(['https://cdn.example.com/a.png']);
  });

  it('rejects urls with whitespace', () => {
    expect(isSafeImageUrl('https://cdn.example.com/a.png "title"')).toBe(false);
  });
});
