/**
 * Async cloud session repository.
 * Client-safe — no Node/db imports. Host uses hybrid local SessionStore + this.
 */
import {
  CLOUD_SESSION_DISABLED_CODE,
  HARNESS_SESSION_MAX_BODY_BYTES,
  HARNESS_SESSION_MAX_MSG_BYTES,
} from './sessionCloudCaps';
import type { SessionMessage, SessionRole, SessionSnapshot } from './sessionStore';

const SESSION_ROLES = new Set<SessionRole>(['user', 'assistant', 'system', 'error', 'tool_run']);

const DEFAULT_PATH = '/api/session';

export type SessionFetchFn = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type CloudPullResult =
  | { action: 'noop' }
  | { action: 'disabled' }
  | { action: 'adopt'; snapshot: SessionSnapshot }
  | { action: 'error'; status: number; message: string };

export type CloudPushResult =
  | { action: 'ok'; snapshot: SessionSnapshot }
  | { action: 'adopt'; snapshot: SessionSnapshot }
  | { action: 'disabled' }
  | { action: 'error'; status: number; message: string };

export type SessionRepository = {
  /** False after 401 / CLOUD_SESSION_DISABLED for this page load. */
  readonly enabled: boolean;
  pull(local: SessionSnapshot): Promise<CloudPullResult>;
  /** Coalesced fire-and-forget PUT of latest snapshot. */
  schedulePush(snapshot: SessionSnapshot): void;
  /** DELETE only — never PUT empty. Invalidates in-flight PUTs. */
  remove(): Promise<void>;
};

export type HttpSessionRepositoryOptions = {
  fetchImpl?: SessionFetchFn;
  path?: string;
  /** Called when server body should replace local (pull adopt or 409). */
  onAdopt?: (snapshot: SessionSnapshot) => void;
  /**
   * Live local snapshot for adopt decisions after network returns.
   * Without this, pull/409 can clobber turns that landed during the round-trip.
   */
  getLocal?: () => SessionSnapshot;
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
 * Parse GET/PUT/409 JSON into a cloud SessionSnapshot (no cwd).
 * Returns null if shape invalid.
 */
export function parseCloudSessionSnapshot(body: unknown): SessionSnapshot | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
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
  return {
    id: o.id,
    updatedAt: o.updatedAt,
    messages,
  };
}

function cloudBodyBytes(snapshot: SessionSnapshot): number {
  return utf8ByteLength(
    JSON.stringify({
      id: snapshot.id,
      updatedAt: snapshot.updatedAt,
      messages: snapshot.messages,
    }),
  );
}

/**
 * Prepare local snapshot for PUT: omit cwd; enforce per-message + body byte caps.
 * No message-count ceiling — body size is the storage/wire guard.
 */
export function trimForCloudPut(snapshot: SessionSnapshot): SessionSnapshot {
  let messages = snapshot.messages.map((m) => ({
    id: m.id,
    role: m.role,
    text:
      utf8ByteLength(m.text) > HARNESS_SESSION_MAX_MSG_BYTES
        ? truncateUtf8(m.text, HARNESS_SESSION_MAX_MSG_BYTES)
        : m.text,
    at: m.at,
  }));

  let out: SessionSnapshot = {
    id: snapshot.id,
    updatedAt: snapshot.updatedAt,
    messages,
  };

  while (
    out.messages.length > 0 &&
    cloudBodyBytes(out) > HARNESS_SESSION_MAX_BODY_BYTES
  ) {
    if (out.messages.length === 1) {
      // Single message still too large — shrink text until under body cap.
      const only = out.messages[0];
      let budget = Math.min(HARNESS_SESSION_MAX_MSG_BYTES, utf8ByteLength(only.text));
      let best = '';
      while (budget > 0) {
        const candidate = truncateUtf8(only.text, budget);
        const trial: SessionSnapshot = {
          id: out.id,
          updatedAt: out.updatedAt,
          messages: [{ ...only, text: candidate }],
        };
        if (cloudBodyBytes(trial) <= HARNESS_SESSION_MAX_BODY_BYTES) {
          best = candidate;
          break;
        }
        budget = Math.floor(budget / 2);
      }
      out = {
        id: out.id,
        updatedAt: out.updatedAt,
        messages: [{ ...only, text: best }],
      };
      break;
    }
    out = {
      id: out.id,
      updatedAt: out.updatedAt,
      messages: out.messages.slice(1),
    };
  }

  return out;
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const j = (await res.json()) as { code?: string };
    return j.code;
  } catch {
    return undefined;
  }
}

