/**
 * Protocol v5 — host-side MD math extract, TeX→SVG raster, Wasm cache put.
 * IR paint truth stays in Wasm; this module only schedules host raster for formulas.
 *
 * Raster uses MathJax SVG (path geometry), not KaTeX HTML: browser canvas taints
 * on blob+foreignObject KaTeX HTML, so pixels never reached Wasm (mono fallback).
 */

import type { HarnessBridge } from './harnessBridge';

/** Caps locked in plan #221. Must match `math_cache.MAX_ENTRIES` / `MAX_TEX_LEN`. */
export const MAX_TEX_LEN = 512 as const;
export const MAX_MATH_CACHE_ENTRIES = 48 as const;
export const MAX_CONCURRENT_MATH_RENDERS = 3 as const;
export const MAX_MATH_EDGE = 1280 as const;
export const MAX_INLINE_MATH_H = 64 as const;
export const MAX_DISPLAY_MATH_H = 320 as const;

/** CSS px per MathJax `ex` when sizing the SVG raster (em=16 → ex≈8). */
const MATH_EX_PX = 8 as const;
const MATH_EM = 16 as const;

export type MathCandidate = {
  tex: string;
  display: boolean;
};

/** Successful puts (LRU). Dropped keys may re-schedule after Wasm eviction. */
const putOk = new Map<string, true>();
const putOkOrder: string[] = [];
const inFlight = new Set<string>();
const queue: MathCandidate[] = [];
let active = 0;
let pumpBridge: HarnessBridge | null = null;
let sessionGen = 0;

type MathJaxHandle = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adaptor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  html: any;
};

let mjHandle: MathJaxHandle | null = null;
let mjLoading: Promise<MathJaxHandle> | null = null;

function cacheKey(tex: string, display: boolean): string {
  return `${display ? '1' : '0'}:${tex}`;
}

function markPutOk(k: string): void {
  if (putOk.has(k)) {
    // Refresh LRU order
    const idx = putOkOrder.indexOf(k);
    if (idx >= 0) putOkOrder.splice(idx, 1);
    putOkOrder.push(k);
    return;
  }
  putOk.set(k, true);
  putOkOrder.push(k);
  while (putOkOrder.length > MAX_MATH_CACHE_ENTRIES) {
    const old = putOkOrder.shift();
    if (old) putOk.delete(old);
  }
}

export function resetHarnessMathSession(): void {
  sessionGen += 1;
  putOk.clear();
  putOkOrder.length = 0;
  inFlight.clear();
  queue.length = 0;
  active = 0;
  pumpBridge = null;
}

export function harnessMathSessionGeneration(): number {
  return sessionGen;
}

/** Test/diagnostics: current putOk size (≤ MAX_MATH_CACHE_ENTRIES). */
export function harnessMathPutOkSize(): number {
  return putOk.size;
}

/** Currency / money false-positive gate (mirrors Wasm math.zig). */
export function isCurrencyLike(tex: string): boolean {
  if (!tex || !tex.trim()) return true;
  const t = tex.trim();
  return /^\d[\d,.]*$/.test(t);
}

