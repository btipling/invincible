import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRAND_GLOW_FADE_MS,
  BRAND_GLOW_PARTICLE_COUNT,
  BRAND_GLOW_PARTICLE_DURATION_MAX_MS,
  BRAND_GLOW_PARTICLE_DURATION_MIN_MS,
  BRAND_GLOW_PARTICLE_OPACITY,
  BRAND_GLOW_PARTICLE_SIZE_PX,
  BRAND_GLOW_PULSE_MS,
  brandGlowParticles,
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
  it('emits the locked handful, unique ids, in-box, slow, subtle, deterministic', () => {
    const a = brandGlowParticles(BRAND_GLOW_PARTICLE_COUNT);
    const b = brandGlowParticles(BRAND_GLOW_PARTICLE_COUNT);
    expect(a).toHaveLength(8);
    expect(a).toEqual(b);
    const ids = new Set(a.map((p) => p.id));
    expect(ids.size).toBe(8);
    for (const p of a) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(100);
      expect(p.opacity).toBeGreaterThan(0);
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
    expect(BRAND_GLOW_PARTICLE_COUNT).toBe(8);
    expect(BRAND_GLOW_PULSE_MS).toBe(4000);
    expect(BRAND_GLOW_FADE_MS).toBe(280);
    expect(BRAND_GLOW_PARTICLE_SIZE_PX).toBe(2);
    expect(BRAND_GLOW_PARTICLE_OPACITY).toBe(0.35);
    expect(BRAND_GLOW_PARTICLE_DURATION_MIN_MS).toBe(3000);
    expect(BRAND_GLOW_PARTICLE_DURATION_MAX_MS).toBe(7000);
  });
});

describe('prefersReducedMotion', () => {
  it('no window / matchMedia → true (fail toward less motion)', () => {
    expect(typeof window).toBe('undefined');
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe('nextGlowMount', () => {
  it('unmounted + busy → on', () => {
    expect(nextGlowMount('unmounted', true, 0)).toBe('on');
  });
  it('unmounted + idle → unmounted', () => {
    expect(nextGlowMount('unmounted', false, 0)).toBe('unmounted');
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

describe('no hex / no warm-ember in brand files', () => {
  it('lib/brandGlow.ts and AppNav.tsx stay token-only', () => {
    const glow = readFileSync('lib/brandGlow.ts', 'utf8');
    const nav = readFileSync('app/components/AppNav.tsx', 'utf8');
    expect(glow).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(nav).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(glow).not.toMatch(/\bwarm\b|\bember\b/);
    expect(nav).not.toMatch(/\bwarm\b|\bember\b/);
  });
});
