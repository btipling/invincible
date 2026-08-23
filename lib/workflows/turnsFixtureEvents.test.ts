import { describe, expect, it } from 'vitest';
import {
  type AgentStreamEvent,
  AGENT_STREAM_CONTENT_TYPE,
} from '../agent/agentStream';
import { TURNS_FIXTURE_EVENTS, TURNS_FIXTURE_SSE } from './turnsFixtureEvents';

/**
 * backend-agents B spike (plan #787) test row 5 — the fixture emits ONLY the
 * current `AgentStreamEvent` types and the SSE wire carries them verbatim
 * (parity with docs/agent-stream.md). This runs without loading the Workflow
 * esbuild plugin: the events are defined in the pure `turnsFixtureEvents` module
 * exactly as the fixture writes them (`TURNS_FIXTURE_SSE`), so a mismatch here
 * means the probe would stream non-contract bytes to the host.
 *
 * Forward compatibility: any unknown `type` added here is flagged — real hosts
 * IGNORE unknown event types, but the spike must only emit the CURRENT ones.
 */

const KNOWN_TYPES: AgentStreamEvent['type'][] = [
  'tool_start',
  'tool_result',
  'reasoning_delta',
  'text_delta',
  'done',
  'usage',
  'error',
];

describe('turns fixture event parity (plan #787 row 5)', () => {
  it('emits the current AgentStreamEvent types in docs/agent-stream order', () => {
    const types = TURNS_FIXTURE_EVENTS.map((e) => e.type);
    // text_delta → reasoning_delta → tool_start/tool_result → usage → done
    expect(types.slice(0, 2)).toEqual(['text_delta', 'reasoning_delta']);
    expect(types[2]).toBe('tool_start');
    expect(types[3]).toBe('tool_result');
    expect(types.slice(4)).toEqual(['usage', 'done']);
  });

  it('never emits an unknown/forward-compat type', () => {
    for (const e of TURNS_FIXTURE_EVENTS) {
      expect(KNOWN_TYPES).toContain(e.type);
    }
  });

  it('SSE wire chunks carry each event via encodeSseData (data: <json>\\n\\n)', () => {
    expect(TURNS_FIXTURE_SSE.length).toBe(TURNS_FIXTURE_EVENTS.length);
    for (let i = 0; i < TURNS_FIXTURE_EVENTS.length; i++) {
      const event = TURNS_FIXTURE_EVENTS[i];
      const chunk = TURNS_FIXTURE_SSE[i];
      expect(chunk).toBe(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  it('SSE order is stable (resume / reconnect test depends on index alignment)', () => {
    // startIndex indexes into the WIRE chunks (0-based chunk list). The reconnect
    // test resumes from chunk 0 (full) and a mid index (tail) — this locks the
    // chunk positions so the GET resume assertions stay meaningful.
    expect(TURNS_FIXTURE_SSE[0]).toContain('"type":"text_delta"');
    expect(TURNS_FIXTURE_SSE[3]).toContain('"type":"tool_result"');
    expect(TURNS_FIXTURE_SSE[4]).toContain('"type":"usage"');
    expect(TURNS_FIXTURE_SSE[5]).toContain('"type":"done"');
  });

  it('documents the shared stream Content-Type for a piped readable', () => {
    expect(AGENT_STREAM_CONTENT_TYPE).toBe('text/event-stream; charset=utf-8');
  });
});
