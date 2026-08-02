/**
 * Color palettes for the game.
 *
 * TEAL  – primary monotone (asteroid mesh + UI chrome + sky cool)
 * WARM  – complementary monotone (amber #D47C2C — fighter / fire / lasers / missiles / reticle)
 * EMBER – red-orange #D4412C — **player danger only**:
 *         hit vignette, critical/dead hull fill+label, collision outline HDR.
 *         Forbidden: nearby names, weapons, sky, dust/sparks/shards fire VFX.
 *
 * Complementary of teal (~hue 175–185°) is amber (~hue ~30°) for WARM.
 * EMBER is a redder heat family than WARM — use only on authorized player-danger channels
 * (docs/arcade-cockpit-hud-plan.md). Sky / weapons / fire VFX stay TEAL + WARM.
 */

export type RGB = readonly [number, number, number]; // 0–1 linear-ish

/**
 * Teal monotone shades – ordered dark → light.
 * Extended near-black end for deep outer-space sky while remaining recognizably teal.
 * Slight saturation variation keeps rock surfaces and nebulae from looking flat.
 * Darkest entries pushed further toward black so dense sky mesh reads as true void.
 */
export const TEAL_PALETTE: RGB[] = [
  // Near-black teals (sky void) – darker for space-like density
  [0.005, 0.014, 0.016], // almost black, faint teal
  [0.009, 0.024, 0.028],
  [0.014, 0.036, 0.042],
  [0.020, 0.050, 0.058],
  [0.028, 0.068, 0.078],
  [0.038, 0.092, 0.105],
  // Original deep range
  [0.060, 0.155, 0.172],
  [0.080, 0.195, 0.215],
  [0.105, 0.240, 0.265],
  [0.130, 0.290, 0.320],
  [0.160, 0.345, 0.375],
  [0.195, 0.405, 0.435],
  [0.235, 0.470, 0.500],
  [0.280, 0.535, 0.565],
  [0.330, 0.600, 0.625],
  [0.385, 0.665, 0.685], // lightest highlight
];

/**
 * Warm complementary monotone — amber family (#D47C2C at index 6).
 * Index contract (do not renumber casually):
 *   [1] laser tail · [3] dust warm / shards · [4] laser side / missile body
 *   [6] exact #D47C2C · [7] laser tip / sparks · [8] missile nose
 */
export const WARM_PALETTE: RGB[] = [
  [0.100, 0.058, 0.018], // 0 deep amber-brown
  [0.196, 0.114, 0.038], // 1
  [0.313, 0.183, 0.063], // 2
  [0.439, 0.257, 0.089], // 3
  [0.572, 0.335, 0.118], // 4
  [0.711, 0.416, 0.147], // 5
  [0.831, 0.486, 0.173], // 6  ← EXACT #D47C2C
  [0.857, 0.569, 0.303], // 7
  [0.880, 0.642, 0.416], // 8
  [0.902, 0.714, 0.529], // 9 light cream-amber
];

/** Convenience CSS hex values derived from the teal family */
export const teal = {
  /** Near-black teal background */
  bg: '#050a0c',
  /** Slightly elevated surface (header, panels) */
  surface: '#0a1215',
  /** Borders / dividers */
  border: '#152528',
  /** Muted secondary text */
  muted: '#4a7a80',
  /** Primary readable text */
  text: '#c0e0e4',
  /** Bright interactive accent (buttons, focus) */
  accent: '#2dd4bf',
  /** Darker accent for hover / pressed */
  accentDark: '#14b8a6',
  /** Very dark for WebGPU clear / canvas fallback */
  clear: '#03080a',
} as const;

/** Warm CSS tokens (amber). Used by HUD / debug. */
export const warm = {
  bg: '#120c08',
  surface: '#1a120c',
  border: '#3a2818',
  muted: '#a87850',
  text: '#f0dcc8',
  accent: '#d47c2c',
  accentDark: '#b86620',
} as const;

/**
 * Linear warm.accent (#d47c2c) — same reference as WARM_PALETTE[6].
 * Shared by reticle / aim-assist in-beam / edge defaults (avoid multi-site literals).
 */
export const WARM_ACCENT_RGB: RGB = WARM_PALETTE[6];

/**
 * Linear warm.text (#f0dcc8) cream — proximity markers / soft warm UI.
 * Keep in sync with `warm.text` hex (hex/255 linear-ish).
 */
export const WARM_TEXT_RGB: RGB = [0.941, 0.863, 0.784];

/**
 * Hotter amber exhaust / nozzle glow (off-ramp emissive exception).
 * Not required ∈ WARM_PALETTE. Shared fighter nozzle + missile exhaust.
 */
export const WARM_EXHAUST_RGB: RGB = [1.0, 0.62, 0.22];

/**
 * Ember monotone — red-orange (#D4412C at index 6).
 * Authorized product importers: hit vignette, cockpit hull critical/dead,
 * collision outline (`OUTLINE_EMBER_RGB` / EMBER_PALETTE[6]).
 * Do not sample for sky, weapons, reticle, aim-assist, dust, sparks, or shards.
 */
export const EMBER_PALETTE: RGB[] = [
  [0.100, 0.031, 0.018], // 0
  [0.196, 0.060, 0.038], // 1
  [0.313, 0.096, 0.063], // 2
  [0.439, 0.135, 0.089], // 3
  [0.572, 0.175, 0.118], // 4
  [0.711, 0.218, 0.147], // 5
  [0.831, 0.255, 0.173], // 6  ← EXACT #D4412C
  [0.857, 0.384, 0.303], // 7
  [0.880, 0.497, 0.416], // 8
  [0.902, 0.610, 0.529], // 9
];

/** Ember CSS tokens — player-danger HUD chrome (critical hull); not nearby names. */
export const ember = {
  bg: '#120a08',
  surface: '#1a100c',
  border: '#3a1e18',
  muted: '#a86050',
  text: '#f0d0c8',
  accent: '#d4412c',
  accentDark: '#b83420',
} as const;
