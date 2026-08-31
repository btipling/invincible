/**
 * Gateway `/v4/ai/language-model` `reasoning` enum.
 * Tokens outside this set 400 the turn (global allowlist, not per-model).
 * `max` is a models.dev / lab token — drop it; never alias to `xhigh`.
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
 * Keep charset-valid tokens that the language-model API accepts.
 * Drops `max` and any other lab / catalog-only value. Does not alias.
 */
export function filterGatewayWireEfforts(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const token = sanitizeReasoningEffort(v);
    if (!token) continue;
    if (!isGatewayReasoningWire(token)) continue;
    if (out.includes(token)) continue;
    out.push(token);
  }
  return out;
}
