import { describe, expect, it } from 'vitest';
import {
  BYOK_PROVIDERS,
  isByokProvider,
  isValidModelId,
  validateCredentials,
  collectRedactableSecrets,
  pickMaskSource,
} from './byokProviders';

describe('byokProviders registry', () => {
  it('locks closed provider list', () => {
    expect([...BYOK_PROVIDERS]).toEqual([
      'anthropic',
      'openai',
      'azure',
      'vertex',
      'bedrock',
    ]);
  });

  it('isByokProvider', () => {
    expect(isByokProvider('anthropic')).toBe(true);
    expect(isByokProvider('xai')).toBe(false);
  });

  it('model id regex', () => {
    expect(isValidModelId('anthropic/claude-sonnet-4')).toBe(true);
    expect(isValidModelId('openai/gpt-4.1')).toBe(true);
    expect(isValidModelId('bad')).toBe(false);
    expect(isValidModelId('UPPER/model')).toBe(false);
    expect(isValidModelId('a/b:c+d')).toBe(true);
  });
});

describe('validateCredentials', () => {
  it('anthropic / openai accept apiKey', () => {
    expect(validateCredentials('anthropic', { apiKey: 'sk-ant' })).toEqual({
      ok: true,
      credentials: { apiKey: 'sk-ant' },
    });
    expect(validateCredentials('openai', { apiKey: ' sk ' }).ok).toBe(true);
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
    expect(validateCredentials('xai', { apiKey: 'x' }).ok).toBe(false);
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
