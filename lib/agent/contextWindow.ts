/**
 * Per-model context-window resolver (plan #944, source #551 — A3 fold
 * budget). Pure + shared: given a joined window map (model id → tokens) and
 * a model id, return the published window or the documented conservative
 * default (`CONTEXT_WINDOW_DEFAULT_TOKENS`) — never a fabricated large
 * number and never a fake `% of window` (the #547 honesty lock).
 *
 * The map itself is resolved at the route/start boundary
 * (`app/api/turns/route.ts`, `/api/models`) by
 * `lib/gateway/modelCatalog.ts` `getJoinedWindowMap` — never inside a
 * `'use step'` / `'use workflow'` function. No I/O here.
 */
import { CONTEXT_WINDOW_DEFAULT_TOKENS } from '../sessionCloudCaps';

/**
 * The model's context window in tokens. Known id → the published window;
 * unknown id / failed fetch → `CONTEXT_WINDOW_DEFAULT_TOKENS` (never a lie,
 * never a fabricated large number). The value is the model's FULL window —
 * the fold budget subtracts the completion reserve separately
 * (`foldBudgetTokens`).
 */
export function contextWindowForModel(
  windowMap: ReadonlyMap<string, number> | undefined,
  modelId: string,
): number {
  const w = windowMap?.get(modelId);
  if (
    typeof w === 'number' &&
    Number.isFinite(w) &&
    w > 0 &&
    Number.isInteger(w)
  ) {
    return w;
  }
  return CONTEXT_WINDOW_DEFAULT_TOKENS;
}
