/**
 * One-line Workflows step stdout. No secrets, no bodies, no tool args.
 * Visible on Observability → Workflows (not HTTP Runtime Logs).
 */

export function logTurnModel(entry: {
  ok: boolean;
  finishReason?: string;
  toolCallCount?: number;
  textChars?: number;
  reasoningChars?: number;
  completion?: number;
  code?: string;
  /** Sanitized provider slug only — never credentials. */
  provider?: string;
}): void {
  const row: Record<string, unknown> = {
    tag: 'invincible.turn.model',
    ok: entry.ok,
  };
  if (entry.finishReason !== undefined) row.finishReason = entry.finishReason;
  if (entry.toolCallCount !== undefined) row.toolCallCount = entry.toolCallCount;
  if (entry.textChars !== undefined) row.textChars = entry.textChars;
  if (entry.reasoningChars !== undefined) row.reasoningChars = entry.reasoningChars;
  if (entry.completion !== undefined) row.completion = entry.completion;
  if (entry.code !== undefined) row.code = entry.code;
  if (entry.provider !== undefined) row.provider = entry.provider;
  console.log(JSON.stringify(row));
}

export function logTurnPersist(entry: {
  ok: boolean;
  terminal: boolean;
  status?: string;
  turnRunId?: string;
  code?: string;
}): void {
  const row: Record<string, unknown> = {
    tag: 'invincible.turn.persist',
    ok: entry.ok,
    terminal: entry.terminal,
  };
  if (entry.status !== undefined) row.status = entry.status;
  if (entry.turnRunId !== undefined) row.turnRunId = entry.turnRunId;
  if (entry.code !== undefined) row.code = entry.code;
  console.log(JSON.stringify(row));
}

/**
 * Additive loop-level log row (plan #923) — one line per terminal loop result,
 * so an operator can tell a wall-cap from a step-cap (`reason`) and see the
 * bounded elapsed time. No secrets / bodies / tool args. Called from the
 * directive-free `turnLoop` core (plain vitest-safe, no `'use step'` needed —
 * the row is allowlisted in `docs/agent-stream.md`).
 */
export function logTurnLoop(entry: {
  status: string;
  reason?: string;
  elapsedMs?: number;
}): void {
  const row: Record<string, unknown> = {
    tag: 'invincible.turn.loop',
    status: entry.status,
  };
  if (entry.reason !== undefined) row.reason = entry.reason;
  if (entry.elapsedMs !== undefined) row.elapsedMs = entry.elapsedMs;
  console.log(JSON.stringify(row));
}

