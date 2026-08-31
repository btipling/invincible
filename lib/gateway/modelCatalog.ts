/**
 * Unauthenticated effort catalogs — Gateway `/v1/models` plus a models.dev
 * `vercel.models` overlay. Join at read: overlay fills a missing/empty
 * Gateway list; a nonempty Gateway list wins disagreements. Never call
 * this inside a `'use step'` / `'use workflow'` function; `/api/models` and
 * the turn-start HTTP boundary are the only callers. Fail-open to an empty map.
 *
 * Failures (throw / HTTP !ok / abort / oversize overlay) are **negatively
 * cached** for the same TTL as a success so a hung catalog cannot stall every
 * `/api/turns` start. Overlapping callers share one in-flight GET per source
 * (single-flight).
 */
import {
  GATEWAY_MODELS_CACHE_TTL_MS,
  GATEWAY_MODELS_FETCH_TIMEOUT_MS,
  MODELS_DEV_FETCH_MAX_BYTES,
  REASONING_EFFORT_VALUES_MAX,
  sanitizeReasoningEffort,
} from '../sessionCloudCaps';

export const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';
export const MODELS_DEV_URL = 'https://models.dev/api.json';

export type FetchImpl = (
  input: string,
  init?: { signal?: AbortSignal; redirect?: RequestRedirect },
) => Promise<{
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
}>;

type CacheEntry = { fetchedAt: number; map: Map<string, string[]> };

let cache: CacheEntry | null = null;
let inflight: Promise<Map<string, string[]>> | null = null;
let overlayCache: CacheEntry | null = null;
let overlayInflight: Promise<Map<string, string[]>> | null = null;

/** Test-only: drop Gateway + overlay caches and in-flight GETs. */
export function resetGatewayModelsCache(): void {
  cache = null;
  inflight = null;
  overlayCache = null;
  overlayInflight = null;
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

/**
 * Parse models.dev `api.json` → `vercel.models` record. Object **keys** are
 * Gateway ids. Lab maps (`zai.models`, …) are ignored. Nested `row.id` is
 * ignored when it disagrees with the key.
 */
export function parseModelsDevEffortMap(payload: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return out;
  }
  const vercel = (payload as { vercel?: unknown }).vercel;
  if (vercel == null || typeof vercel !== 'object' || Array.isArray(vercel)) {
    return out;
  }
  const models = (vercel as { models?: unknown }).models;
  if (models == null || typeof models !== 'object' || Array.isArray(models)) {
    return out;
  }
  for (const [id, row] of Object.entries(models as Record<string, unknown>)) {
    if (!id.trim()) continue;
    if (row == null || typeof row !== 'object' || Array.isArray(row)) {
      out.set(id, []);
      continue;
    }
    out.set(id, effortValuesFromRow(row));
  }
  return out;
}

/**
 * Overlay fills a missing/empty Gateway list (GLM-5.3-flash today).
 * A nonempty Gateway list wins disagreements — overlay must not drop
 * Gateway-only tokens (`none` on grok-4.3) or add wire-unknown values.
 */
export function joinEffortMaps(
  overlay: Map<string, string[]>,
  gateway: Map<string, string[]>,
): Map<string, string[]> {
  const out = new Map(gateway);
  for (const [id, values] of overlay) {
    if (values.length === 0) continue;
    const existing = out.get(id);
    if (!existing || existing.length === 0) out.set(id, values);
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

async function readCappedUtf8(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      n += value.byteLength;
      if (n > MODELS_DEV_FETCH_MAX_BYTES) {
        throw new Error('models.dev payload oversize');
      }
      chunks.push(value);
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      /* already closed / locked */
    }
    throw err;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* cancel() already released */
    }
  }
  const buf = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

async function payloadFromModelsDevResponse(res: {
  json: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
}): Promise<unknown> {
  if (res.body && typeof res.body.getReader === 'function') {
    const text = await readCappedUtf8(res.body);
    return JSON.parse(text) as unknown;
  }
  if (typeof res.arrayBuffer === 'function') {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MODELS_DEV_FETCH_MAX_BYTES) {
      throw new Error('models.dev payload oversize');
    }
    const text = new TextDecoder().decode(buf);
    return JSON.parse(text) as unknown;
  }
  return res.json();
}

async function fetchModelsDevEffortMap(
  fetchImpl: FetchImpl,
): Promise<Map<string, string[]>> {
  const res = await fetchImpl(MODELS_DEV_URL, {
    signal: AbortSignal.timeout(GATEWAY_MODELS_FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) {
    throw new Error(`models.dev HTTP ${res.status ?? 'error'}`);
  }
  const payload = await payloadFromModelsDevResponse(res);
  return parseModelsDevEffortMap(payload);
}

function loadCachedMap(
  entry: CacheEntry | null,
  now: number,
): Map<string, string[]> | null {
  if (entry && now - entry.fetchedAt < GATEWAY_MODELS_CACHE_TTL_MS) {
    return entry.map;
  }
  return null;
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
  const hit = loadCachedMap(cache, now);
  if (hit) return hit;
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

/** models.dev `vercel.models` overlay — same TTL / fail-open / negative-cache. */
export async function getModelsDevEffortMap(opts?: {
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Promise<Map<string, string[]>> {
  const now = (opts?.now ?? Date.now)();
  const hit = loadCachedMap(overlayCache, now);
  if (hit) return hit;
  if (overlayInflight) return overlayInflight;

  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchImpl);
  overlayInflight = (async () => {
    try {
      const map = await fetchModelsDevEffortMap(fetchImpl);
      overlayCache = { fetchedAt: now, map };
      return map;
    } catch {
      const fallback = overlayCache?.map ?? new Map();
      overlayCache = { fetchedAt: now, map: fallback };
      return fallback;
    } finally {
      overlayInflight = null;
    }
  })();
  return overlayInflight;
}

/** Overlay fills Gateway holes. Each source fail-opens independently. */
export async function getJoinedEffortMap(opts?: {
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Promise<Map<string, string[]>> {
  const [overlay, gateway] = await Promise.all([
    getModelsDevEffortMap(opts),
    getGatewayEffortMap(opts),
  ]);
  return joinEffortMaps(overlay, gateway);
}

/** Effort values for one model id (empty when unknown / fetch failed). */
export async function effortValuesForModel(
  modelId: string,
  opts?: { fetchImpl?: FetchImpl; now?: () => number },
): Promise<string[]> {
  const map = await getJoinedEffortMap(opts);
  return map.get(modelId) ?? [];
}
