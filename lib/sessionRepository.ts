/**
 * Async cloud session repository — id-shaped multi-session (phase 3, #415).
 * Client-safe — no Node/db imports. Host uses hybrid local SessionStore + this.
 *
 * #415 parent locks absorbed here:
 *  - **Canonical identity**: the persisted `SessionSnapshot.id` IS the server-minted
 *    session UUID; the repository key, the URL `?s=`, and the resource `:id` are all
 *    the same id. `put(id, snap)` fails closed when `snap.id !== id`.
 *  - **Per-session** coalesced single-in-flight PUT + epoch guard so Clear
 *    (remove) can never resurrect a cleared row.
 *  - 401 disables the whole repo (re-auth); missing Redis / tenancy-off → disabled.
 *  - `get` 404 → `notfound` so the host falls back to local/empty first paint,
 *    never blank.
 */
import {
  HARNESS_SESSION_MAX_BODY_BYTES,
  HARNESS_SESSION_MAX_MSG_BYTES,
  isRedisSafeOpaqueId,
  normalizeSessionCwd,
} from './sessionCloudCaps';
import type { SessionMessage, SessionRole, SessionSnapshot } from './sessionStore';

const SESSION_ROLES = new Set<SessionRole>(['user', 'assistant', 'system', 'error', 'tool_run']);

const DEFAULT_PATH = '/api/sessions';

export type SessionFetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Light summary from `GET /api/sessions` — **no transcripts** (parent #411). */
export type SessionSummary = {
  id: string;
  createdAt?: number;
  updatedAt?: number;
  title?: string;
};

export type CloudListResult =
  | { action: 'ok'; sessions: SessionSummary[] }
  | { action: 'disabled' }
  | { action: 'error'; status: number; message: string };

export type CloudGetResult =
  | { action: 'ok'; snapshot: SessionSnapshot }
  | { action: 'disabled' }
  | { action: 'notfound' }
  | { action: 'error'; status: number; message: string };

export type CloudCreateResult =
  | { action: 'ok'; snapshot: SessionSnapshot }
  | { action: 'disabled' }
  | { action: 'error'; status: number; message: string };

/** Result of a coalesced PUT for a specific session id. */
export type CloudPutResult =
  | { action: 'ok'; snapshot: SessionSnapshot }
  | { action: 'adopt'; snapshot: SessionSnapshot }
  | { action: 'disabled' }
  | { action: 'error'; status: number; message: string };

export type IdSessionRepository = {
  /** False after 401 for this page load. */
  readonly enabled: boolean;
  /** Fetch one full session record (404 → `notfound`). */
  get(id: string): Promise<CloudGetResult>;
  /** Fire-and-forget coalesced PUT (per session id; one in-flight PUT per id). */
  put(id: string, snapshot: SessionSnapshot): void;
  /** List the caller's sessions as light summaries. */
  list(): Promise<CloudListResult>;
  /** Mint a new server-side UUID session (POST /api/sessions). */
  create(opts?: { title?: string }): Promise<CloudCreateResult>;
  /** Mint the very first server session on mount; alias of create(). */
  createFirst(): Promise<CloudCreateResult>;
  /** DELETE one session; invalidates any in-flight PUT for that id. */
  remove(id: string): Promise<void>;
};

export type HttpSessionRepositoryOptions = {
  fetchImpl?: SessionFetchFn;
  path?: string;
  /** Called when a server body should replace local (put adopt). */
  onAdopt?: (snapshot: SessionSnapshot) => void;
  /**
   * Live local snapshot (for the active session) for adopt decisions after the
   * network returns. Without this, a 409/put-adopt can clobber turns that landed
   * during the round-trip.
   */
  getLocal?: () => SessionSnapshot | null;
};

const textEncoder = new TextEncoder();

export function utf8ByteLength(s: string): number {
  return textEncoder.encode(s).length;
}

/** Truncate string to at most maxBytes UTF-8, preferring a trailing ellipsis. */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = textEncoder.encode(s);
  if (bytes.length <= maxBytes) return s;
  const ellipsis = '…';
  const ell = textEncoder.encode(ellipsis);
  let budget = maxBytes;
  let suffix = '';
  if (budget > ell.length) {
    budget -= ell.length;
    suffix = ellipsis;
  }
  let end = budget;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.slice(0, end)) + suffix;
}

/** No user/assistant turns — system welcome counts as empty-of-dialogue. */
export function isEmptyOfDialogue(snapshot: SessionSnapshot): boolean {
  return !snapshot.messages.some((m) => m.role === 'user' || m.role === 'assistant');
}

/**
 * Adopt server when newer, or when local has no dialogue and server does.
 * Equal updatedAt → keep local.
 */
