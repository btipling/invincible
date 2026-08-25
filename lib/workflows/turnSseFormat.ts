/**
 * Directive-free SSE framing for durable-turn events (plan #842).
 *
 * Lives outside `'use workflow'` / `'use step'` so unit tests do not need the
 * Workflows VM, and so the `turnWorkflow` static graph never imports
 * `agentStream.ts` (B11 deploy-gate).
 */

/** One SSE `data:` block. `event` is JSON-serializable (`AgentStreamEvent` shape). */
export function formatTurnSse(event: object): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Live model-step filter: only `reasoning_delta` / `text_delta` / `tool_start`
 * become SSE lines. Terminal + tool-result events stay loop-owned.
 * Structural `ev` — do not import `agentStream` (deploy-gate).
 */
export function formatLiveModelSse(ev: {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  id?: unknown;
  [key: string]: unknown;
}): string | null {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null;
  if (ev.type === 'reasoning_delta' || ev.type === 'text_delta') {
    if (typeof ev.text !== 'string' || ev.text.length === 0) return null;
    return formatTurnSse({ type: ev.type, text: ev.text });
  }
  if (ev.type === 'tool_start') {
    if (typeof ev.name !== 'string') return null;
    return formatTurnSse({
      type: 'tool_start',
      name: ev.name,
      ...(typeof ev.id === 'string' && ev.id.length > 0 ? { id: ev.id } : {}),
    });
  }
  return null;
}
