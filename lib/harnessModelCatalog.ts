/**
 * Pure parse of the `GET /api/models` catalog entries for the DOM host
 * (plan #944, testing row 13). Extracted from `app/harness/HarnessHost.tsx`
 * so the model-id / effort / context-window parse is unit-testable without
 * rendering React.
 *
 * The `contextWindow` field is the model's published context window in tokens
 * (plan #944 — non-secret catalog metadata). It sizes the LEGACY fold trim
 * only (`formatPromptWithHistory`'s token budget via
 * `lib/harnessChat.ts`); the durable `/api/turns` seed trim resolves the
 * window server-side at the route boundary. A missing/invalid window is
 * dropped per entry (fail-closed) — the fold then uses the conservative
 * default; never a fabricated window.
 */
import { sanitizeReasoningEffort } from './sessionCloudCaps';

export type ParsedModelCatalog = {
  /** Granted model ids, in wire order (never empty-string). */
  models: string[];
  /** Sanitized effort values per model id (possibly empty lists). */
  reasoningById: Record<string, string[]>;
  /** Published context window (tokens) per model id — only where published. */
  windowById: Record<string, number>;
};

/** Accept a positive finite integer token count; everything else → undefined. */
function parseWindowValue(v: unknown): number | undefined {
  if (typeof v !== 'number') return undefined;
  if (!Number.isInteger(v) || v <= 0 || !Number.isFinite(v)) return undefined;
  return v;
}

/**
 * Parse the catalog `models` array (each `{ id?, reasoningOptions?, contextWindow? }`).
 * Returns `undefined` for a non-array payload (caller maps to its own invalid
 * response). Duplicates drop (first wins); a missing/invalid `contextWindow`
 * simply omits that model from `windowById`.
 */
export function parseModelCatalogEntries(
  entries: unknown,
): ParsedModelCatalog | undefined {
  if (!Array.isArray(entries)) return undefined;
  const models: string[] = [];
  const reasoningById: Record<string, string[]> = {};
  const windowById: Record<string, number> = {};
  for (const m of entries) {
    const id = typeof (m as { id?: unknown })?.id === 'string'
      ? ((m as { id: string }).id).trim()
      : '';
    if (!id) continue;
    if (!models.includes(id)) models.push(id);
    const raw = (m as { reasoningOptions?: unknown }).reasoningOptions;
    const values: string[] = [];
    if (Array.isArray(raw)) {
      for (const v of raw) {
        const token = sanitizeReasoningEffort(v);
        if (token && !values.includes(token)) values.push(token);
      }
    }
    reasoningById[id] = values;
    const w = parseWindowValue((m as { contextWindow?: unknown }).contextWindow);
    if (w !== undefined && windowById[id] === undefined) windowById[id] = w;
  }
  return { models, reasoningById, windowById };
}

/**
 * The published window for one model id, or `undefined` when the catalog did
 * not publish one (caller falls back to the conservative default — never a
 * fabricated number).
 */
export function contextWindowFor(
  windowById: Record<string, number> | undefined,
  modelId: string | undefined,
): number | undefined {
  if (!windowById || !modelId) return undefined;
  return parseWindowValue(windowById[modelId]);
}
