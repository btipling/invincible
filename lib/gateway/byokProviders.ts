/**
 * Closed BYOK provider registry.
 * Server-only — never import from client or Wasm.
 * Credential shapes match Vercel AI Gateway request-scoped BYOK.
 *
 * Most catalog providers use { apiKey }. Complex shapes: azure, vertex, bedrock.
 * Extend this list when Vercel adds Gateway provider slugs / shapes.
 * Canonical slugs: https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */

export type ByokCredentialShape = 'apiKey' | 'azure' | 'vertex' | 'bedrock';

/**
 * Gateway BYOK / routing provider slugs (dashboard + request-scoped).
 * Sorted A–Z by slug. Labels match Vercel catalog naming where known.
 */
export const BYOK_PROVIDER_DEFS = [
  { id: 'alibaba', label: 'Alibaba Cloud', shape: 'apiKey' },
  { id: 'anthropic', label: 'Anthropic', shape: 'apiKey' },
  { id: 'arcee-ai', label: 'Arcee AI', shape: 'apiKey' },
  { id: 'azure', label: 'Azure', shape: 'azure' },
  { id: 'baseten', label: 'Baseten', shape: 'apiKey' },
  { id: 'bedrock', label: 'Bedrock', shape: 'bedrock' },
  { id: 'bfl', label: 'Black Forest Labs', shape: 'apiKey' },
  { id: 'blackbox', label: 'Blackbox AI', shape: 'apiKey' },
  { id: 'bytedance', label: 'ByteDance', shape: 'apiKey' },
  { id: 'cerebras', label: 'Cerebras', shape: 'apiKey' },
  { id: 'claudeaws', label: 'Claude Platform on AWS', shape: 'apiKey' },
  { id: 'cohere', label: 'Cohere', shape: 'apiKey' },
  { id: 'crusoe', label: 'Crusoe', shape: 'apiKey' },
  { id: 'deepinfra', label: 'DeepInfra', shape: 'apiKey' },
  { id: 'deepseek', label: 'DeepSeek', shape: 'apiKey' },
  { id: 'digitalocean', label: 'DigitalOcean', shape: 'apiKey' },
  { id: 'exa', label: 'Exa', shape: 'apiKey' },
  { id: 'fireworks', label: 'Fireworks', shape: 'apiKey' },
  { id: 'friendli', label: 'Friendli AI', shape: 'apiKey' },
  { id: 'google', label: 'Google', shape: 'apiKey' },
  { id: 'groq', label: 'Groq', shape: 'apiKey' },
  { id: 'inception', label: 'Inception', shape: 'apiKey' },
  { id: 'interfaze', label: 'Interfaze', shape: 'apiKey' },
  { id: 'klingai', label: 'Kling AI', shape: 'apiKey' },
  { id: 'meta', label: 'Meta', shape: 'apiKey' },
  { id: 'minimax', label: 'MiniMax', shape: 'apiKey' },
  { id: 'mistral', label: 'Mistral', shape: 'apiKey' },
  { id: 'moonshotai', label: 'Moonshot AI', shape: 'apiKey' },
  { id: 'morph', label: 'Morph', shape: 'apiKey' },
  { id: 'nebius', label: 'Nebius', shape: 'apiKey' },
  { id: 'novita', label: 'Novita AI', shape: 'apiKey' },
  { id: 'openai', label: 'OpenAI', shape: 'apiKey' },
  { id: 'parallel', label: 'Parallel AI', shape: 'apiKey' },
  { id: 'parasail', label: 'Parasail', shape: 'apiKey' },
  { id: 'perplexity', label: 'Perplexity', shape: 'apiKey' },
  { id: 'poolside', label: 'Poolside', shape: 'apiKey' },
  { id: 'prodia', label: 'Prodia', shape: 'apiKey' },
  { id: 'quiverai', label: 'QuiverAI', shape: 'apiKey' },
  { id: 'recraft', label: 'Recraft', shape: 'apiKey' },
  { id: 'sakana', label: 'Sakana AI', shape: 'apiKey' },
  { id: 'sambanova', label: 'SambaNova', shape: 'apiKey' },
  { id: 'stepfun', label: 'StepFun', shape: 'apiKey' },
  { id: 'streamlake', label: 'StreamLake', shape: 'apiKey' },
  { id: 'togetherai', label: 'Together AI', shape: 'apiKey' },
  { id: 'vertex', label: 'Google Vertex AI', shape: 'vertex' },
  { id: 'voyage', label: 'Voyage AI', shape: 'apiKey' },
  { id: 'wafer', label: 'Wafer', shape: 'apiKey' },
  { id: 'xai', label: 'xAI', shape: 'apiKey' },
  { id: 'xiaomi', label: 'Xiaomi', shape: 'apiKey' },
  { id: 'zai', label: 'Z.AI', shape: 'apiKey' },
] as const satisfies readonly {
  id: string;
  label: string;
  shape: ByokCredentialShape;
}[];

export const BYOK_PROVIDERS = BYOK_PROVIDER_DEFS.map((d) => d.id);

export type ByokProvider = (typeof BYOK_PROVIDER_DEFS)[number]['id'];

