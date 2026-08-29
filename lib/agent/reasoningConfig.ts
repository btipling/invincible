/**
 * Agent reasoning effort seam (AI SDK `reasoning` option).
 * Server-only — never NEXT_PUBLIC_*.
 */

export type AgentReasoningEffort =
  | 'provider-default'
  | 'none'
  | 'low'
  | 'medium'
  | 'high';

const ALLOWED: ReadonlySet<string> = new Set([
  'provider-default',
  'none',
  'low',
  'medium',
  'high',
]);

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
 * Resolve streamText `reasoning` option for this request.
 * - AGENT_REASONING env wins when valid.
 * - Else if model id looks reasoning-capable → provider-default.
 * - Else omit (undefined) so non-reasoning models stay unchanged.
 */
export function resolveAgentReasoning(
  modelId: string,
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): AgentReasoningEffort | undefined {
  const raw = env.AGENT_REASONING?.trim().toLowerCase();
  if (raw && ALLOWED.has(raw)) {
    return raw as AgentReasoningEffort;
  }
  if (modelIdLooksReasoningCapable(modelId)) {
    return 'provider-default';
  }
  return undefined;
}
