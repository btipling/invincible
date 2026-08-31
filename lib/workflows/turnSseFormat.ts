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
 * / `provider` become SSE lines. Terminal events stay loop-owned. `tool_result`
 * is written inside the tool-batch step (plan #880), not here. `usage` is
 * **not** live on the durable writer (returns null).
 * Structural `ev` — do not import `agentStream` (deploy-gate).
 */
export function formatLiveModelSse(ev: {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  id?: unknown;
  provider?: unknown;
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
  if (ev.type === 'provider') {
    if (typeof ev.provider !== 'string' || ev.provider.length === 0) return null;
    return formatTurnSse({ type: 'provider', provider: ev.provider });
  }
  return null;
}

/**
 * Live tool-batch `tool_result` line (plan #880). Typed fields for confirmed
 * `change_dir` / `meta_sandbox_switch` so the host can fold cwd/sandbox live.
 */
export function formatLiveToolResultSse(ev: {
  name: string;
  ok: boolean;
  summary: string;
  /** Provider tool-call id — pairs with `tool_start.id` under completion-order writes. */
  id?: string;
  changeDirCwd?: string;
  activeSandboxId?: string;
}): string {
  return formatTurnSse({
    type: 'tool_result',
    name: ev.name,
    ok: ev.ok,
    summary: ev.summary,
    ...(ev.id ? { id: ev.id } : {}),
    ...(ev.changeDirCwd ? { changeDirCwd: ev.changeDirCwd } : {}),
    ...(ev.activeSandboxId ? { activeSandboxId: ev.activeSandboxId } : {}),
  });
}
