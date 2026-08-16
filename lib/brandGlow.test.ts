import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRAND_GLOW_BLOOM_INNER_BLUR_PX,
  BRAND_GLOW_BLOOM_INNER_OPACITY,
  BRAND_GLOW_BLOOM_OUTER_BLUR_PX,
  BRAND_GLOW_BLOOM_OUTER_OPACITY,
  BRAND_GLOW_BREATHE_CLASS,
  BRAND_GLOW_FADE_CLASS,
  BRAND_GLOW_FADE_MS,
  BRAND_GLOW_KEYFRAMES,
  BRAND_GLOW_MOTE_CLASS,
  BRAND_GLOW_PARTICLE_COUNT,
  BRAND_GLOW_PARTICLE_DURATION_MAX_MS,
  BRAND_GLOW_PARTICLE_DURATION_MIN_MS,
  BRAND_GLOW_PARTICLE_OPACITY,
  BRAND_GLOW_PARTICLE_OPACITY_MIN,
  BRAND_GLOW_PARTICLE_SIZE_PX,
  BRAND_GLOW_PULSE_MS,
  BRAND_GLOW_SINE_MAX_OPACITY,
  BRAND_GLOW_SINE_MIN_OPACITY,
  brandGlowParticles,
  brandGlowSineOpacity,
  finishGlowEnter,
  glowFadeOpacity,
  glowSubtreeMounted,
  nextGlowMount,
  prefersReducedMotion,
  resolveBrandGlowVisuals,
} from './brandGlow';

describe('resolveBrandGlowVisuals', () => {
  it('idle → nothing', () => {
    expect(
      resolveBrandGlowVisuals({ busy: false, reducedMotion: false }),
    ).toEqual({
      outline: false,
      bloom: false,
      animate: false,
      particles: false,
    });
  });

  it('busy + motion → outline + bloom + animate + particles', () => {
    expect(
      resolveBrandGlowVisuals({ busy: true, reducedMotion: false }),
    ).toEqual({
      outline: true,
      bloom: true,
      animate: true,
      particles: true,
    });
  });

  it('busy + reduced motion → static outline/bloom, no pulse or motes', () => {
    expect(
      resolveBrandGlowVisuals({ busy: true, reducedMotion: true }),
    ).toEqual({
      outline: true,
      bloom: true,
      animate: false,
      particles: false,
    });
  });

  it('idle wins over reduced-motion', () => {
    expect(
      resolveBrandGlowVisuals({ busy: false, reducedMotion: true }),
    ).toEqual({
      outline: false,
      bloom: false,
      animate: false,
      particles: false,
    });
  });
});

describe('brandGlowParticles', () => {
  it('emits the locked wash, unique ids, in-box, slow, brighter, deterministic', () => {
    const a = brandGlowParticles(BRAND_GLOW_PARTICLE_COUNT);
    const b = brandGlowParticles(BRAND_GLOW_PARTICLE_COUNT);
    expect(a).toHaveLength(BRAND_GLOW_PARTICLE_COUNT);
    expect(a).toHaveLength(20);
    expect(a).toEqual(b);
    const ids = new Set(a.map((p) => p.id));
    expect(ids.size).toBe(20);
    for (const p of a) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(100);
      expect(p.opacity).toBeGreaterThanOrEqual(BRAND_GLOW_PARTICLE_OPACITY_MIN);
      expect(p.opacity).toBeLessThanOrEqual(BRAND_GLOW_PARTICLE_OPACITY);
      expect(p.durationMs).toBeGreaterThanOrEqual(
        BRAND_GLOW_PARTICLE_DURATION_MIN_MS,
      );
      expect(p.durationMs).toBeLessThanOrEqual(
        BRAND_GLOW_PARTICLE_DURATION_MAX_MS,
      );
    }
  });
});

describe('caps', () => {
  it('match the plan table', () => {
    expect(BRAND_GLOW_PARTICLE_COUNT).toBe(20);
    expect(BRAND_GLOW_PULSE_MS).toBe(4000);
    expect(BRAND_GLOW_FADE_MS).toBe(280);
    expect(BRAND_GLOW_PARTICLE_SIZE_PX).toBe(2);
    expect(BRAND_GLOW_PARTICLE_OPACITY).toBe(0.75);
    expect(BRAND_GLOW_PARTICLE_OPACITY_MIN).toBe(0.45);
    expect(BRAND_GLOW_PARTICLE_DURATION_MIN_MS).toBe(3000);
    expect(BRAND_GLOW_PARTICLE_DURATION_MAX_MS).toBe(7000);
    expect(BRAND_GLOW_BLOOM_OUTER_BLUR_PX).toBe(16);
    expect(BRAND_GLOW_BLOOM_OUTER_OPACITY).toBe(0.65);
    expect(BRAND_GLOW_BLOOM_INNER_BLUR_PX).toBe(3);
    expect(BRAND_GLOW_BLOOM_INNER_OPACITY).toBe(0.9);
    expect(BRAND_GLOW_SINE_MIN_OPACITY).toBe(0.7);
    expect(BRAND_GLOW_SINE_MAX_OPACITY).toBe(1);
  });
});

