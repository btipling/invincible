import { encodeSseData, type AgentStreamEvent } from '../agent/agentStream';

/**
 * backend-agents B spike (plan #787): the deterministic AgentStreamEvent wire
 * chunks the turns fixture emits, kept in a pure (non-`workflow`) module so a
 * unit test can assert type parity + SSE wire without loading the Workflow esbuild
 * plugin. The fixture (`turnsFixtureWorkflow.ts`) writes exactly these chunks to
 * `getWritable()`. SSE order + projection mirror `docs/agent-stream.md`:
 * text_delta → reasoning_delta → tool_start/tool_result → usage → done.
 */

/** The spike's deterministic events, in emit order. */
export const TURNS_FIXTURE_EVENTS: AgentStreamEvent[] = [
  { type: 'text_delta', text: 'slice B spike: reconnect primitive' },
  { type: 'reasoning_delta', text: 'reasoning about viewport attach' },
  { type: 'tool_start', name: 'fixture_sleep' },
  {
    type: 'tool_result',
    name: 'fixture_sleep',
    ok: true,
    summary: 'fixture_sleep · ✓ ok · resumed',
  },
  { type: 'usage', usage: { source: 'provider', prompt: 12, completion: 7, total: 19 } },
  { type: 'done', text: 'spike complete' },
];

/** The same events encoded as SSE wire (`data: <json>\n\n`) — what the fixture writes. */
export const TURNS_FIXTURE_SSE: string[] = TURNS_FIXTURE_EVENTS.map(encodeSseData);
