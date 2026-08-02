import { describe, expect, it } from 'vitest';
import {
  EMBER_PALETTE,
  TEAL_PALETTE,
  WARM_ACCENT_RGB,
  WARM_EXHAUST_RGB,
  WARM_PALETTE,
  WARM_TEXT_RGB,
  ember,
  teal,
  warm,
  type RGB,
} from './palette';

/** Pre-phase live TEAL_PALETTE golden (must stay byte-identical). */
const TEAL_GOLDEN: RGB[] = [
  [0.005, 0.014, 0.016],
  [0.009, 0.024, 0.028],
  [0.014, 0.036, 0.042],
  [0.02, 0.05, 0.058],
  [0.028, 0.068, 0.078],
  [0.038, 0.092, 0.105],
  [0.06, 0.155, 0.172],
  [0.08, 0.195, 0.215],
  [0.105, 0.24, 0.265],
  [0.13, 0.29, 0.32],
  [0.16, 0.345, 0.375],
  [0.195, 0.405, 0.435],
  [0.235, 0.47, 0.5],
  [0.28, 0.535, 0.565],
  [0.33, 0.6, 0.625],
  [0.385, 0.665, 0.685],
];

const WARM_GOLDEN: RGB[] = [
  [0.1, 0.058, 0.018],
  [0.196, 0.114, 0.038],
  [0.313, 0.183, 0.063],
  [0.439, 0.257, 0.089],
  [0.572, 0.335, 0.118],
  [0.711, 0.416, 0.147],
  [0.831, 0.486, 0.173],
  [0.857, 0.569, 0.303],
  [0.88, 0.642, 0.416],
  [0.902, 0.714, 0.529],
];

const EMBER_GOLDEN: RGB[] = [
  [0.1, 0.031, 0.018],
  [0.196, 0.06, 0.038],
  [0.313, 0.096, 0.063],
  [0.439, 0.135, 0.089],
  [0.572, 0.175, 0.118],
  [0.711, 0.218, 0.147],
  [0.831, 0.255, 0.173],
  [0.857, 0.384, 0.303],
  [0.88, 0.497, 0.416],
  [0.902, 0.61, 0.529],
];

function sumRgb(c: RGB): number {
  return c[0] + c[1] + c[2];
}

function isPureBlueCyan(c: RGB): boolean {
  const [r, g, b] = c;
  return b > 0.5 && r < 0.3 && g < 0.5;
}

function expectCloseRgb(actual: RGB, expected: RGB, digits = 3): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

describe('palette lengths and anchors (T1–T5)', () => {
  it('T1: warm and ember ramps are length 10', () => {
    expect(WARM_PALETTE.length).toBe(10);
    expect(EMBER_PALETTE.length).toBe(10);
  });

  it('T2: full warm CSS tokens match locked amber set', () => {
    expect(warm).toEqual({
      bg: '#120c08',
      surface: '#1a120c',
      border: '#3a2818',
      muted: '#a87850',
      text: '#f0dcc8',
      accent: '#d47c2c',
      accentDark: '#b86620',
    });
  });

  it('T3: full ember CSS tokens match locked authorized set', () => {
    expect(ember).toEqual({
      bg: '#120a08',
      surface: '#1a100c',
      border: '#3a1e18',
      muted: '#a86050',
      text: '#f0d0c8',
      accent: '#d4412c',
      accentDark: '#b83420',
    });
  });

  it('T4: WARM_PALETTE[6] matches linear #D47C2C within 0.002', () => {
    const expected: RGB = [0.831, 0.486, 0.173];
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(WARM_PALETTE[6][i] - expected[i])).toBeLessThanOrEqual(0.002);
    }
  });

  it('T5: EMBER_PALETTE[6] matches linear #D4412C within 0.002', () => {
    const expected: RGB = [0.831, 0.255, 0.173];
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(EMBER_PALETTE[6][i] - expected[i])).toBeLessThanOrEqual(0.002);
    }
  });
});