export function shouldAdoptServer(
  local: SessionSnapshot,
  server: SessionSnapshot,
): boolean {
  if (server.updatedAt > local.updatedAt) return true;
  if (isEmptyOfDialogue(local) && !isEmptyOfDialogue(server)) return true;
  return false;
}

/**
 * Parse a server GET/PUT/409 record body into a cloud `SessionSnapshot` (no cwd,
 * no tenant/user/createdAt/meta). Returns null if shape invalid, or if the record's
 * `id` does not match the resource id it was requested under (confused-deputy guard).
 */
export function parseCloudSessionSnapshot(
  body: unknown,
  expectedId?: string,
): SessionSnapshot | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (expectedId !== undefined && o.id !== expectedId) return null;
  if (typeof o.updatedAt !== 'number' || !Number.isFinite(o.updatedAt)) return null;
  if (!Array.isArray(o.messages)) return null;
  const messages: SessionMessage[] = [];
  for (const m of o.messages) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return null;
    const msg = m as Record<string, unknown>;
    if (typeof msg.id !== 'string' || !msg.id) return null;
    if (typeof msg.role !== 'string' || !SESSION_ROLES.has(msg.role as SessionRole)) {
      return null;
    }
    if (typeof msg.text !== 'string') return null;
    if (typeof msg.at !== 'number' || !Number.isFinite(msg.at)) return null;
    messages.push({
      id: msg.id,
      role: msg.role as SessionRole,
      text: msg.text,
      at: msg.at,
    });
  }
  // P1/GAP-1 (#452): restore the session-carrier fields from the stored record's
  // reserved `meta`. Normalized via the shared client-safe predicates so a poisoned
  // / side-channel value (host-absolute, escaping `..`, control chars) drops to
  // unset (fail-open) instead of becoming a sticky 400.
  let cwd: string | undefined;
  let activeSandboxId: string | undefined;
  if (o.meta !== null && typeof o.meta === 'object' && !Array.isArray(o.meta)) {
    const meta = o.meta as Record<string, unknown>;
    cwd = normalizeSessionCwd(meta.logicalCwd);
    const sandbox = meta.activeSandboxId;
    if (typeof sandbox === 'string' && sandbox && isRedisSafeOpaqueId(sandbox)) {
      activeSandboxId = sandbox;
    }
  }
  const snapshot: SessionSnapshot = {
    id: o.id,
    updatedAt: o.updatedAt,
    messages,
  };
  if (cwd !== undefined) snapshot.cwd = cwd;
  if (activeSandboxId !== undefined) snapshot.activeSandboxId = activeSandboxId;
  return snapshot;
}

/** Parse one `GET /api/sessions` summary row; null if invalid. */
export function parseSessionSummary(body: unknown): SessionSummary | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  const s: SessionSummary = { id: o.id };
  if (typeof o.createdAt === 'number' && Number.isFinite(o.createdAt)) s.createdAt = o.createdAt;
  if (typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt)) s.updatedAt = o.updatedAt;
  if (typeof o.title === 'string' && o.title.length > 0) s.title = o.title;
  return s;
}

