/**
 * Unauthenticated Vercel AI Gateway model catalog — effort values only.
 *
 * Fetched from `GET https://ai-gateway.vercel.sh/v1/models`. Never call this
 * inside a `'use step'` / `'use workflow'` function; `/api/models` and the
 * turn-start HTTP boundary are the only callers. Fail-open to an empty map.
 *
 * Failures (throw / HTTP !ok / abort) are **negatively cached** for the same
 * TTL as a success so a hung Gateway cannot stall every `/api/turns` start.
 * Overlapping callers share one in-flight GET (single-flight).
 */
import {
  GATEWAY_MODELS_CACHE_TTL_MS,
  GATEWAY_MODELS_FETCH_TIMEOUT_MS,
  REASONING_EFFORT_VALUES_MAX,
  sanitizeReasoningEffort,
} from '../sessionCloudCaps';

export const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';

export type FetchImpl = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}>;

type CacheEntry = { fetchedAt: number; map: Map<string, string[]> };

let cache: CacheEntry | null = null;
let inflight: Promise<Map<string, string[]>> | null = null;

/** Test-only: drop the in-process catalog cache + in-flight GET. */
export function resetGatewayModelsCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Parse Gateway `/v1/models` JSON into model-id → effort-value list.
 * Ignores `toggle` / `budget_tokens`. Drops junk tokens. Caps list length.
 */
export function parseGatewayEffortMap(payload: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (payload == null || typeof payload !== 'object') return out;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return out;
  for (const row of data) {
    if (row == null || typeof row !== 'object') continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== 'string' || !id.trim()) continue;
    const values = effortValuesFromRow(row);
    out.set(id, values);
  }
  return out;
}

function effortValuesFromRow(row: object): string[] {
  const raw = (row as { reasoning_options?: unknown }).reasoning_options;
  if (!Array.isArray(raw)) return [];
  const values: string[] = [];
  for (const opt of raw) {
    if (opt == null || typeof opt !== 'object') continue;
    const type = (opt as { type?: unknown }).type;
    if (type !== 'effort') continue;
    const listed = (opt as { values?: unknown }).values;
    if (!Array.isArray(listed)) continue;
    for (const v of listed) {
      const token = sanitizeReasoningEffort(v);
      if (!token) continue;
      if (values.includes(token)) continue;
      values.push(token);
      if (values.length >= REASONING_EFFORT_VALUES_MAX) return values;
    }
  }
  return values;
}

async function fetchGatewayEffortMap(
  fetchImpl: FetchImpl,
): Promise<Map<string, string[]>> {
  const res = await fetchImpl(GATEWAY_MODELS_URL, {
    signal: AbortSignal.timeout(GATEWAY_MODELS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gateway models HTTP ${res.status ?? 'error'}`);
  }
  const payload = await res.json();
  return parseGatewayEffortMap(payload);
}

/**
 * Best-effort per-instance catalog. TTL `GATEWAY_MODELS_CACHE_TTL_MS`.
 * Fetch/parse/timeout failure → last good map, else empty (never throws).
 * Failed fetches write that fallback into cache so the next caller within
 * TTL does not retry the GET (adversarial-review #899 L5).
 */
export async function getGatewayEffortMap(opts?: {
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Promise<Map<string, string[]>> {
  const now = (opts?.now ?? Date.now)();
  if (cache && now - cache.fetchedAt < GATEWAY_MODELS_CACHE_TTL_MS) {
    return cache.map;
  }
  if (inflight) return inflight;

  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchImpl);
  inflight = (async () => {
    try {
      const map = await fetchGatewayEffortMap(fetchImpl);
      cache = { fetchedAt: now, map };
      return map;
    } catch {
      const fallback = cache?.map ?? new Map();
      cache = { fetchedAt: now, map: fallback };
      return fallback;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Effort values for one model id (empty when unknown / fetch failed). */
export async function effortValuesForModel(
  modelId: string,
  opts?: { fetchImpl?: FetchImpl; now?: () => number },
): Promise<string[]> {
  const map = await getGatewayEffortMap(opts);
  return map.get(modelId) ?? [];
}
