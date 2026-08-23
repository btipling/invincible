/**
 * backend-agents E (#791 / source #768) — REAL turn Workflow orchestrator:
 * port one prompt into a durable Vercel Workflow run (parent #764 slice E).
 *
 * Shape (design decision #1, locked): a `"use workflow"` orchestrator that spins
 * exactly TWO steps —
 *
 *   1. `modelTurnStep` (`"use step"`): re-resolve every seam (BYOK/modelId +
 *      providerOptions, sandbox grants+client, MCP/http/skills/persona via the
 *      DI composition root — a step is a fresh Function so no handle survives the
 *      boundary), hydrate the serializable `RunFileFreshness` ledger, call
 *      `runAgentStream` (which already emits the EXACT `AgentStreamEvent`s the
 *      host consumes), write each event to the run's `getWritable()` as SSE, and
 *      return a serializable step result (freshness projection + a structured
 *      message checkpoint).
 *
 *   2. `workerPersistStep` (`"use step"`): re-resolve the store/Blob seams, then
 *      via `createTurnWorkerPersist` mint+PUT an append-only transcript segment
 *      (LWW envelope `meta` update), overlay the worker-owned envelope meta
 *      (`logicalCwd`/`activeSandboxId`/`usage`/`attachedSkills`/`turnRunId`/
 *      `turnStatus`), and persist the structured message checkpoint as its OWN
 *      Blob object — NEVER in the 1 MiB envelope `meta`.
 *
 * Fail closed at every step: no cached handle (re-resolve per step, parent
 * decision B), no `/api/agent` fallback (the #710 lie is not re-introduced),
 * no server cancel, one run = one prompt (no queue drain — that's G #770).
 *
 * The `"use workflow"` / `"use step"` bodies are thin shells (Workflows runtime
 * and `getWritable()` only exist inside them); the substantive logic lives in
 * the injected seam + the pure helpers below so it is unit-testable under the
 * mocked step runtime (test rows 3/4/5/7) exactly like the B/D fixtures test
 * their data surfaces and the route tests mock `workflow/api`.
 *
 * Never imports Wasm/DOM; server-only. Do NOT write any secret/BYOK/DEK into
 * Workflow state or args — they are resolved inside the steps and stay in the
 * step process / redaction list.
 */

import { getWritable } from 'workflow';
// A Vercel Workflow module must NOT statically import any module whose graph
// reaches Node.js-only code / node-module server deps (postgres, `node:*`,
// bcrypt, the di root → db, sandbox vercelClient → `node:path`, mcp urlPolicy →
// `node:dns`, blobStore → `node:crypto`, tenancy credentials/DEKs/password). The
// Workflows bundler statically traces imports and hard-rejects those
// ("Move this function into a step function") — adversary Major L1+L6. So
// everything that touches that graph is reached ONLY via a dynamic import INSIDE
// a `'use step'` body (a fresh Function/isolate): `runAgentStream` (the model
// step) and the store+Blob seams / `createTurnWorkerPersist` (the persist step,
// via `createProductionTurnStores`). Only pure / SSE-wire / type imports stay
// static here.
import type { RunAgentParams } from './runAgent';
import { encodeSseData, type AgentStreamEvent } from './agentStream';
import {
  createRunFileFreshness,
  hydrateRunFileFreshness,
  serializeRunFileFreshness,
  type FreshnessLedgerProjection,
  type RunFileFreshness,
} from './fileFreshness';
import type { createTurnWorkerPersist, TurnWorkerMetaPatch } from './turnWorkerPersist';
import type { BlobTranscriptStore } from '../sessions/blobStore';
import type { ServerSessionStore, SessionRecordKey } from '../sessions/sessionStore';

/**
 * NEW additive caps (plan #791 caps table — backend-agents E). A single prompt's
 * durable model context = truncated `response.messages` (per #549, a STRUCTURED
 * message checkpoint — never a folded 400/3.5 M `{ prompt }` string). These are
 * the carrying-wire bounds for the checkpoint stored as its OWN Blob object
 * (the 8 MiB object ceiling `HARNESS_SESSION_MAX_BODY_BYTES`), never the 1 MiB
 * whole-envelope-meta budget (`HARNESS_SESSION_MAX_META_BYTES`). Matches the
 * host fold ceiling `maxMessages=400` (`lib/sessionStore.ts` default). No
 * existing cap raised/lowered → no human gate.
 */
