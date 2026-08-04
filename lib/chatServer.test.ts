import { describe, expect, it } from 'vitest';
import {
  gatewayConfigured,
  mapByokResolveFailure,
  mapInferenceError,
  missingGatewayKeyError,
  parseChatBody,
} from './chatServer';
import { resolveModelId, DEFAULT_MODEL } from './model';
import {
  INFERENCE_FORBIDDEN_ERROR,
  INFERENCE_MODEL_REQUIRED_ERROR,
  INFERENCE_UNAVAILABLE_ERROR,
} from './tenancy/errors';

describe('parseChatBody', () => {
  it('accepts valid prompt', () => {
    expect(parseChatBody({ prompt: '  hello  ' })).toEqual({
      ok: true,
      prompt: 'hello',
    });
  });

  it('accepts optional valid modelId', () => {
    expect(
      parseChatBody({ prompt: 'hi', modelId: 'anthropic/claude-sonnet-4' }),
    ).toEqual({
      ok: true,
      prompt: 'hi',
      modelId: 'anthropic/claude-sonnet-4',
    });
  });

  it('rejects invalid modelId format', () => {
    const r = parseChatBody({ prompt: 'hi', modelId: 'not-a-model' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toBe(INFERENCE_MODEL_REQUIRED_ERROR);
    }
  });

  it('rejects non-string modelId', () => {
    const r = parseChatBody({ prompt: 'hi', modelId: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('rejects missing body', () => {
    const r = parseChatBody(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it('rejects non-string prompt', () => {
    const r = parseChatBody({ prompt: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/string/i);
  });

  it('rejects empty prompt', () => {
    const r = parseChatBody({ prompt: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/enter a prompt/i);
  });
});

describe('mapByokResolveFailure', () => {
  it('maps reasons to stable errors', () => {
    expect(mapByokResolveFailure('forbidden')).toEqual({
      status: 403,
      error: INFERENCE_FORBIDDEN_ERROR,
    });
    expect(mapByokResolveFailure('model_invalid')).toEqual({
      status: 400,
      error: INFERENCE_MODEL_REQUIRED_ERROR,
    });
    expect(mapByokResolveFailure('unavailable')).toEqual({
      status: 503,
      error: INFERENCE_UNAVAILABLE_ERROR,
    });
  });
});

describe('gatewayConfigured', () => {
  it('false when missing', () => {
    expect(gatewayConfigured({})).toBe(false);
    expect(gatewayConfigured({ AI_GATEWAY_API_KEY: '  ' })).toBe(false);
  });
  it('true when set', () => {
    expect(gatewayConfigured({ AI_GATEWAY_API_KEY: 'sk-test' })).toBe(true);
  });
});

describe('missingGatewayKeyError', () => {
  it('mentions env var', () => {
    expect(missingGatewayKeyError().error).toMatch(/AI_GATEWAY_API_KEY/);
  });
});

describe('mapInferenceError', () => {
  it('maps unauthorized', () => {
    expect(mapInferenceError(new Error('Unauthorized: bad api key')).status).toBe(401);
  });
  it('maps rate limit', () => {
    expect(mapInferenceError(new Error('429 rate limit')).status).toBe(429);
  });
  it('defaults to 502', () => {
    expect(mapInferenceError(new Error('upstream boom')).status).toBe(502);
  });
});

describe('resolveModelId', () => {
  it('defaults', () => {
    expect(resolveModelId({})).toBe(DEFAULT_MODEL);
  });
  it('uses DEFAULT_MODEL env', () => {
    expect(resolveModelId({ DEFAULT_MODEL: 'xai/grok-4.1-fast-reasoning' })).toBe(
      'xai/grok-4.1-fast-reasoning',
    );
  });
});
