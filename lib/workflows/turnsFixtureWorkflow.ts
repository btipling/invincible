import { getWritable } from 'workflow';
import { TURNS_FIXTURE_SSE } from './turnsFixtureEvents';

/**
 * backend-agents B spike fixture (plan #787): a throwaway Workflow that proves
 * "turn owner is a Workflow run, not a tab fetch" WITHOUT cutting `/api/agent`
 * over. A fixture (not `runAgent`) streams the CURRENT `AgentStreamEvent` types
 * to `getWritable()`, in the exact order/projection the host already consumes
 * (`docs/agent-stream.md`), then closes the writable.
 *
 * This is a sibling of slice-D `fixtureWorkflow.ts` (`lib/workflows/`). Pure
 * server-side ("use workflow"/"use step") — never imported by Wasm/DOM. The
 * stream data is written by STEPS (never in workflow context — determinism rule
 * in the vendored SDK, streaming.mdx), each writer acquiring the lock and
 * releasing it in a `finally` (an un-released lock keeps the step's request
 * alive — SDK best practice). Real `runAgent`, tools, sandbox, skills, MCP,
 * BYOK inside a workflow is slice E (#768).
 */

/** Emit every fixture event to the run's writable, releasing the lock on exit. */
async function writeFixtureEvents(): Promise<void> {
  'use step';

  const writable = getWritable<string>();
  const writer = writable.getWriter();
  try {
    for (const chunk of TURNS_FIXTURE_SSE) {
      await writer.write(chunk);
    }
  } finally {
    writer.releaseLock();
  }
}

/** Close the writable explicitly — signals completion to consumers early. */
async function closeFixtureStream(): Promise<void> {
  'use step';

  await getWritable<string>().close();
}

/**
 * Orchestrator: delegate the stream writes to steps, then close. The run
 * returns a trivial `completed` marker (the reconnect proof polls `getRun`
 * until this, proving client abort ≠ cancel — the #710 core).
 */
export async function turnsFixtureWorkflow(): Promise<{ status: 'completed' }> {
  'use workflow';

  await writeFixtureEvents();
  await closeFixtureStream();

  return { status: 'completed' };
}