function hasTexSpecial(tex: string): boolean {
  return /[\\^_={]/.test(tex);
}

function looksLikeMath(tex: string): boolean {
  return /[a-zA-Z\\^_={]/.test(tex);
}

export function acceptInlineTex(tex: string): boolean {
  if (!tex || tex.length > MAX_TEX_LEN) return false;
  if (isCurrencyLike(tex)) return false;
  if (!looksLikeMath(tex)) return false;
  if (/^\d/.test(tex)) {
    const hasWs = /[ \t]/.test(tex);
    if (hasWs && !hasTexSpecial(tex)) return false;
  }
  return true;
}

export function acceptDisplayTex(tex: string): boolean {
  if (!tex || tex.length > MAX_TEX_LEN) return false;
  return tex.trim().length > 0;
}

function isFenceLine(line: string): boolean {
  return /^\s*```/.test(line);
}

/**
 * Extract unique {tex, display} candidates. Fence + inline-code aware.
 * Display first ($$), then inline ($). Currency gate on inline.
 * TeX interiors are trimmed (must match Wasm `trimWs` on store).
 */
export function extractCandidateMath(markdown: string): MathCandidate[] {
  if (!markdown) return [];
  const out: MathCandidate[] = [];
  const seen = new Set<string>();

  const push = (tex: string, display: boolean) => {
    const t = tex.trim();
    if (!t || t.length > MAX_TEX_LEN) return;
    if (display) {
      if (!acceptDisplayTex(t)) return;
    } else if (!acceptInlineTex(t)) {
      return;
    }
    const k = cacheKey(t, display);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ tex: t, display });
  };

  // Work line-oriented for fences; still scan full text for display blocks.
  const lines = markdown.split('\n');
  let inFence = false;
  const proseLines: string[] = [];

  // Multi-line display scan on non-fence regions
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isFenceLine(line)) {
      inFence = !inFence;
      proseLines.push(line);
      i += 1;
      continue;
    }
    if (inFence) {
      proseLines.push(line);
      i += 1;
      continue;
    }

    // Same-line $$...$$
    const same = line.match(/\$\$([^$]+)\$\$/);
    if (same && same.index !== undefined) {
      push(same[1]!, true);
      // keep line for inline scan with display stripped
      proseLines.push(line.replace(/\$\$[^$]+\$\$/g, ' '));
      i += 1;
      continue;
    }

    // Multi-line $$ opener
    if (/^\s*\$\$\s*$/.test(line)) {
      const body: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        const ln = lines[i]!;
        if (isFenceLine(ln)) break;
        if (/^\s*\$\$\s*$/.test(ln)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(ln);
        i += 1;
      }
      if (closed) {
        push(body.join('\n'), true);
      } else {
        proseLines.push(line);
        for (const b of body) proseLines.push(b);
      }
      continue;
    }

    proseLines.push(line);
    i += 1;
  }

  // Inline on prose (not in fences; strip inline code)
  inFence = false;
  for (const line of proseLines) {
    if (isFenceLine(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Mask `code`
    let masked = '';
    let j = 0;
    while (j < line.length) {
      if (line[j] === '`' && (j === 0 || line[j - 1] !== '\\')) {
        const open = j;
        j += 1;
        while (j < line.length && line[j] !== '`') j += 1;
        if (j < line.length && line[j] === '`') {
          masked += ' '.repeat(j - open + 1);
          j += 1;
          continue;
        }
        masked += line[open]!;
        j = open + 1;
        continue;
      }
      masked += line[j]!;
      j += 1;
    }

    j = 0;
    while (j < masked.length) {
      if (masked[j] === '\\' && j + 1 < masked.length && masked[j + 1] === '$') {
        j += 2;
        continue;
      }
      if (masked[j] === '$' && j + 1 < masked.length && masked[j + 1] === '$') {
        j += 2;
        continue;
      }
      if (masked[j] === '$') {
        const open = j;
        j += 1;
        let closed = false;
        let texEnd = j;
        while (j < masked.length) {
          if (masked[j] === '\\' && j + 1 < masked.length) {
            j += 2;
            continue;
          }
          if (masked[j] === '$') {
            if (j + 1 < masked.length && masked[j + 1] === '$') break;
            texEnd = j;
            closed = true;
            j += 1;
            break;
          }
          j += 1;
        }
        if (closed) {
          // Use original line slice for tex (masked spaces only in code)
          const tex = line.slice(open + 1, texEnd);
          push(tex, false);
          continue;
        }
        j = open + 1;
        continue;
      }
      j += 1;
    }
  }

  return out;
}

/**
 * Lazy MathJax TeX→SVG document (path geometry, fontCache none).
 * Client-only; tree-shaken dynamic import.
 */
async function ensureMathJax(): Promise<MathJaxHandle> {
  if (mjHandle) return mjHandle;
  if (mjLoading) return mjLoading;
  mjLoading = (async () => {
    const [
      { mathjax },
      { TeX },
      { SVG },
      { liteAdaptor },
      { RegisterHTMLHandler },
      { AllPackages },
    ] = await Promise.all([
      import('mathjax-full/js/mathjax.js'),
      import('mathjax-full/js/input/tex.js'),
      import('mathjax-full/js/output/svg.js'),
      import('mathjax-full/js/adaptors/liteAdaptor.js'),
      import('mathjax-full/js/handlers/html.js'),
      import('mathjax-full/js/input/tex/AllPackages.js'),
    ]);
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    // AllPackages: ams, base, … — matches stock KaTeX coverage for common agent math.
    const input = new TeX({
      packages: AllPackages,
      formatError: (_jax: unknown, err: Error) => {
        throw err;
      },
    });
    const output = new SVG({ fontCache: 'none' });
    const html = mathjax.document('', {
      InputJax: input,
      OutputJax: output,
    });
    mjHandle = { adaptor, html };
    return mjHandle;
  })();
  try {
    return await mjLoading;
  } catch (e) {
    mjLoading = null;
    throw e;
  }
}