export function createHttpSessionRepository(
  opts: HttpSessionRepositoryOptions = {},
): SessionRepository {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const path = opts.path ?? DEFAULT_PATH;
  let enabled = true;
  let inflight = false;
  let pending: SessionSnapshot | null = null;
  /** Bumped on remove() so in-flight PUTs cannot resurrect a cleared row. */
  let epoch = 0;

  function disable() {
    enabled = false;
    pending = null;
  }

  function liveLocal(fallback: SessionSnapshot): SessionSnapshot {
    return opts.getLocal?.() ?? fallback;
  }

  function maybeAdopt(server: SessionSnapshot, fallbackLocal: SessionSnapshot): boolean {
    if (!shouldAdoptServer(liveLocal(fallbackLocal), server)) return false;
    opts.onAdopt?.(server);
    return true;
  }

  async function deleteOnce(): Promise<void> {
    try {
      const res = await fetchImpl(path, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        disable();
        return;
      }
      if (res.status === 404) {
        const code = await readErrorCode(res);
        if (code === CLOUD_SESSION_DISABLED_CODE) {
          disable();
        }
      }
    } catch {
      /* ignore network */
    }
  }

  async function pull(local: SessionSnapshot): Promise<CloudPullResult> {
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
      if (res.status === 404) {
        const code = await readErrorCode(res);
        if (code === CLOUD_SESSION_DISABLED_CODE) {
          disable();
          return { action: 'disabled' };
        }
        // NOT_FOUND or bare 404 — empty cloud
        return { action: 'noop' };
      }
      if (!res.ok) {
        return {
          action: 'error',
          status: res.status,
          message: `Session pull failed (${res.status}).`,
        };
      }
      const parsed = parseCloudSessionSnapshot(await res.json());
      if (!parsed) {
        return { action: 'error', status: res.status, message: 'Invalid session body.' };
      }
      // Re-check live local after the round-trip so a concurrent turn is not wiped.
      if (maybeAdopt(parsed, local)) {
        return { action: 'adopt', snapshot: parsed };
      }
      return { action: 'noop' };
    } catch {
      return { action: 'error', status: 0, message: 'Network error pulling session.' };
    }
  }

  async function putOnce(
    snapshot: SessionSnapshot,
    putEpoch: number,
  ): Promise<CloudPushResult> {
    if (!enabled || putEpoch !== epoch) return { action: 'disabled' };
    const body = trimForCloudPut(snapshot);
    try {
      const res = await fetchImpl(path, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: body.id,
          updatedAt: body.updatedAt,
          messages: body.messages,
        }),
      });
      // Clear raced this PUT — server may have re-upserted; DELETE again.
      if (putEpoch !== epoch) {
        await deleteOnce();
        return { action: 'disabled' };
      }
      if (res.status === 401) {
        disable();
        return { action: 'disabled' };
      }
      if (res.status === 404) {
        const code = await readErrorCode(res);
        if (code === CLOUD_SESSION_DISABLED_CODE) {
          disable();
          return { action: 'disabled' };
        }
        return {
          action: 'error',
          status: 404,
          message: 'Session push failed (404).',
        };
      }
      if (res.status === 409) {
        const parsed = parseCloudSessionSnapshot(await res.json());
        if (putEpoch !== epoch) {
          await deleteOnce();
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
      const parsed = parseCloudSessionSnapshot(await res.json());
      if (putEpoch !== epoch) {
        await deleteOnce();
        return { action: 'disabled' };
      }
      return {
        action: 'ok',
        snapshot: parsed ?? body,
      };
    } catch {
      if (putEpoch !== epoch) {
        // Best-effort: PUT may have landed after clear.
        await deleteOnce();
      }
      return { action: 'error', status: 0, message: 'Network error pushing session.' };
    }
  }

  async function drainPush() {
    if (inflight) return;
    inflight = true;
    try {
      while (enabled && pending) {
        const next = pending;
        pending = null;
        const putEpoch = epoch;
        await putOnce(next, putEpoch);
      }
    } finally {
      inflight = false;
      if (enabled && pending) {
        void drainPush();
      }
    }
  }

  function schedulePush(snapshot: SessionSnapshot) {
    if (!enabled) return;
    pending = snapshot;
    void drainPush();
  }

  async function remove(): Promise<void> {
    if (!enabled) return;
    // Invalidate any in-flight PUT (epoch) and drop queued push so clear never
    // leaves a resurrected cloud row after DELETE.
    epoch += 1;
    pending = null;
    await deleteOnce();
  }

  return {
    get enabled() {
      return enabled;
    },
    pull,
    schedulePush,
    remove,
  };
}
