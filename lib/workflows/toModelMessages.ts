/**
 * backend-agents C14b (#835) — `toModelMessages`: pure converter from
 * orchestrator-local turn-loop messages to AI SDK 7 `ModelMessage[]`.
 *
 * The loop core (`turnLoop.ts`) keeps an orchestrator-local transcript in a
 * compact delta-carrying shape:
 *   { role: 'user', content }                         → UserModelMessage
 *   { role: 'assistant', delta: { text, toolCalls } }  → AssistantModelMessage
 *   { role: 'tool', toolName, toolCallId, result }     → ToolModelMessage
 *   { role: 'tool', toolName, toolCallId, ok:false, error } → ToolModelMessage
 *   { role: 'error', content }                         → UserModelMessage (`Error: …`)
 *   { role: 'persist', ... }                           → SKIP
 *
 * The AI SDK `streamText({ messages })` requires `ModelMessage[]` where:
 *   - User:   { role: 'user',      content: string }
 *   - Assistant: { role: 'assistant', content: Array<TextPart | ToolCallPart> }
 *   - Tool:   { role: 'tool',      content: Array<ToolResultPart> }
 *
 * `ToolCallPart` = { type: 'tool-call',  toolCallId, toolName, input }
 * `ToolResultPart` = { type: 'tool-result', toolCallId, toolName, output: { type:'text', value } }
 *
 * **Fail-closed on missing `toolCallId`:** a tool-call without a `toolCallId`
 * is skipped (the assistant part omits it), and a tool result without a
 * `toolCallId` is also skipped — we never invent ids that cannot be paired.
 *
 * **Deliberately pure:** no I/O, no DB, no MCP, no blob, no crypto/dns. This
 * module is ONLY imported from `modelGenerateStep.ts` (a `'use step'` leaf) so
 * it does NOT pollute the `turnWorkflow` entry's B11 static closure.
 */

import type {
  AssistantModelMessage,
  ModelMessage,
  TextPart,
  ToolCallPart,
  ToolModelMessage,
  ToolResultPart,
  UserModelMessage,
} from 'ai';

/** Orchestrator-local messages as stored by `runTurnLoop`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OrchestratorMessages = ReadonlyArray<any>;

/**
 * Convert orchestrator-local turn-loop messages to AI SDK 7 `ModelMessage[]`
 * suitable for `streamText({ messages })`.
 *
 * Persist rows (`role: 'persist'`) are skipped. Missing `toolCallId` on a
 * tool-call or tool-result causes that part/pair to be omitted (fail-closed —
 * never invent an id that cannot pair).
 */
export function toModelMessages(
  messages: OrchestratorMessages,
): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;

    const role = (m as { role?: unknown }).role;
    if (typeof role !== 'string') continue;

    if (role === 'user') {
      const userMsg: UserModelMessage = {
        role: 'user',
        content: String((m as { content?: unknown }).content ?? ''),
      };
      out.push(userMsg);
    } else if (role === 'error') {
      // Cap wrap-up: the model must see the harness error. Mapped as user —
      // wrap-up streamText uses STEP_BUDGET_WRAPUP_SYSTEM, not DEFAULT_AGENT_SYSTEM.
      const raw = String((m as { content?: unknown }).content ?? '').trim();
      if (raw) {
        const content = raw.startsWith('Error:') ? raw : `Error: ${raw}`;
        const errMsg: UserModelMessage = { role: 'user', content };
        out.push(errMsg);
      }
    } else if (role === 'assistant') {
      const delta = (m as { delta?: unknown }).delta as
        | { text?: unknown; toolCalls?: TurnToolCallDelta[] }
        | undefined;
      const parts: Array<TextPart | ToolCallPart> = [];
      if (delta?.text && typeof delta.text === 'string') {
        parts.push({ type: 'text', text: delta.text } satisfies TextPart);
      }
      if (delta?.toolCalls) {
        for (const tc of delta.toolCalls) {
          if (tc.toolCallId) {
            parts.push({
              type: 'tool-call',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.args ?? {},
            } satisfies ToolCallPart);
          }
          // Missing toolCallId: skip (fail-closed — never invent an id).
        }
      }
      const asstMsg: AssistantModelMessage = {
        role: 'assistant',
        content: parts,
      };
      out.push(asstMsg);
    } else if (role === 'tool') {
      const toolCallId = (m as { toolCallId?: unknown }).toolCallId;
      const toolName = (m as { toolName?: unknown }).toolName;
      const ok = (m as { ok?: unknown }).ok;
      const error = (m as { error?: unknown }).error;
      const result = (m as { result?: unknown }).result;
      const outputValue =
        ok === false
          ? String(error ?? 'tool error')
          : String(result ?? '');
      // Need toolCallId to link with the assistant's tool-call part.
      // Missing toolCallId → skip (fail-closed).
      if (typeof toolCallId === 'string' && toolCallId.length > 0) {
        const toolPart: ToolResultPart = {
          type: 'tool-result',
          toolCallId,
          toolName: typeof toolName === 'string' ? toolName : 'tool',
          output: { type: 'text', value: outputValue },
        };
        const toolMsg: ToolModelMessage = {
          role: 'tool',
          content: [toolPart],
        };
        out.push(toolMsg);
      }
      // Missing toolCallId: skip — no pairing possible.
    }
    // role === 'persist' → skip
  }

  return out;
}

/** Normalized from `turnLoop`'s `TurnToolCallDelta`. */
interface TurnToolCallDelta {
  toolName: string;
  toolCallId?: string;
  args?: unknown;
}
