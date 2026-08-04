/**
 * Closed BYOK provider registry (parent #102 / phase #103).
 * Server-only — never import from client or Wasm.
 * Credential shapes match Vercel AI Gateway request-scoped BYOK.
 */

export const BYOK_PROVIDERS = [
  'anthropic',
  'openai',
  'azure',
  'vertex',
  'bedrock',
] as const;

export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

/** Gateway model id: provider/model */
export const MODEL_ID_RE = /^[a-z0-9._-]+\/[a-zA-Z0-9._:+-]+$/;

export function isByokProvider(value: unknown): value is ByokProvider {
  return (
    typeof value === 'string' &&
    (BYOK_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isValidModelId(modelId: string): boolean {
  return MODEL_ID_RE.test(modelId);
}

/** Suggested model-id prefix for each provider (before `/`). */
export const PROVIDER_MODEL_PREFIX: Record<ByokProvider, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  azure: 'azure',
  vertex: 'vertex',
  bedrock: 'bedrock',
};

/** Curated gateway model ids for admin UI chips (freeform still allowed via MODEL_ID_RE). */
export const SUGGESTED_MODELS: Record<ByokProvider, readonly string[]> = {
  anthropic: [
    'anthropic/claude-sonnet-4',
    'anthropic/claude-opus-4',
    'anthropic/claude-3-5-haiku-latest',
  ],
  openai: ['openai/gpt-4.1', 'openai/gpt-4.1-mini', 'openai/o3-mini'],
  azure: ['azure/gpt-4o', 'azure/gpt-4o-mini'],
  vertex: ['vertex/gemini-2.0-flash', 'vertex/gemini-2.5-pro'],
  bedrock: ['bedrock/anthropic.claude-sonnet-4', 'bedrock/amazon.nova-pro-v1:0'],
};

/**
 * AI Gateway `providerOptions.gateway.byok` object key — same as registry id.
 */
export function byokGatewayKey(provider: ByokProvider): string {
  return provider;
}

export type ValidateCredentialsResult =
  | { ok: true; credentials: Record<string, unknown> }
  | { ok: false; error: string };

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

/**
 * Validate and normalize credential object for a BYOK provider.
 * Allows extra keys (forward-compat); requires documented fields.
 */
export function validateCredentials(
  provider: string,
  raw: unknown,
): ValidateCredentialsResult {
  if (!isByokProvider(provider)) {
    return { ok: false, error: 'unknown provider' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'credentials must be an object' };
  }
  const obj = raw as Record<string, unknown>;

  switch (provider) {
    case 'anthropic':
    case 'openai': {
      if (!nonEmptyString(obj.apiKey)) {
        return { ok: false, error: 'apiKey is required' };
      }
      return { ok: true, credentials: { ...obj, apiKey: obj.apiKey.trim() } };
    }
    case 'azure': {
      if (!nonEmptyString(obj.apiKey)) {
        return { ok: false, error: 'apiKey is required' };
      }
      if (!nonEmptyString(obj.resourceName)) {
        return { ok: false, error: 'resourceName is required' };
      }
      if (
        obj.modelMappings !== undefined &&
        !isStringRecord(obj.modelMappings)
      ) {
        return { ok: false, error: 'modelMappings must be string→string' };
      }
      return {
        ok: true,
        credentials: {
          ...obj,
          apiKey: obj.apiKey.trim(),
          resourceName: obj.resourceName.trim(),
        },
      };
    }
    case 'vertex': {
      if (!nonEmptyString(obj.project)) {
        return { ok: false, error: 'project is required' };
      }
      if (!nonEmptyString(obj.location)) {
        return { ok: false, error: 'location is required' };
      }
      const gc = obj.googleCredentials;
      if (!gc || typeof gc !== 'object' || Array.isArray(gc)) {
        return { ok: false, error: 'googleCredentials is required' };
      }
      const g = gc as Record<string, unknown>;
      if (!nonEmptyString(g.privateKey)) {
        return { ok: false, error: 'googleCredentials.privateKey is required' };
      }
      if (!nonEmptyString(g.clientEmail)) {
        return { ok: false, error: 'googleCredentials.clientEmail is required' };
      }
      return {
        ok: true,
        credentials: {
          ...obj,
          project: obj.project.trim(),
          location: obj.location.trim(),
          googleCredentials: {
            ...g,
            privateKey: g.privateKey.trim(),
            clientEmail: g.clientEmail.trim(),
          },
        },
      };
    }
    case 'bedrock': {
      if (!nonEmptyString(obj.accessKeyId)) {
        return { ok: false, error: 'accessKeyId is required' };
      }
      if (!nonEmptyString(obj.secretAccessKey)) {
        return { ok: false, error: 'secretAccessKey is required' };
      }
      if (obj.region !== undefined && typeof obj.region !== 'string') {
        return { ok: false, error: 'region must be a string' };
      }
      return {
        ok: true,
        credentials: {
          ...obj,
          accessKeyId: obj.accessKeyId.trim(),
          secretAccessKey: obj.secretAccessKey.trim(),
        },
      };
    }
    default:
      return { ok: false, error: 'unknown provider' };
  }
}

/** Extract secret string values for redaction lists (never log these). */
export function collectRedactableSecrets(
  credentials: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0) out.push(v);
  };
  push(credentials.apiKey);
  push(credentials.accessKeyId);
  push(credentials.secretAccessKey);
  const gc = credentials.googleCredentials;
  if (gc && typeof gc === 'object' && !Array.isArray(gc)) {
    const g = gc as Record<string, unknown>;
    push(g.privateKey);
    push(g.clientEmail);
  }
  return out;
}

/** Choose which field to mask for admin list display. */
export function pickMaskSource(credentials: Record<string, unknown>): string {
  if (typeof credentials.apiKey === 'string') return credentials.apiKey;
  if (typeof credentials.accessKeyId === 'string') return credentials.accessKeyId;
  const gc = credentials.googleCredentials;
  if (gc && typeof gc === 'object' && !Array.isArray(gc)) {
    const email = (gc as Record<string, unknown>).clientEmail;
    if (typeof email === 'string') return email;
  }
  return '';
}
