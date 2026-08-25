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