export const TURN_MSG_CHECKPOINT_MAX_MESSAGES = 400;
export const TURN_MSG_CHECKPOINT_MAX_BYTES = 1_000_000;

/**
 * One row of the durable message checkpoint. We persist a STRUCTURED copy
 * (role + content), per #549 — never the raw SDK Message (which can embed
 * tools/parts/arbitrary blobs) and never a folded prompt string.
 */
export type TurnMessageCheckpointRow = {
  role: string;
  /** Redacted + flattened string content (single-user assistant/user turns). */
  content: string;
};

/** The durable model context the worker persists as its own Blob object. */
export type TurnMessageCheckpoint = {
  messages: TurnMessageCheckpointRow[];
  /** Set when the checkpoint was truncated to stay under the NEW caps. */
  truncated: boolean;
};

function capPrefix(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Truncate a raw AI-SDK `response.messages`-shaped array into the bounded,
 * structured checkpoint the worker persists. Capped by
 * `TURN_MSG_CHECKPOINT_MAX_MESSAGES` / `_MAX_BYTES` (truncation marker, never a
 * throw). `truncated` is set when the message count or the serialized bytes
 * exceed the caps. Malformed/hostile rows are skipped (fail closed). Pure +
 * unit-tested (plan test row 7: stored as its own Blob object; the envelope
 * `meta` NEVER carries it — that decision lives in `workerPersistStep`).
 */
export function truncateMessageCheckpoint(
  messages: ReadonlyArray<{ role?: unknown; content?: unknown } | null | undefined>,
  caps: { maxMessages?: number; maxBytes?: number } = {},
): TurnMessageCheckpoint {
  const maxMessages = caps.maxMessages ?? TURN_MSG_CHECKPOINT_MAX_MESSAGES;
  const maxBytes = caps.maxBytes ?? TURN_MSG_CHECKPOINT_MAX_BYTES;
  const rows: TurnMessageCheckpointRow[] = [];
  let bytes = 0;
  let truncated = false;
  for (const m of messages ?? []) {
    if (!m || typeof m !== 'object') continue;
    const role =
      typeof m.role === 'string' && m.role ? m.role : '';
    let content =
      typeof m.content === 'string'
        ? m.content
        : m.content && typeof m.content === 'object' && 'text' in m.content
          ? String((m.content as { text?: unknown }).text ?? '')
          : '';
    if (!role) continue;
    content = content.trim().replace(/\s+/g, ' ').slice(0, 8_000); // row-level guard
    if (rows.length >= maxMessages) {
      truncated = true;
      break;
    }
    const rowBytes = role.length + content.length + 6; // keys/overhead estimate
    if (bytes + rowBytes > maxBytes) {
      truncated = true;
      break;
    }
    bytes += rowBytes;
    rows.push({ role, content: capPrefix(content, 8_000) });
  }
  return { messages: rows, truncated };
}

/** JSON-safe start args (these are the ONLY thing `start()` writes — never secrets). */
export type TurnWorkflowArgs = {
  /** Session identity the worker binds Persist writes to. */
  tenantId: string;
  userId: string;
  sessionId: string;
  /** The one prompt for this run (one run = one prompt). */
  prompt: string;
  /** Optional session cwd (workspace-root-relative; default "."). */
  initialCwd?: string;
  /** Optional pre-resolved modelId (BYOK is still re-resolved in the step). */
  modelId?: string;
  /** Serializable freshness ledger carried across step boundaries. */
  serializedFreshness?: FreshnessLedgerProjection;
};

/**
 * Re-resolution seam the model step uses. A step is a fresh Function, so every
 * run resolves every clean handle through its own cascade (parent decision B) —
 * and closes them before the step returns. This is what makes "re-resolve every
 * step, fail closed" testable: tests inject factories and assert call counts
 * (plan test row 3).
 */
export type TurnStepRunSeam = {
  /** Resolve the full `runAgentStream` params by re-deriving BYOK/sandbox/etc. */
  resolveRunParams(
    args: TurnWorkflowArgs,
    freshness: RunFileFreshness,
  ): Promise<{
    params: Omit<RunAgentParams, 'prompt' | 'freshness'>;
    /** Close every transport THIS cascade opened (sandbox/MCP/http runner). */
    close(): Promise<void>;
  }>;
};

export type TurnModelStepResult = {
  serializedFreshness: FreshnessLedgerProjection;
  /** Durable structured message checkpoint (worker persists it as its own Blob). */
  checkpoint: TurnMessageCheckpoint;
};

/** The `runAgentStream` binding the model step calls (injectable for tests). */
export type RunAgentStreamFn = (
  params: RunAgentParams,
  handlers: { onEvent: (event: AgentStreamEvent) => void | Promise<void> },
) => Promise<unknown>;

/**
 * The model step body — factored out of the `"use step"` shell so it is
 * unit-testable (mock seam + mock writable + no real sandbox/MCP/Blob). It:
 *  - hydrates the serializable freshness ledger (or starts empty);
 *  - re-resolves the run params through the seam (a fresh cascade per step);
 *  - runs the agent stream, forwarding every `AgentStreamEvent` to the writable
 *    as encoded SSE (the exact `docs/agent-stream.md` wire contract);
 *  - snapshots the ledger + a structured `response.messages` checkpoint.
 * Fail closed: any resolve/run rejection propagates (the caller maps it to an
 * `error` event + a run end) — never a silent `/api/agent` fallback.
 *
 * `runAgentStreamImpl` is REQUIRED and comes from the `'use step'` shell, which
 * `await import('./runAgent')`s it INSIDE the step's isolated Function. It MUST
 * NOT be defaulted to a module-scope importer of `./runAgent` here: that would
 * leave a module-scope reference to the whole di/db/postgres + blobStore +
 * mcp/urlPolicy graph in the workflow module, which the Vercel workflows
 * bundler's node-module-error plugin traces into the workflow bundle and
 * hard-fails (deploy block, adversary Major #1).
 */
export async function runModelTurnStep(
  seam: TurnStepRunSeam,
  args: TurnWorkflowArgs,
  writable: WritableStream<string>,
  runAgentStreamImpl: RunAgentStreamFn,
): Promise<TurnModelStepResult> {
  const freshness = hydrateOrSeedFreshness(args.serializedFreshness);
  // Re-resolve EVERY transport this step uses (fresh Function — no cached handle).
  const resolved = await seam.resolveRunParams(args, freshness);
  const writer = writable.getWriter();
  const messages: Array<{ role?: unknown; content?: unknown }> = [
    { role: 'user', content: args.prompt },
  ];
  try {
    try {
      await runAgentStreamImpl(
        { ...resolved.params, prompt: args.prompt, freshness },
        {
          onEvent: async (ev: AgentStreamEvent) => {
            if (ev.type === 'error') {
              // Model-stream error → fail closed (the caller maps + re-emits).
              throw new Error(
                `agent stream error${ev.status ? ` (${ev.status})` : ''}: ${ev.error}`,
              );
            }
            await writer.write(encodeSseData(ev));
            // Capture a durable structured checkpoint from the final assistant
            // text in the `done` event (per #549: structured messages, never a
            // folded `{ prompt }` string). Tool rows are already on the stream;
            // we keep the checkpoint to the final assistant text so a later
            // turn (F attach) can resume coherently without a 400/3.5 M reload.
            if (ev.type === 'done' && ev.text && ev.text.trim()) {
              messages.push({ role: 'assistant', content: ev.text });
            }
          },
        },
      );
    } finally {
      await resolved.close();
    }
    // Signal end-of-stream to the SSE consumer (adversary Minor #4 parity with
    // the B fixture's explicit close step). `writer.close()` releases the lock
    // and closes the underlying `getWritable()` — an un-closed writable would
    // keep the `Accept` pipe / GET …/stream waiting until maxDuration.
    await writer.close();
    return {
      serializedFreshness: serializeRunFileFreshness(freshness),
      checkpoint: truncateMessageCheckpoint(messages),
    };
  } catch (err) {
    // Always close the writer (abort — signal a broken stream, never a hang)
    // + transports on a reject too.
    try {
      await writer.abort();
    } catch {
      /* ignore writer abort errors (already closed) */
    }
    try {
      await resolved.close();
    } catch {
      /* ignore transport close errors */
    }
    throw err;
  }
}

/** Hydrate the carried ledger, or start empty (first step of a fresh prompt). */
export function hydrateOrSeedFreshness(
  serialized?: FreshnessLedgerProjection | null,
): RunFileFreshness {
  if (serialized && Array.isArray(serialized.paths)) {
    return hydrateRunFileFreshness(serialized);
  }
  return createRunFileFreshness();
}

/**
 * The worker persist step body — factored out of the `"use step"` shell so it is
 * testable with in-memory stores. Re-resolves the Blob + envelope seams fresh
 * (a step is a new Function), then mints+PUTs an append-only transcript segment
 * (advancing `meta.transcriptPointer` only on a successful PUT, LWW), overlays
 * the worker-owned envelope meta, and persists the structured message checkpoint
 * as its OWN Blob object — NEVER in the 1 MiB envelope `meta` (plan-review
 * Major carrier fix).
 */
export async function runWorkerPersistStep(
  deps: {
    persist: ReturnType<typeof createTurnWorkerPersist>;
    key: SessionRecordKey;
  },
  modelResult: TurnModelStepResult,
  segment: { kind: 'transcript'; updatedAt: number; body: unknown; metaPatch?: TurnWorkerMetaPatch },
): Promise<'persisted'> {
  // 1. Append-only transcript segment + envelope meta (pointer advanced only on
  //    a successful PUT; LWW on `updatedAt`).
  const seg = await deps.persist.persistTranscriptSegment(deps.key, {
    updatedAt: segment.updatedAt,
    segment: segment.body,
    metaPatch: segment.metaPatch,
  });
  if (!seg.ok) {
    throw new Error(`worker transcript persist failed: ${seg.code} ${seg.message}`);
  }
  // 2. Structured message checkpoint as its OWN Blob object (never envelope meta).
  const ckpt = await deps.persist.persistMessageCheckpoint(deps.key, {
    updatedAt: segment.updatedAt,
    checkpoint: modelResult.checkpoint,
  });
  if (!ckpt.ok) {
    throw new Error(`worker message-checkpoint persist failed: ${ckpt.code} ${ckpt.message}`);
  }
  return 'persisted';
}

/**
 * Model step `"use step"` shell. Resolves the production seam FROM INSIDE the
 * step Function (a fresh isolate — no closure/handle survives the step boundary;
 * the B/D fixtures' zero-arg serialization contract, adversary Major L1+L6).
 * Only serializable `TurnWorkflowArgs` cross in; the seam + its transports are
 * created and closed inside this step. The substantive work is delegated to
 * `runModelTurnStep` (the tested body).
 */
async function modelTurnStep(args: TurnWorkflowArgs): Promise<TurnModelStepResult> {
  'use step';

  // CAREFUL (deploy block, adversary Major #1): every Node-only seam must be
  // resolved HERE, lexically INSIDE the `'use step'` body — never as a
  // module-scope import/default in the workflow module, or the workflows
  // bundler traces it into the workflow bundle and hard-fails. `runAgent`'s
  // graph reaches the di root (db/postgres, blobStore `node:crypto`,
  // mcp urlPolicy `node:dns`, bcrypt). It is imported dynamically inside the
  // step's isolated Function and passed to the (module-scope, pure) runner.
  const { createTurnWorkerSeam } = await import('./turnWorkerSeam');
  const { runAgentStream } = await import('./runAgent');
  const seam = createTurnWorkerSeam();
  const writable = getWritable<string>();
  return runModelTurnStep(seam, args, writable, runAgentStream);
}

/**
 * Persist step `"use step"` shell. Resolves the production store/Blob seams FROM
 * INSIDE the step Function (a fresh isolate — no closure/handle crosses the
 * boundary; the B/D zero-arg serialization contract, adversary Major L1+L6).
 * Only serializable args + the serializable step result cross in/out.
 */
async function workerPersistStep(
  args: TurnWorkflowArgs,
  modelResult: TurnModelStepResult,
  segmentBody: unknown,
  updatedAt: number,
  metaPatch: TurnWorkerMetaPatch,
): Promise<'persisted'> {
  'use step';

  // CAREFUL (deploy block, adversary Major #1): all store/Blob resolution MUST
  // live HERE, lexically INSIDE the `'use step'` body. Vercel's
  // node-module-error plugin traces the WHOLE workflow-module graph — any
  // dynamic import inside a module-scope helper (e.g. a top-level
  // `createProductionTurnStores`) is bundled into the workflow bundle and
  // hard-fails on Node-only deps (postgres/`node:crypto`/`node:dns`). So the
  // seam resolves the session + blob stores inline (fresh per step — no cached
  // handle, parent decision B) and creates the persist seam here.
  const { resolveSessionStore, sessionKeyFor, resolveBlobStore } = await import(
    '../tenancy/harnessSessionsRedis'
  );
  const { isEnvelopeStore } = await import('../sessions/sessionStore');
  const storeRes = await resolveSessionStore();
  if (!storeRes.ok) {
    throw new Error(`turn worker session store unavailable: ${storeRes.code}`);
  }
  if (!isEnvelopeStore(storeRes.value)) {
    throw new Error('turn worker session store is not envelope-backed');
  }
  const blobRes = await resolveBlobStore();
  if (!blobRes.ok) {
    throw new Error(`turn worker blob store unavailable: ${blobRes.code}`);
  }
  const { createTurnWorkerPersist } = await import('./turnWorkerPersist');
  const stores = {
    persist: createTurnWorkerPersist({
      blobStore: blobRes.value,
      envelopeStore: storeRes.value,
    }),
    key: sessionKeyFor(args.tenantId, args.userId, args.sessionId),
  };
  return runWorkerPersistStep(
    stores,
    modelResult,
    { kind: 'transcript', updatedAt, body: segmentBody, metaPatch },
  );
}

/**
 * `"use workflow"` orchestrator — one prompt as one durable run; the SINGLE
 * `'use workflow'` the route passes to `start()` (so there is NO nested workflow
 * and NO function/handle in any step argument — adversary Major L1+L6). Thin: it
 * only sequences the two steps (the Workflows runtime re-runs steps on retry; the
 * serializable freshness ledger is threaded through args so a retried step
 * re-hydrates read-before-edit grants). Returns a `{ status: 'completed' }`
 * marker the reconnect proof polls `getRun` for (B pattern). NEVER a server
 * cancel (H), never a `/api/agent` fallback, no queue drain (G).
 */
export async function runTurnWorkflow(
  args: TurnWorkflowArgs,
): Promise<{ status: 'completed' }> {
  'use workflow';

  const modelResult = await modelTurnStep(args);

  // Persist one append-only transcript segment with the worker meta patch +
  // the structured message checkpoint (its own Blob object). The segment body is
  // the JSON-safe run summary (text/events are on the stream; the durable context
  // lives in the checkpoint object). `updatedAt` is monotonic-ish; the store
  // enforces LWW across the host PUT path.
  await workerPersistStep(
    args,
    modelResult,
    {
      kind: 'turn-run',
      sessionId: args.sessionId,
      prompt: args.prompt,
      serializedFreshness: modelResult.serializedFreshness,
    },
    Date.now(),
    {
      logicalCwd: args.initialCwd ? String(args.initialCwd) : undefined,
      activeSandboxId: undefined,
      usage: undefined,
      attachedSkills: undefined,
      turnRunId: args.sessionId, // carrier reserved by slice C; E populates it (adversary #2 reworks this)
      turnStatus: 'running',
    },
  );

  return { status: 'completed' };
}

// Re-export the store/blob + key types the start route needs for the single
// `runTurnWorkflow` orchestrator (type-only — erased, never bundled by the
// workflows node-module-error gate).
export type {
  BlobTranscriptStore,
  ServerSessionStore,
  SessionRecordKey,
};