const PROVIDER_SET = new Set<string>(BYOK_PROVIDERS);

export function isByokProvider(value: unknown): value is ByokProvider {
  return typeof value === 'string' && PROVIDER_SET.has(value);
}

export function byokCredentialShape(provider: ByokProvider): ByokCredentialShape {
  const def = BYOK_PROVIDER_DEFS.find((d) => d.id === provider);
  return def?.shape ?? 'apiKey';
}

export function byokProviderLabel(provider: ByokProvider): string {
  return BYOK_PROVIDER_DEFS.find((d) => d.id === provider)?.label ?? provider;
}

/** Gateway model id: provider/model */
export const MODEL_ID_RE = /^[a-z0-9._-]+\/[a-zA-Z0-9._:+-]+$/;

export function isValidModelId(modelId: string): boolean {
  return MODEL_ID_RE.test(modelId);
}

/**
 * Gateway model ids are `provider/model`. Bare names (from xAI console etc.)
 * are prefixed with the secret's provider when no `/` is present.
 */
export function normalizeModelId(raw: string, provider?: string): string {
  const mid = raw.trim();
  if (!mid) return mid;
  if (mid.includes('/')) return mid;
  const p = provider?.trim();
  if (p && isByokProvider(p)) {
    return `${p}/${mid}`;
  }
  return mid;
}

export function normalizeModelIds(
  rawIds: readonly string[],
  provider?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    const mid = normalizeModelId(raw, provider);
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    out.push(mid);
  }
  return out;
}

/** Suggested model-id prefix for each provider (before `/`). */
export const PROVIDER_MODEL_PREFIX: Record<ByokProvider, string> =
  Object.fromEntries(BYOK_PROVIDERS.map((id) => [id, id])) as Record<
    ByokProvider,
    string
  >;

/**
 * Curated gateway model ids for admin UI chips (freeform still allowed via MODEL_ID_RE).
 * Empty = freeform only (routing/host providers with no chat models yet).
 */
export const SUGGESTED_MODELS: Record<ByokProvider, readonly string[]> = {
  alibaba: ['alibaba/qwen-3-14b', 'alibaba/qwen-3-235b'],
  anthropic: [
    'anthropic/claude-sonnet-4',
    'anthropic/claude-opus-4',
    'anthropic/claude-3-5-haiku-latest',
  ],
  'arcee-ai': ['arcee-ai/trinity-mini', 'arcee-ai/trinity-large-thinking'],
  azure: ['azure/gpt-4o', 'azure/gpt-4o-mini'],
  baseten: [],
  bedrock: [
    'bedrock/anthropic.claude-sonnet-4',
    'bedrock/amazon.nova-pro-v1:0',
  ],
  bfl: ['bfl/flux-2-flex'],
  blackbox: [],
  bytedance: ['bytedance/seed-1.6', 'bytedance/seed-1.8'],
  cerebras: [],
  claudeaws: [],
  cohere: ['cohere/command-a'],
  crusoe: [],
  deepinfra: [],
  deepseek: ['deepseek/deepseek-v3', 'deepseek/deepseek-r1'],
  digitalocean: [],
  exa: [],
  fireworks: [],
  friendli: [],
  google: ['google/gemini-2.5-flash', 'google/gemini-2.5-pro'],
  groq: [],
  inception: ['inception/mercury-2'],
  interfaze: ['interfaze/interfaze-beta'],
  klingai: [],
  meta: ['meta/llama-3.1-70b', 'meta/llama-3.1-8b'],
  minimax: ['minimax/minimax-m2'],
  mistral: ['mistral/codestral', 'mistral/mistral-large-latest'],
  moonshotai: ['moonshotai/kimi-k2', 'moonshotai/kimi-k2-thinking'],
  morph: ['morph/morph-v3-fast'],
  nebius: [],
  novita: [],
  openai: ['openai/gpt-4.1', 'openai/gpt-4.1-mini', 'openai/o3-mini'],
  parallel: [],
  parasail: [],
  perplexity: ['perplexity/sonar-pro'],
  poolside: ['poolside/laguna-s-2.1'],
  prodia: [],
  quiverai: ['quiverai/arrow-1.1'],
  recraft: ['recraft/recraft-v3'],
  sakana: ['sakana/fugu-ultra'],
  sambanova: [],
  stepfun: ['stepfun/step-3.5-flash'],
  streamlake: [],
  togetherai: [],
  vertex: ['vertex/gemini-2.0-flash', 'vertex/gemini-2.5-pro'],
  voyage: [],
  wafer: [],
  xai: [
    'xai/grok-4.5',
    'xai/grok-build-0.1',
    'xai/grok-4.3',
    'xai/grok-4.1-fast-non-reasoning',
    'xai/grok-4.1-fast-reasoning',
  ],
  xiaomi: ['xiaomi/mimo-v2.5'],
  zai: ['zai/glm-4.5', 'zai/glm-4.5-air'],
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
  const shape = byokCredentialShape(provider);

  switch (shape) {
    case 'apiKey': {
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
        !isStringRecord(obj.modelMappings) &&
        !Array.isArray(obj.modelMappings)
      ) {
        return {
          ok: false,
          error: 'modelMappings must be string→string or array',
        };
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
