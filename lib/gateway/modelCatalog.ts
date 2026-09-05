/**
 * Unauthenticated effort catalogs — Gateway `/v1/models` plus a models.dev
 * `vercel.models` overlay. Join at read: overlay fills a missing/empty
 * Gateway list; a nonempty Gateway list wins disagreements. Never call
 * this inside a `'use step'` / `'use workflow'` function; `/api/models` and
 * the turn-start HTTP boundary are the only callers. Fail-open to an empty map.
 *
 * The same two sources also publish a per-model **context window** (plan
 * #944): Gateway `context_length`, models.dev `limit.context` — parsed into
 * parallel window maps (`getJoinedWindowMap`) with the same TTL / fail-open /
 * negative-cache discipline. **One GET per source** parses both the effort
 * list and the window (adversarial #945) — `/api/models` must not hit each
 * URL twice. Unknown id → the caller applies the documented
 * conservative default (`lib/agent/contextWindow.ts`), never a fabricated
 * window.
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
  adaptEffortToken,
  sanitizeReasoningEffort,
} from '../sessionCloudCaps';

export const GATEWAY_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * Parse a catalog row's published context window into a positive integer
 * token count (plan #944). Gateway `/v1/models` publishes `context_length`;
 * models.dev publishes `limit.context`. Accepts a number (integer > 0) or a
 * numeric string; everything else (0, negative, fractional, NaN, garbage) →
 * `undefined` (fail-closed — the caller falls back to the conservative
 * default, never a fabricated window). Deliberately no `% of window` math
 * here (the #547 honesty lock): this is a real published maximum or nothing.
 */
export function parseContextWindow(row: unknown): number | undefined {
  if (row == null || typeof row !== 'object') return undefined;
  const raw = (row as { context_length?: unknown }).context_length;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (
    typeof raw === 'string' &&
    /^[0-9]+$/.test(raw) &&
    Number.parseInt(raw, 10) > 0
  ) {
    return Number.parseInt(raw, 10);
  }
  return undefined;
}

/**
 * Parse a models.dev row's `limit.context` window (plan #944). Same
 * fail-closed rule as `parseContextWindow`; the models.dev shape nests the
 * window under `limit`.
 */
export function parseModelsDevContextWindow(row: unknown): number | undefined {
  if (row == null || typeof row !== 'object') return undefined;
  const limit = (row as { limit?: unknown }).limit;
  if (limit == null || typeof limit !== 'object') return undefined;
  const context = (limit as { context?: unknown }).context;
  if (typeof context === 'number' && Number.isInteger(context) && context > 0) {
    return context;
  }
  if (
    typeof context === 'string' &&
    /^[0-9]+$/.test(context) &&
    Number.parseInt(context, 10) > 0
  ) {
    return Number.parseInt(context, 10);
  }
  return undefined;
}

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

/** Model id → published context window in tokens (plan #944). */
export type WindowMap = Map<string, number>;

/** One Gateway / models.dev GET parses both effort and window maps. */
type SourceBundle = {
  fetchedAt: number;
  effort: Map<string, string[]>;
  windows: WindowMap;
};

let gatewayBundle: SourceBundle | null = null;
let gatewayBundleInflight: Promise<SourceBundle> | null = null;
let overlayBundle: SourceBundle | null = null;
let overlayBundleInflight: Promise<SourceBundle> | null = null;

/** Test-only: drop Gateway + overlay caches and in-flight GETs. */
export function resetGatewayModelsCache(): void {
  gatewayBundle = null;
  gatewayBundleInflight = null;
  overlayBundle = null;
  overlayBundleInflight = null;
}

/**
 * Parse Gateway `/v1/models` JSON into model-id → published context window
 * (plan #944). Rows without a parseable `context_length` are ABSENT from the
 * map (never a fabricated default inside the catalog — the default lives in
 * `contextWindowForModel`). Ignores everything else on the row.
 */
export function parseGatewayWindowMap(payload: unknown): WindowMap {
  const out: WindowMap = new Map();
  if (payload == null || typeof payload !== 'object') return out;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return out;
  for (const row of data) {
    if (row == null || typeof row !== 'object') continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== 'string' || !id.trim()) continue;
    const w = parseContextWindow(row);
    if (w !== undefined) out.set(id, w);
  }
  return out;
}

/**
 * Parse models.dev `api.json` → `vercel.models` `limit.context` windows
 * (plan #944). Object keys are Gateway ids; lab maps ignored; a row with no
 * parseable window is simply absent from the map.
 */
export function parseModelsDevWindowMap(payload: unknown): WindowMap {
  const out: WindowMap = new Map();
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
    const w = parseModelsDevContextWindow(row);
    if (w !== undefined) out.set(id, w);
  }
  return out;
}

/**
 * Overlay fills a missing Gateway window; a published Gateway window WINS
 * disagreements (same precedence as the effort join — Gateway is primary).
 */
export function joinWindowMaps(
  overlay: WindowMap,
  gateway: WindowMap,
): WindowMap {
  const out: WindowMap = new Map(gateway);
  for (const [id, w] of overlay) {
    if (!out.has(id)) out.set(id, w);
  }
  return out;
}

