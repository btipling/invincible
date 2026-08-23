/**
 * Host **detach** seam (plan #789, source #766 — backend-agents slice C).
 *
 * Stop treating the tab as the turn lifetime. Closing a viewport (unmount,
 * session switch, New/Clear, logout) is a *viewport* event, NOT "the turn is
 * over" — the durable turn is owned server-side and survives the tab. Only a
 * user Stop/Esc cancels (`takePendingCancel`; slice H wires that to a server
 * Workflow cancel).
 *
 * This pure decision maps a session's current `meta.turnRunId` to whether
 * tear-down must abort or only close this viewport's reader:
 *
 * - **Durable run (`turnRunId` present, post-E):** the run is Workflow-owned and
 *   keeps its identity on the envelope for the next attached viewport (slice F).
 *   Tear-down MUST NOT `abort()` the attached fetch as "the turn is over" — it
 *   closes this viewport's consumption only and never sends a server cancel.
 * - **Legacy tab-owned turn (no `turnRunId`, the slice-C reality):** there is no
 *   durable owner to detach to — the host is the ONLY Blob/envelope writer and
 *   it just left, so leaving the 1800s `/api/agent` Function running would burn
 *   inference with nothing persisted. Tear-down degrades to today's `abort()`.
 *
 * The plan-review Major fix: a naïve "detach = never abort" would strand a
 * present-but-unbacked legacy busy tab. Guarding on `turnRunId` **presence**
 * (not merely "no live turn") keeps the two cases distinct. No server cancel is
 * ever sent on either path — the abort here is the client AbortController for
 * the attached fetch, not a Workflow-cancel request.
 */

/** What a tear-down path should do with an in-flight turn. */
export type DetachTurnDecision =
  | { kind: 'abort'; reason: 'legacy-turn' }
  | { kind: 'close-reader'; reason: 'durable-run' };

/**
 * Decide how tear-down treats the turn, from the session's `turnRunId`.
 *
 * Absent → the turn is the tab-owned fetch (slice-C reality) and MUST abort so
 * no unpersisted inference keeps running with no writer.
 * Present → a durable Workflow-owned run: close-reader only, never abort, never
 * a server cancel.
 */
export function decideDetach(turnRunId: string | undefined): DetachTurnDecision {
  return turnRunId
    ? { kind: 'close-reader', reason: 'durable-run' }
    : { kind: 'abort', reason: 'legacy-turn' };
}
