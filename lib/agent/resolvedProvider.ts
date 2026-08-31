/**
 * Gateway-resolved inference provider slug helpers (plan #906 / source #900).
 *
 * Client-safe — **do not** import `lib/gateway/byokProviders.ts` (credential
 * shapes). Capture + display mapping live here so the DOM host can paint a
 * label without pulling the server-only registry.
 */
import { sanitizeResolvedProvider } from '../sessionCloudCaps';
import type { HarnessBridge } from '../harnessBridge';
import type { SessionSnapshot } from '../sessionStore';

/**
 * Display labels for known Gateway / BYOK slugs. Copied from the server
 * registry ids (not imported). Unknown slugs paint as-is.
 */
const RESOLVED_PROVIDER_LABELS: Record<string, string> = {
  alibaba: 'Alibaba Cloud',
  anthropic: 'Anthropic',
  'arcee-ai': 'Arcee AI',
  azure: 'Azure',
  baseten: 'Baseten',
  bedrock: 'Bedrock',
  bfl: 'Black Forest Labs',
  blackbox: 'Blackbox AI',
  bytedance: 'ByteDance',
  cerebras: 'Cerebras',
  claudeaws: 'Claude Platform on AWS',
  cohere: 'Cohere',
  crusoe: 'Crusoe',
  deepinfra: 'DeepInfra',
  deepseek: 'DeepSeek',
  digitalocean: 'DigitalOcean',
  exa: 'Exa',
  fireworks: 'Fireworks',
  friendli: 'Friendli AI',
  google: 'Google',
  groq: 'Groq',
  inception: 'Inception',
  interfaze: 'Interfaze',
  klingai: 'Kling AI',
  meta: 'Meta',
  minimax: 'MiniMax',
  mistral: 'Mistral',
  moonshotai: 'Moonshot AI',
  morph: 'Morph',
  nebius: 'Nebius',
  novita: 'Novita AI',
  openai: 'OpenAI',
  parallel: 'Parallel AI',
  parasail: 'Parasail',
  perplexity: 'Perplexity',
  poolside: 'Poolside',
  prodia: 'Prodia',
  quiverai: 'QuiverAI',
  recraft: 'Recraft',
  sakana: 'Sakana AI',
  sambanova: 'SambaNova',
  stepfun: 'StepFun',
  streamlake: 'StreamLake',
  togetherai: 'Together AI',
  vertex: 'Google Vertex AI',
  voyage: 'Voyage AI',
  wafer: 'Wafer',
  xai: 'xAI',
  xiaomi: 'Xiaomi',
  zai: 'Z.AI',
};

function firstProviderField(rec: Record<string, unknown>): string | undefined {
  const fromName = sanitizeResolvedProvider(rec.providerName);
  if (fromName) return fromName;
  return sanitizeResolvedProvider(rec.provider);
}

/**
 * Pull a sanitized provider slug out of AI SDK / Gateway `providerMetadata`.
 * Prefers `gateway.providerName` then `gateway.provider`; else the first
 * string `providerName` / `provider` under any top-level key. Miss → undefined.
 */
export function extractResolvedProvider(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
  const rec = meta as Record<string, unknown>;
  const gateway = rec.gateway;
  if (gateway && typeof gateway === 'object' && !Array.isArray(gateway)) {
    const fromGateway = firstProviderField(gateway as Record<string, unknown>);
    if (fromGateway) return fromGateway;
  }
  for (const value of Object.values(rec)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const found = firstProviderField(value as Record<string, unknown>);
    if (found) return found;
  }
  return undefined;
}

/** Map a sanitized slug to a short display label. Unknown slugs pass through. */
export function formatResolvedProviderLabel(slug: string): string {
  const cleaned = sanitizeResolvedProvider(slug) ?? slug.trim().toLowerCase();
  if (!cleaned) return slug;
  return RESOLVED_PROVIDER_LABELS[cleaned] ?? cleaned;
}

/**
 * Host restore / live paint: persist the slug, push the mapped label into Wasm.
 * Empty / poison → hide (`len=0`).
 */
export function applyResolvedProvider(
  snap: SessionSnapshot,
  bridge: HarnessBridge,
): void {
  const slug = sanitizeResolvedProvider(snap.resolvedProvider);
  if (!slug) {
    bridge.setResolvedProvider(null);
    return;
  }
  bridge.setResolvedProvider(formatResolvedProviderLabel(slug));
}