/** Convert TeX to a standalone SVG string (path geometry, black ink). */
export function texToSvgString(
  handle: MathJaxHandle,
  tex: string,
  display: boolean,
): string {
  const { adaptor, html } = handle;
  const node = html.convert(tex, {
    display,
    em: MATH_EM,
    ex: MATH_EX_PX,
    containerWidth: 1200,
  });
  // convert() returns mjx-container; first child is <svg>
  const svgNode = adaptor.firstChild(node);
  let svgStr: string = adaptor.outerHTML(svgNode);
  if (!svgStr.includes('xmlns=')) {
    svgStr = svgStr.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  // MathJax uses currentColor — pin ink for canvas
  if (!/\s(?:color|fill)=/.test(svgStr.slice(0, 80))) {
    svgStr = svgStr.replace('<svg', '<svg color="#111111"');
  }
  return svgStr;
}

/**
 * Raster TeX to non-premultiplied RGBA via MathJax SVG → data-URL image → canvas.
 * Must use data: URLs (blob: taints canvas in Chromium). No HTML foreignObject.
 */
export async function rasterizeTex(
  tex: string,
  display: boolean,
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number } | null> {
  if (typeof document === 'undefined') return null;
  try {
    const handle = await ensureMathJax();
    let svgStr: string;
    try {
      svgStr = texToSvgString(handle, tex, display);
    } catch {
      // Bad TeX / MathJax formatError → Wasm mono fallback
      return null;
    }

    // Size from MathJax width/height in `ex` units
    const widthEx = parseFloat(svgStr.match(/\bwidth="([\d.]+)ex"/)?.[1] ?? '');
    const heightEx = parseFloat(svgStr.match(/\bheight="([\d.]+)ex"/)?.[1] ?? '');
    let w = Math.max(1, Math.ceil((Number.isFinite(widthEx) ? widthEx : 10) * MATH_EX_PX));
    let h = Math.max(1, Math.ceil((Number.isFinite(heightEx) ? heightEx : 2) * MATH_EX_PX));
    // Slight padding so ink is not clipped
    w += display ? 12 : 6;
    h += display ? 10 : 4;

    const maxH = display ? MAX_DISPLAY_MATH_H : MAX_INLINE_MATH_H;
    let scale = 1;
    if (h > maxH) scale = maxH / h;
    if (w * scale > MAX_MATH_EDGE) scale = Math.min(scale, MAX_MATH_EDGE / w);
    if (h * scale > MAX_MATH_EDGE) scale = Math.min(scale, MAX_MATH_EDGE / h);
    const cw = Math.max(1, Math.min(MAX_MATH_EDGE, Math.ceil(w * scale)));
    const ch = Math.max(1, Math.min(MAX_MATH_EDGE, Math.ceil(h * scale)));

    // Explicit pixel size for image decode; white backdrop under transparent SVG
    let sized = svgStr
      .replace(/\bwidth="[^"]*"/, `width="${cw}"`)
      .replace(/\bheight="[^"]*"/, `height="${ch}"`);
    sized = sized.replace(
      /(<svg[^>]*>)/,
      `$1<rect width="100%" height="100%" fill="#ffffff"/>`,
    );

    // data: URL — blob: URLs taint canvas (opaque origin) and break getImageData
    const dataUrl =
      'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized);
    const img = await loadImage(dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch);
    return { rgba: data.data, width: cw, height: ch };
  } catch {
    return null;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('math raster image load failed'));
    img.src = url;
  });
}

function enqueue(c: MathCandidate): void {
  const k = cacheKey(c.tex, c.display);
  if (putOk.has(k) || inFlight.has(k)) return;
  if (queue.some((q) => cacheKey(q.tex, q.display) === k)) return;
  queue.push(c);
}

async function pump(): Promise<void> {
  const bridge = pumpBridge;
  if (!bridge) return;
  const gen = sessionGen;
  while (
    sessionGen === gen &&
    pumpBridge === bridge &&
    active < MAX_CONCURRENT_MATH_RENDERS &&
    queue.length > 0
  ) {
    const c = queue.shift()!;
    const k = cacheKey(c.tex, c.display);
    if (putOk.has(k) || inFlight.has(k)) continue;
    inFlight.add(k);
    active += 1;
    void (async () => {
      try {
        if (sessionGen !== gen || pumpBridge !== bridge) return;
        const raster = await rasterizeTex(c.tex, c.display);
        if (sessionGen !== gen || pumpBridge !== bridge) return;
        if (!raster) return;
        const ok = bridge.mathCachePut(
          c.tex,
          c.display,
          raster.rgba,
          raster.width,
          raster.height,
        );
        if (ok) markPutOk(k);
      } catch {
        // mono fallback in Wasm
      } finally {
        inFlight.delete(k);
        active = Math.max(0, active - 1);
        if (sessionGen === gen && pumpBridge === bridge) void pump();
      }
    })();
  }
}

export function scheduleMathFromMarkdown(
  bridge: HarnessBridge,
  markdown: string,
): void {
  pumpBridge = bridge;
  for (const c of extractCandidateMath(markdown)) {
    enqueue(c);
  }
  void pump();
}

export function scheduleMathFromTexts(
  bridge: HarnessBridge,
  texts: readonly string[],
): void {
  pumpBridge = bridge;
  for (const text of texts) {
    for (const c of extractCandidateMath(text)) {
      enqueue(c);
    }
  }
  void pump();
}
