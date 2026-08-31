/**
 * Agent reasoning effort seam (AI SDK `reasoning` option).
 * Server-only — never NEXT_PUBLIC_*.
 *
 * Product default is **`low`** for reasoning-capable models when the joined
 * catalog (Gateway list, models.dev overlay filling holes) has not published
 * an effort list (GLM-5.x today). Never auto-select `max` /
 * `xhigh` / `provider-default`. Env `AGENT_REASONING` remains an ops override.
 *
 * Gateway language-model `reasoning` is a closed enum that does **not**
 * include `max` (#911). Catalog parse drops it; this resolver coerces a
 * request/stored `max` to `xhigh` (if listed) else `high`.
 */
import {
  isGatewayReasoningWire,
  sanitizeReasoningEffort,
} from '../sessionCloudCaps';

export type AgentReasoningEffort =
  | 'provider-default'
  | 'none'
  | 'low'
  | 'medium'
  | 'high';

const ENV_ALLOWED: ReadonlySet<string> = new Set([
  'provider-default',
  'none',
  'low',
  'medium',
  'high',
]);

const DEFAULT_PREFER = ['low', 'minimal', 'medium', 'none'] as const;
const NEVER_AUTO = new Set(['max', 'xhigh', 'provider-default']);

/** True when model id is marketed as reasoning/thinking (not *non-reasoning*). */
export function modelIdLooksReasoningCapable(modelId: string): boolean {
  const id = (modelId ?? '').toLowerCase();
  if (!id) return false;
  // Prefer explicit non-reasoning tokens before the bare "reasoning" substring.
  if (id.includes('non-reasoning') || id.includes('nonreasoning')) {
    return false;
  }
  if (id.includes('reasoning') || id.includes('thinking')) {
    return true;
  }
  // GLM-5.x always thinks; the id contains neither "reasoning" nor "thinking".
  return /(^|\/)glm-5(\b|[-.])/.test(id);
}

/**
 * Pick a conservative default from a published effort list.
 * Prefer `low` → `minimal` → `medium` → `none` → first remaining that is not
 * `max` / `xhigh` / `provider-default`. Empty or max-only → `undefined` (omit).
 * Never auto-select max.
 */
export function defaultEffortFromOptions(
  values: readonly string[],
): string | undefined {
  for (const p of DEFAULT_PREFER) {
    if (values.includes(p)) return p;
  }
  for (const v of values) {
    if (!NEVER_AUTO.has(v)) return v;
  }
  return undefined;
}

/**
 * Map a sanitized token onto the Gateway language-model wire enum.
 * `max` → `xhigh` if the model lists it, else `high` (skip-catalog body
 * path included — `#911` glm-5.3-flash). Unknown non-wire tokens drop.
 */
export function coerceReasoningForGateway(
  token: string | undefined,
  options?: readonly string[],
): string | undefined {
  if (!token) return undefined;
  if (isGatewayReasoningWire(token)) return token;
  if (token === 'max') {
    const opts = options ?? [];
    if (opts.includes('xhigh')) return 'xhigh';
    if (opts.length === 0 || opts.includes('high')) return 'high';
  }
  return undefined;
}

/**
 * HTTP boundary: skip the joined-catalog GET only when the body token is
 * already on the Gateway wire enum (it wins the resolver verbatim).
 * `max` is **not** on the enum — still fetch so coerce can pick `xhigh`
 * vs `high` (#911 adversarial-review). Omitted request also fetches
 * (catalog default / product `low`).
 */
export function shouldFetchEffortCatalog(
  request: string | undefined,
): boolean {
  const token = sanitizeReasoningEffort(request);
  if (!token) return true;
  return !isGatewayReasoningWire(token);
}

export type ResolveAgentReasoningOpts = {
  /** Sanitized request-body / start-arg token. Invalid values are ignored here. */
  request?: string | undefined;
  env?: Record<string, string | undefined>;
  /** Joined catalog `type: effort` values for this model id (maybe empty). */
  options?: readonly string[] | undefined;
};

/**
 * Resolve streamText `reasoning` option for this request.
 * Precedence: request → env `AGENT_REASONING` → joined-catalog list default →
 * product `low` if the model looks reasoning-capable → omit.
 */
export function resolveAgentReasoning(
  modelId: string,
  opts: ResolveAgentReasoningOpts = {},
): string | undefined {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);

  const request = coerceReasoningForGateway(
    sanitizeReasoningEffort(opts.request),
    opts.options,
  );
  if (request) return request;

  const raw = env.AGENT_REASONING?.trim().toLowerCase();
  if (raw && ENV_ALLOWED.has(raw)) {
    return raw;
  }

  const options = opts.options;
  if (options && options.length > 0) {
    return defaultEffortFromOptions(options);
  }

  if (modelIdLooksReasoningCapable(modelId)) {
    return 'low';
  }
  return undefined;
}