/**
 * Parse Gateway `/v1/models` JSON into model-id → effort-value list.
 * Ignores `toggle` / `budget_tokens`. Rewrites `max` → `xhigh` (the only
 * lab alias) then drops remaining non-wire tokens. Caps list length.
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
      const wire = adaptEffortToken(token);
      if (!wire) continue;
      if (values.includes(wire)) continue;
      values.push(wire);
      if (values.length >= REASONING_EFFORT_VALUES_MAX) return values;
    }
  }
  return values;
}

async function fetchGatewayPayload(
  fetchImpl: FetchImpl,
): Promise<unknown> {
  const res = await fetchImpl(GATEWAY_MODELS_URL, {
    signal: AbortSignal.timeout(GATEWAY_MODELS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gateway models HTTP ${res.status ?? 'error'}`);
  }
  return res.json();
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

async function fetchModelsDevPayload(
  fetchImpl: FetchImpl,
): Promise<unknown> {
  const res = await fetchImpl(MODELS_DEV_URL, {
    signal: AbortSignal.timeout(GATEWAY_MODELS_FETCH_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) {
    throw new Error(`models.dev HTTP ${res.status ?? 'error'}`);
  }
  return payloadFromModelsDevResponse(res);
}

function loadBundle(entry: SourceBundle | null, now: number): SourceBundle | null {
  if (entry && now - entry.fetchedAt < GATEWAY_MODELS_CACHE_TTL_MS) {
    return entry;
  }
  return null;
}

function emptyBundle(now: number): SourceBundle {
  return { fetchedAt: now, effort: new Map(), windows: new Map() };
}

/**
 * Best-effort per-instance catalog. TTL `GATEWAY_MODELS_CACHE_TTL_MS`.
 * Fetch/parse/timeout failure → last good bundle, else empty (never throws).
 * Failed fetches write that fallback into cache so the next caller within
 * TTL does not retry the GET (adversarial-review #899 L5).
 * One GET parses effort + window (adversarial #945).
 */
async function getGatewayBundle(opts?: {
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Promise<SourceBundle> {
  const now = (opts?.now ?? Date.now)();
  const hit = loadBundle(gatewayBundle, now);
  if (hit) return hit;
  if (gatewayBundleInflight) return gatewayBundleInflight;

  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchImpl);
  gatewayBundleInflight = (async () => {
    try {
      const payload = await fetchGatewayPayload(fetchImpl);
      const bundle: SourceBundle = {
        fetchedAt: now,
        effort: parseGatewayEffortMap(payload),
        windows: parseGatewayWindowMap(payload),
      };
      gatewayBundle = bundle;
      return bundle;
    } catch {
      const fallback = gatewayBundle ?? emptyBundle(now);
      gatewayBundle = { ...fallback, fetchedAt: now };
      return gatewayBundle;
    } finally {
      gatewayBundleInflight = null;
    }
  })();
  return gatewayBundleInflight;
}

export async function getGatewayEffortMap(opts?: {
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Promise<Map<string, string[]>> {
  return (await getGatewayBundle(opts)).effort;
}

/** models.dev `vercel.models` overlay — same TTL / fail-open / negative-cache. */
async function getModelsDevBundle(opts?: {
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Promise<SourceBundle> {
  const now = (opts?.now ?? Date.now)();
  const hit = loadBundle(overlayBundle, now);
  if (hit) return hit;
  if (overlayBundleInflight) return overlayBundleInflight;

  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchImpl);
  overlayBundleInflight = (async () => {
    try {
      const payload = await fetchModelsDevPayload(fetchImpl);
      const bundle: SourceBundle = {
        fetchedAt: now,
        effort: parseModelsDevEffortMap(payload),
        windows: parseModelsDevWindowMap(payload),
      };
      overlayBundle = bundle;
      return bundle;
    } catch {
      const fallback = overlayBundle ?? emptyBundle(now);
      overlayBundle = { ...fallback, fetchedAt: now };
      return overlayBundle;
    } finally {
      overlayBundleInflight = null;
    }
  })();
  return overlayBundleInflight;
}

export async function getModelsDevEffortMap(opts?: {
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Promise<Map<string, string[]>> {
  return (await getModelsDevBundle(opts)).effort;
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

/** Load the Gateway window map (plan #944) — same TTL / negative-cache shape. */
export async function getGatewayWindowMap(opts?: {
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Promise<WindowMap> {
  return (await getGatewayBundle(opts)).windows;
}

/** Load the models.dev overlay window map — same shape, streaming-capped body. */
export async function getModelsDevWindowMap(opts?: {
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Promise<WindowMap> {
  return (await getModelsDevBundle(opts)).windows;
}

/**
 * Joined per-model context-window map (plan #944) — Gateway primary, models.dev
 * overlay fills holes; each source fail-opens independently to an empty map.
 * Route/start-boundary callers only (never inside `'use step'`).
 */
export async function getJoinedWindowMap(opts?: {
  fetchImpl?: FetchImpl;
  now?: () => number;
}): Promise<WindowMap> {
  const [overlay, gateway] = await Promise.all([
    getModelsDevWindowMap(opts),
    getGatewayWindowMap(opts),
  ]);
  return joinWindowMaps(overlay, gateway);
}

/**
 * The published context window for one model id (plan #944), or `undefined`
 * when neither source publishes one — the caller applies the conservative
 * default (`contextWindowForModel`), never the catalog.
 */
export async function contextWindowForModelId(
  modelId: string,
  opts?: { fetchImpl?: FetchImpl; now?: () => number },
): Promise<number | undefined> {
  const map = await getJoinedWindowMap(opts);
  return map.get(modelId);
}