/** Parse the `GET /api/sessions` list body; null if any row is invalid. */
export function parseSessionSummaryList(body: unknown): SessionSummary[] | null {
  if (!Array.isArray(body)) return null;
  const out: SessionSummary[] = [];
  for (const item of body) {
    const s = parseSessionSummary(item);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

/** The PUT wire body: `{ id, updatedAt, messages, meta? }` (P1/GAP-1 folds the session-carrier fields into `meta`). */
export type CloudPutBody = {
  id: string;
  updatedAt: number;
  messages: SessionMessage[];
  meta?: { activeSandboxId?: string; logicalCwd?: string };
};

/**
 * Fold the session-carrier fields into the reserved `meta` for the cloud PUT
 * (P1/GAP-1, #452): `logicalCwd` from `snapshot.cwd`, `activeSandboxId` from
 * `snapshot.activeSandboxId`. The cwd is run through `normalizeSessionCwd` (the
 * same form sent to `/api/agent`) so the persisted `meta.logicalCwd` is ALWAYS a
 * form the request path accepts on any device — a P1-legal-but-escaping `..`
 * cannot round-trip into Redis (review #453 residual). Empty / unset fields are
 * omitted. Returns `undefined` when nothing to carry.
 */
export function cloudMetaFor(
  snapshot: SessionSnapshot,
): CloudPutBody['meta'] | undefined {
  const meta: CloudPutBody['meta'] = {};
  const cwd = normalizeSessionCwd(snapshot.cwd);
  if (cwd !== undefined) meta.logicalCwd = cwd;
  const sandbox =
    typeof snapshot.activeSandboxId === 'string' &&
    snapshot.activeSandboxId &&
    isRedisSafeOpaqueId(snapshot.activeSandboxId)
      ? snapshot.activeSandboxId
      : undefined;
  if (sandbox !== undefined) meta.activeSandboxId = sandbox;
  return meta.logicalCwd === undefined && meta.activeSandboxId === undefined
    ? undefined
    : meta;
}

function cloudBodyBytes(body: CloudPutBody): number {
  return utf8ByteLength(JSON.stringify(body));
}

/**
 * Prepare local snapshot for PUT: fold the session-carrier fields (cwd /
 * `activeSandboxId`) into the reserved `meta` and enforce per-message + body byte
 * caps (byte accounting includes `meta`). No message-count ceiling — body size is the
 * storage/wire guard.
 */
export function trimForCloudPut(snapshot: SessionSnapshot): CloudPutBody {
  const messages = snapshot.messages.map((m) => ({
    id: m.id,
    role: m.role,
    text:
      utf8ByteLength(m.text) > HARNESS_SESSION_MAX_MSG_BYTES
        ? truncateUtf8(m.text, HARNESS_SESSION_MAX_MSG_BYTES)
        : m.text,
    at: m.at,
  }));
  const meta = cloudMetaFor(snapshot);
  const fresh = (ms: CloudPutBody['messages']): CloudPutBody => ({
    id: snapshot.id,
    updatedAt: snapshot.updatedAt,
    messages: ms,
    ...(meta !== undefined ? { meta } : {}),
  });

  let out = fresh(messages);

  while (out.messages.length > 0 && cloudBodyBytes(out) > HARNESS_SESSION_MAX_BODY_BYTES) {
    if (out.messages.length === 1) {
      // Single message still too large — shrink text until under body cap.
      const only = out.messages[0];
      let budget = Math.min(HARNESS_SESSION_MAX_MSG_BYTES, utf8ByteLength(only.text));
      let best = '';
      while (budget > 0) {
        const candidate = truncateUtf8(only.text, budget);
        if (cloudBodyBytes(fresh([{ ...only, text: candidate }])) <= HARNESS_SESSION_MAX_BODY_BYTES) {
          best = candidate;
          break;
        }
        budget = Math.floor(budget / 2);
      }
      out = fresh([{ ...only, text: best }]);
      break;
    }
    out = fresh(out.messages.slice(1));
  }

  return out;
}

export function createHttpSessionRepository(
  opts: HttpSessionRepositoryOptions = {},
): IdSessionRepository {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const path = opts.path ?? DEFAULT_PATH;
  let enabled = true;

  /** Per-session put channel: coalesced pending + in-flight + epoch guard. */
  type Channel = { pending: SessionSnapshot | null; inflight: boolean; epoch: number };
  const channels = new Map<string, Channel>();
  function channel(id: string): Channel {
    let c = channels.get(id);
    if (!c) {
      c = { pending: null, inflight: false, epoch: 0 };
      channels.set(id, c);
    }
    return c;
  }

  function disable() {
    enabled = false;
    channels.clear();
  }

  function liveLocal(fallback: SessionSnapshot | null): SessionSnapshot | null {
    return opts.getLocal?.() ?? fallback;
  }

  async function deleteOne(id: string): Promise<void> {
    try {
      const res = await fetchImpl(`${path}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        disable();
        return;
      }
      // DELETE 404 is idempotent (row absent) — nothing to disable.
    } catch {
      /* ignore network */
    }
  }

  async function get(id: string): Promise<CloudGetResult> {
    if (!enabled) return { action: 'disabled' };
    try {
      const res = await fetchImpl(`${path}/${encodeURIComponent(id)}`, {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        disable();
        return { action: 'disabled' };
      }
      if (res.status === 404) {
        return { action: 'notfound' };
      }
      if (!res.ok) {
        return {
          action: 'error',
          status: res.status,
          message: `Session pull failed (${res.status}).`,
        };
      }
      const parsed = parseCloudSessionSnapshot(await res.json(), id);
      if (!parsed) {
        return { action: 'error', status: res.status, message: 'Invalid session body.' };
      }
      return { action: 'ok', snapshot: parsed };
    } catch {
      return { action: 'error', status: 0, message: 'Network error pulling session.' };
    }
  }

  async function list(): Promise<CloudListResult> {
    if (!enabled) return { action: 'disabled' };
    try {
      const res = await fetchImpl(path, {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        disable();
        return { action: 'disabled' };
      }
      if (!res.ok) {
        return {
          action: 'error',
          status: res.status,
          message: `Session list failed (${res.status}).`,
        };
      }
      const parsed = parseSessionSummaryList(await res.json());
      if (!parsed) {
        return { action: 'error', status: res.status, message: 'Invalid session list body.' };
      }
      return { action: 'ok', sessions: parsed };
    } catch {
      return { action: 'error', status: 0, message: 'Network error listing sessions.' };
    }
  }

  async function create(opts?: { title?: string }): Promise<CloudCreateResult> {
    if (!enabled) return { action: 'disabled' };
    try {
      const payload = opts?.title ? JSON.stringify({ title: opts.title }) : null;
      const res = await fetchImpl(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: payload ? { 'content-type': 'application/json' } : undefined,
        body: payload ?? undefined,
      });
      if (res.status === 401) {
        disable();
        return { action: 'disabled' };
      }
      if (!res.ok) {
        return {
          action: 'error',
          status: res.status,
          message: `Session create failed (${res.status}).`,
        };
      }
      const parsed = parseCloudSessionSnapshot(await res.json());
      if (!parsed) {
        return { action: 'error', status: res.status, message: 'Invalid session body.' };
      }
      return { action: 'ok', snapshot: parsed };
    } catch {
      return { action: 'error', status: 0, message: 'Network error creating session.' };
    }
  }

  async function createFirst(): Promise<CloudCreateResult> {
    return create();
  }

  async function putOnce(
    id: string,
    snapshot: SessionSnapshot,
    scheduledEpoch: number,
    c: Channel,
  ): Promise<CloudPutResult> {
    if (!enabled || snapshot.id !== id) return { action: 'disabled' };
    const body = trimForCloudPut(snapshot);
    try {
      const res = await fetchImpl(`${path}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // Clear raced this PUT — server may have re-upserted; DELETE again.
      if (c.epoch !== scheduledEpoch) {
        await deleteOne(id);
        return { action: 'disabled' };
      }
      if (res.status === 401) {
        disable();
        return { action: 'disabled' };
      }
      if (res.status === 404) {
        return {
          action: 'error',
          status: 404,
          message: 'Session push failed (404).',
        };
      }
      if (res.status === 409) {
        const parsed = parseCloudSessionSnapshot(await res.json(), id);
        if (c.epoch !== scheduledEpoch) {
          await deleteOne(id);
          return { action: 'disabled' };
        }
        if (parsed && maybeAdopt(parsed, snapshot)) {
          return { action: 'adopt', snapshot: parsed };
        }
        return {
          action: 'error',
          status: 409,
          message: parsed
            ? 'Session conflict; local is already newer.'
            : 'Session conflict with invalid body.',
        };
      }
      if (!res.ok) {
        return {
          action: 'error',
          status: res.status,
          message: `Session push failed (${res.status}).`,
        };
      }
      const parsed = parseCloudSessionSnapshot(await res.json(), id);
      if (c.epoch !== scheduledEpoch) {
        await deleteOne(id);
        return { action: 'disabled' };
      }
      return {
        action: 'ok',
        snapshot: parsed ?? body,
      };
    } catch {
      if (c.epoch !== scheduledEpoch) {
        // Best-effort: PUT may have landed after clear.
        await deleteOne(id);
      }
      return { action: 'error', status: 0, message: 'Network error pushing session.' };
    }
  }

  function maybeAdopt(server: SessionSnapshot, fallbackLocal: SessionSnapshot): boolean {
    const live = liveLocal(fallbackLocal);
    if (!live) return false;
    // Identity guard (adversarial review #430): this 409 body is a server snapshot of
    // the SESSION THIS PUT TARGETED (== fallbackLocal.id). The live active session may
    // be a *different* one if the user switched during the network round-trip. Never
    // adopt a server body for one session into the active UI slot — the live session's
    // id must exactly match the server session's id (and the put resource id).
    if (live.id !== server.id) return false;
    if (!shouldAdoptServer(live, server)) return false;
    opts.onAdopt?.(server);
    return true;
  }

  async function drain(id: string, c: Channel): Promise<void> {
    if (c.inflight) return;
    c.inflight = true;
    try {
      while (enabled && c.pending) {
        const next = c.pending;
        c.pending = null;
        const scheduledEpoch = c.epoch;
        await putOnce(id, next, scheduledEpoch, c);
      }
    } finally {
      c.inflight = false;
      if (enabled && c.pending) {
        void drain(id, c);
      }
    }
  }

  function put(id: string, snapshot: SessionSnapshot): void {
    if (!enabled) return;
    // Canonical identity (parent #415): a snapshot never stores under a different
    // resource id than its own persisted id.
    if (snapshot.id !== id) return;
    const c = channel(id);
    c.pending = snapshot;
    void drain(id, c);
  }

  async function remove(id: string): Promise<void> {
    if (!enabled) return;
    const c = channel(id);
    // Invalidate any in-flight PUT (epoch) and drop queued push so clear never
    // leaves a resurrected cloud row after DELETE.
    c.epoch += 1;
    c.pending = null;
    await deleteOne(id);
  }

  return {
    get enabled() {
      return enabled;
    },
    get,
    put,
    list,
    create,
    createFirst,
    remove,
  };
}
