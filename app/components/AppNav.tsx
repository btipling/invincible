'use client';
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import {
  BRAND_GLOW_BREATHE_CLASS,
  BRAND_GLOW_FADE_CLASS,
  BRAND_GLOW_FADE_MS,
  BRAND_GLOW_KEYFRAMES,
  BRAND_GLOW_MOTE_CLASS,
  BRAND_GLOW_PARTICLE_COUNT,
  BRAND_GLOW_PARTICLE_SIZE_PX,
  BRAND_GLOW_PULSE_MS,
  brandGlowParticles,
  finishGlowEnter,
  glowFadeOpacity,
  glowSubtreeMounted,
  nextGlowMount,
  prefersReducedMotion,
  resolveBrandGlowVisuals,
  type GlowMount,
} from '../../lib/brandGlow';
import { teal } from '../../lib/palette';

const focusRing = `0 0 0 2px ${teal.bg}, 0 0 0 4px ${teal.accent}`;

const WORDMARK = 'Invincible';

/** Shared type metrics — fill is the only in-flow text; clones must match. */
const brandType: CSSProperties = {
  margin: 0,
  fontSize: '1.15rem',
  fontWeight: 600,
  letterSpacing: '0.04em',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

/** Site header: brand + optional right slot (session/persona/Clear/auth). */
export default function AppNav({
  right,
  busy = false,
}: {
  right?: ReactNode;
  busy?: boolean;
}) {
  const [reducedMotion, setReducedMotion] = useState(true);
  const [mount, setMount] = useState<GlowMount>('unmounted');
  const motes = useMemo(
    () => brandGlowParticles(BRAND_GLOW_PARTICLE_COUNT),
    [],
  );

  useEffect(() => {
    const sync = () => setReducedMotion(prefersReducedMotion());
    sync();
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (busy) {
      setMount((cur) => nextGlowMount(cur, true, 0));
      let inner = 0;
      const outer = window.requestAnimationFrame(() => {
        inner = window.requestAnimationFrame(() => {
          setMount((cur) => finishGlowEnter(cur));
        });
      });
      return () => {
        window.cancelAnimationFrame(outer);
        window.cancelAnimationFrame(inner);
      };
    }
    let fading = false;
    setMount((cur) => {
      const next = nextGlowMount(cur, false, 0);
      fading = next === 'fading';
      return next;
    });
    if (!fading) return;
    const id = window.setTimeout(() => {
      setMount((cur) => nextGlowMount(cur, false, BRAND_GLOW_FADE_MS));
    }, BRAND_GLOW_FADE_MS + 50);
    return () => window.clearTimeout(id);
  }, [busy]);

  const showGlow = glowSubtreeMounted(mount);
  const visuals = resolveBrandGlowVisuals({
    busy: showGlow,
    reducedMotion,
  });

  return (
    <header
      style={{
        borderBottom: `1px solid ${teal.border}`,
        background: teal.surface,
        padding: '0.85rem 1.25rem',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.75rem 1rem',
        flexShrink: 0,
      }}
    >
      <style>{BRAND_GLOW_KEYFRAMES}</style>
      <span
        style={{
          ...brandType,
          position: 'relative',
          display: 'inline-block',
          maxWidth: '100%',
          color: teal.text,
          borderRadius: 4,
          outline: 'none',
        }}
      >
        {WORDMARK}
        {showGlow ? (
          <span
            className={BRAND_GLOW_FADE_CLASS}
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              opacity: glowFadeOpacity(mount),
              transition: `opacity ${BRAND_GLOW_FADE_MS}ms ease`,
            }}
          >
            <span
              className={BRAND_GLOW_BREATHE_CLASS}
              style={{
                position: 'absolute',
                inset: 0,
                animation: visuals.animate
                  ? `inv-brand-breathe ${BRAND_GLOW_PULSE_MS}ms ease-in-out infinite`
                  : 'none',
              }}
            >
              {visuals.bloom ? (
                <>
                  <span
                    style={{
                      ...brandType,
                      position: 'absolute',
                      inset: 0,
                      color: teal.accentDark,
                      filter: 'blur(10px)',
                      opacity: 0.35,
                    }}
                  >
                    {WORDMARK}
                  </span>
                  <span
                    style={{
                      ...brandType,
                      position: 'absolute',
                      inset: 0,
                      color: teal.accent,
                      filter: 'blur(4px)',
                      opacity: 0.55,
                    }}
                  >
                    {WORDMARK}
                  </span>
                </>
              ) : null}
              {visuals.outline ? (
                <span
                  style={{
                    ...brandType,
                    position: 'absolute',
                    inset: 0,
                    color: 'transparent',
                    WebkitTextStroke: `1px ${teal.accent}`,
                  }}
                >
                  {WORDMARK}
                </span>
              ) : null}
              {visuals.particles ? (
                <span
                  style={{
                    position: 'absolute',
                    inset: 0,
                    overflow: 'hidden',
                    pointerEvents: 'none',
                  }}
                >
                  {motes.map((p) => (
                    <span
                      key={p.id}
                      style={{
                        position: 'absolute',
                        left: `${p.x}%`,
                        top: `${p.y}%`,
                        width: BRAND_GLOW_PARTICLE_SIZE_PX,
                        height: BRAND_GLOW_PARTICLE_SIZE_PX,
                        opacity: p.opacity,
                      }}
                    >
                      <span
                        className={BRAND_GLOW_MOTE_CLASS}
                        style={{
                          display: 'block',
                          width: '100%',
                          height: '100%',
                          borderRadius: '50%',
                          background: teal.accent,
                          animation: `inv-brand-mote ${p.durationMs}ms ease-in-out ${p.delayMs}ms infinite`,
                          ['--inv-dx' as string]: `${p.driftX}px`,
                          ['--inv-dy' as string]: `${p.driftY}px`,
                        }}
                      />
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
          </span>
        ) : null}
      </span>
      {right ? (
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}
        >
          {right}
        </div>
      ) : null}
    </header>
  );
}

export { focusRing };
