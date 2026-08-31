/**
 * Agent reasoning effort seam (AI SDK `reasoning` option).
 * Server-only — never NEXT_PUBLIC_*.
 *
 * Product default is **`low`** for reasoning-capable models when the joined
 * catalog (Gateway list, models.dev overlay filling holes) has not published
 * an effort list (GLM-5.x today). Never auto-select `max` /
 * `xhigh` / `provider-default`. Env `AGENT_REASONING` remains an ops override.
 */
import { sanitizeReasoningEffort } from '../sessionCloudCaps';

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

  const request = sanitizeReasoningEffort(opts.request);
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
