import { describe, expect, it } from 'vitest';
import {
  AUTH_REQUIRED_ERROR,
  INFERENCE_FORBIDDEN_ERROR,
  INFERENCE_MODEL_REQUIRED_ERROR,
  INFERENCE_UNAVAILABLE_ERROR,
  SANDBOX_FORBIDDEN_ERROR,
  SANDBOX_SELECTION_REQUIRED_ERROR,
} from './errors';

describe('tenancy error constants', () => {
  it('locks parent AUTH_REQUIRED_ERROR string', () => {
    expect(AUTH_REQUIRED_ERROR).toBe('Authentication required.');
  });

  it('locks parent SANDBOX_FORBIDDEN_ERROR string', () => {
    expect(SANDBOX_FORBIDDEN_ERROR).toBe('Sandbox access denied.');
  });

  it('locks SANDBOX_SELECTION_REQUIRED_ERROR string', () => {
    expect(SANDBOX_SELECTION_REQUIRED_ERROR).toMatch(/Settings → Sandbox/);
  });

  it('locks BYOK inference error strings (#103)', () => {
    expect(INFERENCE_FORBIDDEN_ERROR).toBe('Inference access denied.');
    expect(INFERENCE_MODEL_REQUIRED_ERROR).toBe('A valid model is required.');
    expect(INFERENCE_UNAVAILABLE_ERROR).toBe(
      'Inference temporarily unavailable.',
    );
  });
});
