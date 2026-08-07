/**
 * Protocol v5 — host-side MD math extract, KaTeX render, raster, Wasm cache put.
 * IR paint truth stays in Wasm; this module only schedules browser KaTeX for formulas.
 */

import type { HarnessBridge } from './harnessBridge';

/** Caps locked in plan #221. Must match `math_cache.MAX_ENTRIES` / `MAX_TEX_LEN`. */
export const MAX_TEX_LEN = 512 as const;
export const MAX_MATH_CACHE_ENTRIES = 48 as const;
export const MAX_CONCURRENT_MATH_RENDERS = 3 as const;
export const MAX_MATH_EDGE = 1280 as const;
export const MAX_INLINE_MATH_H = 64 as const;
export const MAX_DISPLAY_MATH_H = 320 as const;

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

/** Offscreen host (lazy). */
let hostEl: HTMLElement | null = null;
let katexMod: typeof import('katex') | null = null;
let cssReady = false;

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

async function ensureKatex(): Promise<typeof import('katex')> {
  if (katexMod) return katexMod;
  katexMod = await import('katex');
  if (!cssReady && typeof document !== 'undefined') {
    try {
      // Side-effect CSS for correct metrics/fonts in offscreen host.
      await import('katex/dist/katex.min.css');
    } catch {
      // CSS optional in unit tests without CSS bundler.
    }
    cssReady = true;
  }
  return katexMod;
}

function ensureHost(): HTMLElement {
  if (hostEl && hostEl.isConnected) return hostEl;
  hostEl = document.createElement('div');
  hostEl.setAttribute('data-harness-math-host', '1');
  hostEl.style.cssText =
    'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;z-index:-1;';
  document.body.appendChild(hostEl);
  return hostEl;
}

/** Raster KaTeX HTML to non-premultiplied RGBA via canvas. */
export async function rasterizeTex(
  tex: string,
  display: boolean,
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number } | null> {
  if (typeof document === 'undefined') return null;
  const katex = await ensureKatex();
  const host = ensureHost();
  const wrap = document.createElement('div');
  wrap.style.cssText = display
    ? 'display:inline-block;padding:4px 8px;background:#ffffff;color:#111111;font-size:18px;line-height:1.2;'
    : 'display:inline-block;padding:1px 2px;background:#ffffff;color:#111111;font-size:16px;line-height:1.2;';
  try {
    const html = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      output: 'html',
    });
    wrap.innerHTML = html;
  } catch {
    return null;
  }
  host.appendChild(wrap);
  try {
    // Force layout
    const rect = wrap.getBoundingClientRect();
    let w = Math.max(1, Math.ceil(rect.width) || wrap.offsetWidth || 1);
    let h = Math.max(1, Math.ceil(rect.height) || wrap.offsetHeight || 1);
    const maxH = display ? MAX_DISPLAY_MATH_H : MAX_INLINE_MATH_H;
    let scale = 1;
    if (h > maxH) scale = maxH / h;
    if (w * scale > MAX_MATH_EDGE) scale = Math.min(scale, MAX_MATH_EDGE / w);
    if (h * scale > MAX_MATH_EDGE) scale = Math.min(scale, MAX_MATH_EDGE / h);
    const cw = Math.max(1, Math.min(MAX_MATH_EDGE, Math.ceil(w * scale)));
    const ch = Math.max(1, Math.min(MAX_MATH_EDGE, Math.ceil(h * scale)));

    // Collect loaded stylesheets text (katex) for foreignObject isolation.
    let cssText = '';
    try {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const rules = sheet.cssRules;
          if (!rules) continue;
          for (const rule of Array.from(rules)) {
            cssText += rule.cssText + '\n';
          }
        } catch {
          // cross-origin sheet
        }
      }
    } catch {
      /* ignore */
    }

    const serialized = new XMLSerializer().serializeToString(wrap);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}">` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="transform:scale(${scale});transform-origin:top left;background:#ffffff;color:#111111;">` +
      (cssText ? `<style>${cssText.replace(/]]>/g, '')}</style>` : '') +
      `${serialized}` +
      `</div></foreignObject></svg>`;

    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch);
      return { rgba: data.data, width: cw, height: ch };
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    wrap.remove();
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