describe('palette ramp shape (T6–T9, T12–T14)', () => {
  it('T6: warm R and sum(RGB) are non-decreasing', () => {
    for (let i = 0; i < 9; i++) {
      expect(WARM_PALETTE[i + 1][0]).toBeGreaterThanOrEqual(WARM_PALETTE[i][0] - 1e-9);
      expect(sumRgb(WARM_PALETTE[i + 1])).toBeGreaterThanOrEqual(sumRgb(WARM_PALETTE[i]) - 1e-9);
    }
  });

  it('T7: ember R and sum(RGB) are non-decreasing', () => {
    for (let i = 0; i < 9; i++) {
      expect(EMBER_PALETTE[i + 1][0]).toBeGreaterThanOrEqual(EMBER_PALETTE[i][0] - 1e-9);
      expect(sumRgb(EMBER_PALETTE[i + 1])).toBeGreaterThanOrEqual(sumRgb(EMBER_PALETTE[i]) - 1e-9);
    }
  });

  it('T8: warm index 0 is darker than index 9 by sum(RGB)', () => {
    expect(sumRgb(WARM_PALETTE[0])).toBeLessThan(sumRgb(WARM_PALETTE[9]));
  });

  it('T9: ember anchor is redder (lower G) than warm anchor', () => {
    expect(EMBER_PALETTE[6][1]).toBeLessThan(WARM_PALETTE[6][1] - 0.1);
  });

  it('T12: no pure blue/cyan heuristic hits on warm/ember ramps', () => {
    for (const c of WARM_PALETTE) expect(isPureBlueCyan(c)).toBe(false);
    for (const c of EMBER_PALETTE) expect(isPureBlueCyan(c)).toBe(false);
  });

  it('T13: full warm ramp matches design golden', () => {
    expect(WARM_PALETTE.length).toBe(WARM_GOLDEN.length);
    for (let i = 0; i < WARM_GOLDEN.length; i++) {
      expectCloseRgb(WARM_PALETTE[i], WARM_GOLDEN[i], 3);
    }
  });

  it('T14: full ember ramp matches design golden', () => {
    expect(EMBER_PALETTE.length).toBe(EMBER_GOLDEN.length);
    for (let i = 0; i < EMBER_GOLDEN.length; i++) {
      expectCloseRgb(EMBER_PALETTE[i], EMBER_GOLDEN[i], 3);
    }
  });
});

describe('teal unchanged golden (T10–T11)', () => {
  it('T10: full TEAL_PALETTE matches pre-phase golden', () => {
    expect(TEAL_PALETTE.length).toBe(16);
    expect(TEAL_PALETTE.length).toBe(TEAL_GOLDEN.length);
    for (let i = 0; i < TEAL_GOLDEN.length; i++) {
      expectCloseRgb(TEAL_PALETTE[i], TEAL_GOLDEN[i], 5);
    }
  });

  it('T11: full teal token object matches pre-phase golden', () => {
    expect(teal).toEqual({
      bg: '#050a0c',
      surface: '#0a1215',
      border: '#152528',
      muted: '#4a7a80',
      text: '#c0e0e4',
      accent: '#2dd4bf',
      accentDark: '#14b8a6',
      clear: '#03080a',
    });
  });
});

describe('shared warm linear exports', () => {
  it('WARM_ACCENT_RGB is WARM_PALETTE[6] (single source)', () => {
    expect(WARM_ACCENT_RGB).toBe(WARM_PALETTE[6]);
    expectCloseRgb(WARM_ACCENT_RGB, [0.831, 0.486, 0.173], 3);
  });

  it('WARM_TEXT_RGB matches warm.text hex/255 linear-ish', () => {
    expectCloseRgb(WARM_TEXT_RGB, [0.941, 0.863, 0.784], 3);
    // #f0dcc8
    expect(warm.text).toBe('#f0dcc8');
  });

  it('WARM_EXHAUST_RGB is locked off-ramp hot amber', () => {
    expectCloseRgb(WARM_EXHAUST_RGB, [1.0, 0.62, 0.22], 5);
  });
});
