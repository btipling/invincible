/**
 * Protocol v4 — host-side MD image extract, fetch, decode, and Wasm cache put.
 * IR paint truth stays in Wasm; this module only schedules browser fetch of http(s) URLs.
 */

import type { HarnessBridge } from './harnessBridge';

/** Caps locked in plan #204. */
export const MAX_IMAGE_URL_LEN = 2048 as const;
export const MAX_CONCURRENT_IMAGE_FETCHES = 3 as const;
export const MAX_IMAGE_FETCH_BYTES = Math.floor(1.5 * 1024 * 1024); // 1.5 MiB
export const MAX_DECODE_EDGE = 1280 as const;

/** CommonMark-ish `![alt](url)` — scheduling only (not full MD). */
const IMAGE_MD_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const putOk = new Set<string>();
const inFlight = new Set<string>();
const queue: string[] = [];
let active = 0;
/** Bridge used by the current pump; cleared on session reset. */
let pumpBridge: HarnessBridge | null = null;

export function resetHarnessImageSession(): void {
  putOk.clear();
  inFlight.clear();
  queue.length = 0;
  active = 0;
  pumpBridge = null;
}

/** True when URL is http(s) and within length cap (mirrors link_url.isSafeLinkUrl). */
export function isSafeImageUrl(url: string): boolean {
  if (!url || url.length > MAX_IMAGE_URL_LEN) return false;
  const lower = url.toLowerCase();
  return lower.startsWith('https://') || lower.startsWith('http://');
}

/**
 * Extract unique candidate image URLs from markdown source for fetch scheduling.
 * Only `![alt](url)` forms; http(s) only; max length enforced.
 */
export function extractCandidateImageUrls(markdown: string): string[] {
  if (!markdown) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  IMAGE_MD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMAGE_MD_RE.exec(markdown)) !== null) {
    let url = (m[2] ?? '').trim();
    // Strip optional surrounding <…>
    if (url.startsWith('<') && url.endsWith('>')) {
      url = url.slice(1, -1).trim();
    }
    if (!isSafeImageUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Reject bodies over the byte cap (Content-Length or actual size). */
export function isImageBodyWithinCap(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= MAX_IMAGE_FETCH_BYTES;
}

export function scheduleImagesFromMarkdown(
  bridge: HarnessBridge,
  markdown: string,
): void {
  pumpBridge = bridge;
  for (const url of extractCandidateImageUrls(markdown)) {
    enqueue(url);
  }
  void pump();
}

export function scheduleImagesFromTexts(
  bridge: HarnessBridge,
  texts: readonly string[],
): void {
  pumpBridge = bridge;
  for (const text of texts) {
    for (const url of extractCandidateImageUrls(text)) {
      enqueue(url);
    }
  }
  void pump();
}

function enqueue(url: string): void {
  if (putOk.has(url) || inFlight.has(url)) return;
  if (queue.includes(url)) return;
  queue.push(url);
}

async function pump(): Promise<void> {
  const bridge = pumpBridge;
  if (!bridge) return;
  while (active < MAX_CONCURRENT_IMAGE_FETCHES && queue.length > 0) {
    const url = queue.shift()!;
    if (putOk.has(url) || inFlight.has(url)) continue;
    inFlight.add(url);
    active += 1;
    void loadOne(bridge, url).finally(() => {
      inFlight.delete(url);
      active -= 1;
      void pump();
    });
  }
}

async function loadOne(bridge: HarnessBridge, url: string): Promise<void> {
  try {
    const res = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
    });
    if (!res.ok) return;
    const lenHeader = res.headers.get('content-length');
    if (lenHeader) {
      const n = Number(lenHeader);
      if (Number.isFinite(n) && !isImageBodyWithinCap(n)) return;
    }
    const buf = await res.arrayBuffer();
    if (!isImageBodyWithinCap(buf.byteLength)) return;
    const bitmap = await createImageBitmap(new Blob([buf]));
    try {
      const { width, height, rgba } = rasterizeBitmap(bitmap);
      if (width === 0 || height === 0) return;
      const ok = bridge.imageCachePut(url, rgba, width, height);
      if (ok) putOk.add(url);
    } finally {
      bitmap.close();
    }
  } catch {
    // CORS / network / decode — leave Wasm on alt/placeholder
  }
}

/** Downscale so max(edge) ≤ MAX_DECODE_EDGE; return non-premultiplied RGBA. */
export function rasterizeBitmap(
  bitmap: ImageBitmap,
  maxEdge: number = MAX_DECODE_EDGE,
): { width: number; height: number; rgba: Uint8ClampedArray } {
  let w = bitmap.width;
  let h = bitmap.height;
  const edge = Math.max(w, h);
  if (edge > maxEdge && edge > 0) {
    const s = maxEdge / edge;
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return { width: 0, height: 0, rgba: new Uint8ClampedArray(0) };
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, rgba: data.data };
}
