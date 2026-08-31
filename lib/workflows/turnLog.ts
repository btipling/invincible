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
