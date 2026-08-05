import { describe, expect, it } from 'vitest';
import {
  BYOK_PROVIDERS,
  BYOK_PROVIDER_DEFS,
  SUGGESTED_MODELS,
  byokCredentialShape,
  isByokProvider,
  isValidModelId,
  validateCredentials,
  collectRedactableSecrets,
  pickMaskSource,
} from './byokProviders';

describe('byokProviders registry', () => {
  it('includes Gateway catalog providers beyond the original five', () => {
    for (const must of [
      'anthropic',
      'openai',
      'azure',
      'vertex',
      'bedrock',
      'xai',
      'google',
      'groq',
      'mistral',
      'deepseek',
      'moonshotai',
    ] as const) {
      expect(isByokProvider(must)).toBe(true);
    }
    expect(BYOK_PROVIDERS.length).toBe(BYOK_PROVIDER_DEFS.length);
    expect(BYOK_PROVIDERS.length).toBeGreaterThan(20);
  });

  it('isByokProvider rejects unknowns', () => {
    expect(isByokProvider('not-a-provider')).toBe(false);
    expect(isByokProvider('')).toBe(false);
  });

  it('credential shapes: apiKey default; azure/vertex/bedrock special', () => {
    expect(byokCredentialShape('xai')).toBe('apiKey');
    expect(byokCredentialShape('anthropic')).toBe('apiKey');
    expect(byokCredentialShape('google')).toBe('apiKey');
    expect(byokCredentialShape('azure')).toBe('azure');
    expect(byokCredentialShape('vertex')).toBe('vertex');
    expect(byokCredentialShape('bedrock')).toBe('bedrock');
  });

  it('model id regex', () => {
    expect(isValidModelId('anthropic/claude-sonnet-4')).toBe(true);
    expect(isValidModelId('xai/grok-4.1-fast-non-reasoning')).toBe(true);
    expect(isValidModelId('openai/gpt-4.1')).toBe(true);
    expect(isValidModelId('bad')).toBe(false);
    expect(isValidModelId('UPPER/model')).toBe(false);
    expect(isValidModelId('a/b:c+d')).toBe(true);
  });
});

describe('validateCredentials', () => {
  it('apiKey providers (anthropic, openai, xai, google, …)', () => {
    expect(validateCredentials('anthropic', { apiKey: 'sk-ant' })).toEqual({
      ok: true,
      credentials: { apiKey: 'sk-ant' },
    });
    expect(validateCredentials('openai', { apiKey: ' sk ' }).ok).toBe(true);
    expect(validateCredentials('xai', { apiKey: 'xai-key' }).ok).toBe(true);
    expect(validateCredentials('google', { apiKey: 'gkey' }).ok).toBe(true);
    expect(validateCredentials('anthropic', { apiKey: '' }).ok).toBe(false);
    expect(validateCredentials('openai', {}).ok).toBe(false);
  });

  it('azure requires apiKey + resourceName; optional modelMappings', () => {
    expect(
      validateCredentials('azure', {
        apiKey: 'k',
        resourceName: 'res',
        modelMappings: { a: 'b' },
      }).ok,
    ).toBe(true);
    expect(validateCredentials('azure', { apiKey: 'k' }).ok).toBe(false);
    expect(
      validateCredentials('azure', {
        apiKey: 'k',
        resourceName: 'r',
        modelMappings: { a: 1 },
      }).ok,
    ).toBe(false);
  });

  it('vertex requires project/location/googleCredentials', () => {
    const ok = validateCredentials('vertex', {
      project: 'p',
      location: 'us',
      googleCredentials: {
        privateKey: 'pk',
        clientEmail: 'a@b.c',
      },
    });
    expect(ok.ok).toBe(true);
    expect(
      validateCredentials('vertex', {
        project: 'p',
        location: 'us',
        googleCredentials: { privateKey: 'pk' },
      }).ok,
    ).toBe(false);
  });

  it('bedrock requires access keys; optional region', () => {
    expect(
      validateCredentials('bedrock', {
        accessKeyId: 'AKI',
        secretAccessKey: 'sec',
        region: 'us-east-1',
      }).ok,
    ).toBe(true);
    expect(
      validateCredentials('bedrock', { accessKeyId: 'AKI' }).ok,
    ).toBe(false);
  });

  it('rejects unknown provider and non-objects', () => {
    expect(validateCredentials('not-real', { apiKey: 'x' }).ok).toBe(false);
    expect(validateCredentials('anthropic', null).ok).toBe(false);
    expect(validateCredentials('anthropic', 'sk').ok).toBe(false);
  });

  it('allows extra keys', () => {
    const r = validateCredentials('anthropic', { apiKey: 'k', extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.credentials.extra).toBe(1);
  });

  it('redact helpers', () => {
    expect(collectRedactableSecrets({ apiKey: 'secret-key' })).toContain(
      'secret-key',
    );
    expect(pickMaskSource({ apiKey: 'abcdefgh' })).toBe('abcdefgh');
    expect(
      pickMaskSource({
        googleCredentials: { clientEmail: 'a@b.c', privateKey: 'pk' },
      }),
    ).toBe('a@b.c');
  });
});

describe('SUGGESTED_MODELS', () => {
  it('covers every BYOK provider; suggestions valid when present', () => {
    for (const p of BYOK_PROVIDERS) {
      const list = SUGGESTED_MODELS[p];
      expect(Array.isArray(list)).toBe(true);
      for (const mid of list) {
        expect(isValidModelId(mid)).toBe(true);
      }
    }
    // product default model path
    expect(SUGGESTED_MODELS.xai.length).toBeGreaterThan(0);
  });
});
