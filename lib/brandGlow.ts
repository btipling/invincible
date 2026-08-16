/**
 * AppNav Busy-brand visuals — pure helpers + caps.
 * DOM site chrome only. Driven by HarnessHost `busy`; never poll the bridge.
 *
 * Layer contract (do not collapse — CSS animations override transitions on
 * the same property, and keyframe `opacity` replaces the cascade value):
 *   `.inv-brand-fade`  — only the Busy on/off opacity transition
 *   `.inv-brand-glow`  — sine of glow-layer opacity (not the fade node)
 *   mote parent        — `p.opacity` cap (≤ BRAND_GLOW_PARTICLE_OPACITY)
 *   `.inv-brand-mote`  — transform + life-cycle opacity 0→1→0 (multiplies cap)
 */

export const BRAND_GLOW_PARTICLE_COUNT = 20;
export const BRAND_GLOW_PULSE_MS = 4000;
export const BRAND_GLOW_FADE_MS = 280;
export const BRAND_GLOW_PARTICLE_OPACITY = 0.75;
export const BRAND_GLOW_PARTICLE_OPACITY_MIN = 0.45;
export const BRAND_GLOW_PARTICLE_SIZE_PX = 2;
export const BRAND_GLOW_PARTICLE_DURATION_MIN_MS = 3000;
export const BRAND_GLOW_PARTICLE_DURATION_MAX_MS = 7000;

export const BRAND_GLOW_BLOOM_OUTER_BLUR_PX = 16;
export const BRAND_GLOW_BLOOM_OUTER_OPACITY = 0.65;
export const BRAND_GLOW_BLOOM_INNER_BLUR_PX = 3;
export const BRAND_GLOW_BLOOM_INNER_OPACITY = 0.9;

export const BRAND_GLOW_SINE_MIN_OPACITY = 0.7;
export const BRAND_GLOW_SINE_MAX_OPACITY = 1;

export const BRAND_GLOW_FADE_CLASS = 'inv-brand-fade';
export const BRAND_GLOW_BREATHE_CLASS = 'inv-brand-glow';
export const BRAND_GLOW_MOTE_CLASS = 'inv-brand-mote';

const SINE_KEYFRAME_PCTS = [0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];

/** Glow-layer opacity at unit time t in [0, 1] — mid + amp * sin(2π t). */
export function brandGlowSineOpacity(t01: number): number {
  const min = BRAND_GLOW_SINE_MIN_OPACITY;
  const max = BRAND_GLOW_SINE_MAX_OPACITY;
  const mid = (min + max) / 2;
  const amp = (max - min) / 2;
  return mid + amp * Math.sin(2 * Math.PI * t01);
}

function sineKeyframes(): string {
  const lines = SINE_KEYFRAME_PCTS.map((pct) => {
    const opacity = brandGlowSineOpacity(pct / 100).toFixed(3);
    return `  ${pct}% { opacity: ${opacity}; }`;
  });
  return `@keyframes inv-brand-breathe {\n${lines.join('\n')}\n}`;
}

export const BRAND_GLOW_KEYFRAMES = `
${sineKeyframes()}
@keyframes inv-brand-mote {
  0% { transform: translate(0, 0); opacity: 0; }
  18% { opacity: 1; }
  82% { opacity: 1; }
  100% { transform: translate(var(--inv-dx), var(--inv-dy)); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .${BRAND_GLOW_BREATHE_CLASS}, .${BRAND_GLOW_MOTE_CLASS} { animation: none !important; }
}
`;

export type BrandGlowParticle = {
  id: string;
  x: number;
  y: number;
  delayMs: number;
  durationMs: number;
  driftX: number;
  driftY: number;
  opacity: number;
};

export type BrandGlowVisuals = {
  outline: boolean;
  bloom: boolean;
  animate: boolean;
  particles: boolean;
};

export type GlowMount = 'unmounted' | 'entering' | 'on' | 'fading';

/** Unit interval in [0, 1) from a deterministic hash of `n`. */
function unit(n: number): number {
  const x = Math.sin(n) * 43758.5453;
  return x - Math.floor(x);
}

export function resolveBrandGlowVisuals(opts: {
  busy: boolean;
  reducedMotion: boolean;
}): BrandGlowVisuals {
  if (!opts.busy) {
    return { outline: false, bloom: false, animate: false, particles: false };
  }
  if (opts.reducedMotion) {
    return { outline: true, bloom: true, animate: false, particles: false };
  }
  return { outline: true, bloom: true, animate: true, particles: true };
}

/**
 * Glow subtree mount machine.
 * Busy from unmounted goes through `entering` (opacity 0) so the fade
 * transition has a from-value. Other busy arrivals cancel fade → `on`.
 * Idle `entering` never painted → unmount. Unmount only after fadeMs while fading.
 */
export function nextGlowMount(
  current: GlowMount,
  busy: boolean,
  fadeElapsedMs: number,
  fadeMs: number = BRAND_GLOW_FADE_MS,
): GlowMount {
  if (busy) {
    if (current === 'unmounted') return 'entering';
    return 'on';
  }
  if (current === 'unmounted' || current === 'entering') return 'unmounted';
  if (current === 'on') return 'fading';
  return fadeElapsedMs >= fadeMs ? 'unmounted' : 'fading';
}

/** Finish the enter frame: first paint was opacity 0, now transition to 1. */
export function finishGlowEnter(current: GlowMount): GlowMount {
  return current === 'entering' ? 'on' : current;
}

export function glowSubtreeMounted(mount: GlowMount): boolean {
  return mount !== 'unmounted';
}

/** Fade wrapper opacity — only `on` is 1; entering/fading stay 0 so CSS can tween. */
export function glowFadeOpacity(mount: GlowMount): 0 | 1 {
  return mount === 'on' ? 1 : 0;
}

/**
 * Fail toward less motion when `window` / `matchMedia` is missing
 * (SSR, node tests). CSS `@media (prefers-reduced-motion)` is still
 * the first-paint kill-switch in AppNav.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Deterministic mote specs — same inputs always yield the same wash. */
export function brandGlowParticles(
  count: number = BRAND_GLOW_PARTICLE_COUNT,
): BrandGlowParticle[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const span =
    BRAND_GLOW_PARTICLE_DURATION_MAX_MS - BRAND_GLOW_PARTICLE_DURATION_MIN_MS;
  const band = BRAND_GLOW_PARTICLE_OPACITY - BRAND_GLOW_PARTICLE_OPACITY_MIN;
  const out: BrandGlowParticle[] = [];
  for (let i = 0; i < n; i++) {
    const seed = (i + 1) * 127.1;
    const durationMs =
      BRAND_GLOW_PARTICLE_DURATION_MIN_MS + Math.round(unit(seed) * span);
    const opacity = BRAND_GLOW_PARTICLE_OPACITY_MIN + unit(seed + 7) * band;
    out.push({
      id: `mote-${i}`,
      x: 8 + unit(seed + 19.2) * 84,
      y: 15 + unit(seed + 41.7) * 70,
      delayMs: Math.round(unit(seed + 73.3) * 2200),
      durationMs,
      driftX: (unit(seed + 3) - 0.5) * 18,
      driftY: -8 - unit(seed + 5) * 14,
      opacity,
    });
  }
  return out;
}
