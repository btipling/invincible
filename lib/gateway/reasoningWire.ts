/**
 * Gateway `/v4/ai/language-model` `reasoning` enum.
 * Tokens outside this set 400 the turn (global allowlist, not per-model).
 * Catalog / request `max` is rewritten to `xhigh` (the only wire token that
 * means top effort). Other lab tokens are dropped. No other aliases.
 *
 * Hunch (unproven for GLM-5.3): Gateway may translate `xhigh` to Z.AI `max`
 * the way Z.AI 5.2 documents. This rewrite does not depend on that mapping.
 */
import { sanitizeReasoningEffort } from '../sessionCloudCaps';

export const GATEWAY_REASONING_WIRE = [
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type GatewayReasoningWire = (typeof GATEWAY_REASONING_WIRE)[number];

const WIRE = new Set<string>(GATEWAY_REASONING_WIRE);

/** True when `token` is already sanitized and on the language-model wire. */
export function isGatewayReasoningWire(token: string): boolean {
  return WIRE.has(token);
}

/**
 * Adapt a catalog / request token onto the language-model wire.
 * The only lab alias is `max` → `xhigh`. Other unknown tokens are dropped.
 */
export function toGatewayReasoningWire(value: unknown): string | undefined {
  const token = sanitizeReasoningEffort(value);
  if (!token) return undefined;
  const adapted = token === 'max' ? 'xhigh' : token;
  if (!isGatewayReasoningWire(adapted)) return undefined;
  return adapted;
}

/**
 * Keep charset-valid tokens that the language-model API accepts.
 * Rewrites `max` → `xhigh` and dedupes. Drops other lab / junk values.
 */
export function filterGatewayWireEfforts(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const token = toGatewayReasoningWire(v);
    if (!token) continue;
    if (out.includes(token)) continue;
    out.push(token);
  }
  return out;
}