describe('brandGlowSineOpacity + generated keyframes', () => {
  const mid =
    (BRAND_GLOW_SINE_MIN_OPACITY + BRAND_GLOW_SINE_MAX_OPACITY) / 2;

  it('0 → mid, 0.25 → max, 0.75 → min', () => {
    expect(brandGlowSineOpacity(0)).toBeCloseTo(mid, 10);
    expect(brandGlowSineOpacity(0.25)).toBeCloseTo(
      BRAND_GLOW_SINE_MAX_OPACITY,
      10,
    );
    expect(brandGlowSineOpacity(0.75)).toBeCloseTo(
      BRAND_GLOW_SINE_MIN_OPACITY,
      10,
    );
  });

  it('keyframes contain generated mid/max/min and drop the old 0.72 pair', () => {
    expect(BRAND_GLOW_KEYFRAMES).toContain(
      `opacity: ${brandGlowSineOpacity(0).toFixed(3)}`,
    );
    expect(BRAND_GLOW_KEYFRAMES).toContain(
      `opacity: ${brandGlowSineOpacity(0.25).toFixed(3)}`,
    );
    expect(BRAND_GLOW_KEYFRAMES).toContain(
      `opacity: ${brandGlowSineOpacity(0.75).toFixed(3)}`,
    );
    expect(BRAND_GLOW_KEYFRAMES).not.toMatch(/0%,\s*100%\s*\{\s*opacity:\s*0\.72/);
    expect(BRAND_GLOW_KEYFRAMES).toMatch(/25%\s*\{\s*opacity:/);
    expect(BRAND_GLOW_KEYFRAMES).toMatch(/75%\s*\{\s*opacity:/);
  });
});

describe('prefersReducedMotion', () => {
  it('no window / matchMedia → true (fail toward less motion)', () => {
    expect(typeof window).toBe('undefined');
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe('nextGlowMount', () => {
  it('unmounted + busy → entering (opacity-0 first paint)', () => {
    expect(nextGlowMount('unmounted', true, 0)).toBe('entering');
  });
  it('entering + busy → on', () => {
    expect(nextGlowMount('entering', true, 0)).toBe('on');
  });
  it('unmounted + idle → unmounted', () => {
    expect(nextGlowMount('unmounted', false, 0)).toBe('unmounted');
  });
  it('entering + idle → unmounted (never became visible)', () => {
    expect(nextGlowMount('entering', false, 0)).toBe('unmounted');
  });
  it('on + busy → on', () => {
    expect(nextGlowMount('on', true, 0)).toBe('on');
  });
  it('on + idle → fading', () => {
    expect(nextGlowMount('on', false, 0)).toBe('fading');
  });
  it('fading + busy → on (cancel unmount)', () => {
    expect(nextGlowMount('fading', true, 100)).toBe('on');
  });
  it('fading + idle + elapsed < fadeMs → fading', () => {
    expect(nextGlowMount('fading', false, BRAND_GLOW_FADE_MS - 1)).toBe(
      'fading',
    );
  });
  it('fading + idle + elapsed >= fadeMs → unmounted', () => {
    expect(nextGlowMount('fading', false, BRAND_GLOW_FADE_MS)).toBe(
      'unmounted',
    );
  });
});

describe('finishGlowEnter / fade opacity', () => {
  it('entering → on; other states unchanged', () => {
    expect(finishGlowEnter('entering')).toBe('on');
    expect(finishGlowEnter('on')).toBe('on');
    expect(finishGlowEnter('fading')).toBe('fading');
    expect(finishGlowEnter('unmounted')).toBe('unmounted');
  });
  it('only `on` is fully opaque; entering/fading are 0 so the transition can run', () => {
    expect(glowFadeOpacity('on')).toBe(1);
    expect(glowFadeOpacity('entering')).toBe(0);
    expect(glowFadeOpacity('fading')).toBe(0);
    expect(glowFadeOpacity('unmounted')).toBe(0);
  });
  it('subtree is mounted for entering/on/fading', () => {
    expect(glowSubtreeMounted('unmounted')).toBe(false);
    expect(glowSubtreeMounted('entering')).toBe(true);
    expect(glowSubtreeMounted('on')).toBe(true);
    expect(glowSubtreeMounted('fading')).toBe(true);
  });
});

describe('layer contract (CSS animation must not steal fade / cap opacity)', () => {
  const nav = readFileSync('app/components/AppNav.tsx', 'utf8');

  it('keyframes keep breathe and mote-life as named animations', () => {
    expect(BRAND_GLOW_KEYFRAMES).toMatch(/@keyframes inv-brand-breathe/);
    expect(BRAND_GLOW_KEYFRAMES).toMatch(/@keyframes inv-brand-mote/);
    expect(BRAND_GLOW_KEYFRAMES).toMatch(
      new RegExp(`\\.${BRAND_GLOW_BREATHE_CLASS}`),
    );
    expect(BRAND_GLOW_KEYFRAMES).toMatch(
      new RegExp(`\\.${BRAND_GLOW_MOTE_CLASS}`),
    );
  });

  it('AppNav puts fade transition and sine animation on different classNames', () => {
    expect(nav).toContain(`className={BRAND_GLOW_FADE_CLASS}`);
    expect(nav).toContain(`className={BRAND_GLOW_BREATHE_CLASS}`);
    expect(nav).toContain(`className={BRAND_GLOW_MOTE_CLASS}`);
    expect(BRAND_GLOW_FADE_CLASS).not.toBe(BRAND_GLOW_BREATHE_CLASS);
    expect(BRAND_GLOW_MOTE_CLASS).not.toBe(BRAND_GLOW_FADE_CLASS);

    const fadeIdx = nav.indexOf('className={BRAND_GLOW_FADE_CLASS}');
    const breatheIdx = nav.indexOf('className={BRAND_GLOW_BREATHE_CLASS}');
    const fadeBlock = nav.slice(fadeIdx, breatheIdx);
    expect(fadeBlock).toMatch(/transition:/);
    expect(fadeBlock).toMatch(/glowFadeOpacity/);
    expect(fadeBlock).not.toMatch(/inv-brand-breathe/);
    expect(fadeBlock).not.toMatch(/animation:/);
  });

  it('AppNav sine uses PULSE_MS + linear, not ease-in-out', () => {
    expect(nav).toMatch(
      /inv-brand-breathe \$\{BRAND_GLOW_PULSE_MS\}ms linear infinite/,
    );
    const breatheIdx = nav.indexOf('className={BRAND_GLOW_BREATHE_CLASS}');
    const breatheBlock = nav.slice(breatheIdx, breatheIdx + 400);
    expect(breatheBlock).not.toMatch(/ease-in-out/);
  });

  it('mote cap opacity is on a parent; animated node does not set p.opacity', () => {
    const moteIdx = nav.indexOf('className={BRAND_GLOW_MOTE_CLASS}');
    expect(moteIdx).toBeGreaterThan(0);
    const capIdx = nav.lastIndexOf('opacity: p.opacity', moteIdx);
    expect(capIdx).toBeGreaterThan(0);
    expect(capIdx).toBeLessThan(moteIdx);
    const animatedBlock = nav.slice(moteIdx, moteIdx + 600);
    expect(animatedBlock).not.toMatch(/opacity:\s*p\.opacity/);
    expect(animatedBlock).toMatch(/inv-brand-mote/);
  });

  it('AppNav bloom interpolates named caps; no leftover timid literals', () => {
    expect(nav).toContain('BRAND_GLOW_BLOOM_OUTER_BLUR_PX');
    expect(nav).toContain('BRAND_GLOW_BLOOM_OUTER_OPACITY');
    expect(nav).toContain('BRAND_GLOW_BLOOM_INNER_BLUR_PX');
    expect(nav).toContain('BRAND_GLOW_BLOOM_INNER_OPACITY');
    expect(nav).not.toMatch(/blur\(10px\)/);
    expect(nav).not.toMatch(/blur\(4px\)/);
    expect(nav).not.toMatch(/opacity:\s*0\.35/);
    expect(nav).not.toMatch(/opacity:\s*0\.55/);
  });
});

describe('no hex / no warm-ember in brand files', () => {
  it('lib/brandGlow.ts and AppNav.tsx stay token-only', () => {
    const glow = readFileSync('lib/brandGlow.ts', 'utf8');
    const nav = readFileSync('app/components/AppNav.tsx', 'utf8');
    expect(glow).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(nav).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(glow).not.toMatch(/\bwarm\b|\bember\b/);
    expect(nav).not.toMatch(/\bwarm\b|\bember\b/);
    expect(nav).toContain('teal.text');
  });
});
