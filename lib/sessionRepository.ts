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
  HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES,
  HARNESS_SESSION_MAX_MSG_BYTES,
  isRedisSafeOpaqueId,
  normalizeSessionCwd,
  parseAttachedSkills,
  sanitizeModelId,
  sanitizeTurnRunId,
  sanitizeTurnStatus,
  sanitizeTurnStreamCursor,
  serializeAttachedSkills,
} from './sessionCloudCaps';
import type { SessionMessage, SessionRole, SessionSnapshot } from './sessionStore';
import {
  decodeUsageMetaString,
  encodeUsageMetaString,
} from './agent/usageSummary';

// Must stay in sync with the server-side role allowlist (`harnessSessions.ts`):
// a kind-7 `skill_attached` row rides the transcript the host PUTs after `/foo`,
// so the rollforward/envelope GET + 409-adopt parser must accept it or the whole
// record parses to `null` (session looks gone). Server + local already allow the
// role (`SessionRole`); this is the host-side contact surface (review #526 re-run 3).
const SESSION_ROLES = new Set<SessionRole>([
  'user',
  'assistant',
  'system',
  'error',
  'tool_run',
  'skill_attached',
]);

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
  /**
   * Phase 0 (#515) envelope carrier surface. When the server/Blob seam is available,
   * the host writes the small envelope (+ client→Blob upload) instead of the one-shot
   * full-record `put`; otherwise these roll forward to the full-record PUT/GET below.
   */

  /** Whether this host/repo is on the envelope+Blob carrier (vs full-record roll-forward). */
  readonly carrier: 'envelope' | 'rollforward';
  /** Mint a client→Blob upload URL for a new transcript segment. */
  mintUpload(id: string): Promise<
    | { action: 'ok'; uploadUrl: string; objectId: string }
    | { action: 'disabled' }
    | { action: 'error'; status: number; message: string }
  >;
  /** PUT a transcript body directly to the minted Blob URL (client→Blob, no Function). Resolves true on 2xx, false on failure/network error. */
  putTranscriptObject(uploadUrl: string, body: unknown): Promise<boolean>;
  /** Upsert the small envelope (meta/pointer + `updatedAt` LWW) for a session. */
  pushEnvelope(
    id: string,
    env: { updatedAt: number; pointer?: string; meta?: Record<string, unknown> },
  ): Promise<
    | { action: 'ok' }
    | { action: 'adopt'; envelope: unknown }
    | { action: 'disabled' }
    | { action: 'error'; status: number; message: string }
  >;
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
  /**
   * Explicitly select the phase-0 carrier. When omitted, the public
   * `NEXT_PUBLIC_HARNESS_CARRIER_ENVELOPE=1` flag opts the envelope+Blob carrier
   * in; otherwise it rolls forward to the one-shot full-record PUT/GET (today's
   * default). Exposed so tests can exercise the envelope path deterministically.
   */
  carrier?: 'envelope' | 'rollforward';
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
  let personaId: string | undefined;
  let selectedModel: string | undefined;
  let turnRunId: string | undefined;
  let turnStatus: import('./sessionCloudCaps').TurnStatus | undefined;
  let turnStreamCursor: number | undefined;
  if (o.meta !== null && typeof o.meta === 'object' && !Array.isArray(o.meta)) {
    const meta = o.meta as Record<string, unknown>;
    cwd = normalizeSessionCwd(meta.logicalCwd);
    const sandbox = meta.activeSandboxId;
    if (typeof sandbox === 'string' && sandbox && isRedisSafeOpaqueId(sandbox)) {
      activeSandboxId = sandbox;
    }
    // Phase 3 (#488): restore the bound persona from the reserved meta key so a
    // device-switch/reload rebuilds the local session's chosen persona before the
    // snapshot (meta.personaSnapshot) is used by the route.
    const pid = meta.personaId;
    if (typeof pid === 'string' && pid && isRedisSafeOpaqueId(pid)) {
      personaId = pid;
    }
    // Plan #616 (source #610): restore the selected model id from the reserved
    // `meta.selectedModel` so a reload / device-switch / adopt rebuilds the
    // session's pick by id. `sanitizeModelId` drops a poisoned / invalid value
    // to unset (restore falls back to the default first-granted model).
    selectedModel = sanitizeModelId(meta.selectedModel);
    // backend-agents A1–A3: restore the three turn carriers from the reserved meta
    // keys through the shared client-safe predicates so a poisoned / side-channel
    // value drops to unset instead of becoming a sticky 400. `turnStatus='completed'`
    // is a first-class terminal member (`sanitizeTurnStatus` preserves it) so C15's
    // 409 stays live-only; `turnStreamCursor=0` is a valid value (`0` preserved).
    turnRunId = sanitizeTurnRunId(meta.turnRunId);
    turnStatus = sanitizeTurnStatus(meta.turnStatus);
    turnStreamCursor = sanitizeTurnStreamCursor(meta.turnStreamCursor);
  }
  const snapshot: SessionSnapshot = {
    id: o.id,
    updatedAt: o.updatedAt,
    messages,
  };
  if (cwd !== undefined) snapshot.cwd = cwd;
  if (activeSandboxId !== undefined) snapshot.activeSandboxId = activeSandboxId;
  if (personaId !== undefined) snapshot.personaId = personaId;
  if (selectedModel !== undefined) snapshot.selectedModel = selectedModel;
  if (turnRunId !== undefined) snapshot.turnRunId = turnRunId;
  if (turnStatus !== undefined) snapshot.turnStatus = turnStatus;
  if (turnStreamCursor !== undefined) snapshot.turnStreamCursor = turnStreamCursor;
  // Phase 2 (#517): restore the sticky attached-skill set from the reserved
  // `meta.attachedSkills` JSON-array string (fail-closed → [] on any malformed /
  // foreign value; never a sticky poison). `[]` restore means detach-all.
  if (o.meta !== null && typeof o.meta === 'object' && !Array.isArray(o.meta)) {
    const meta = o.meta as Record<string, unknown>;
    if (meta.attachedSkills !== undefined) {
      snapshot.attachedSlugs = parseAttachedSkills(meta.attachedSkills);
    }
    const usage = decodeUsageMetaString(meta.usage);
    if (usage !== undefined) snapshot.usage = usage;
  }
  return snapshot;
}

/**
 * Overlay envelope `meta` onto a parsed transcript snapshot.
 *
 * Same reserved-meta write contract as PUT (`RESERVED_META_KEYS`): the envelope
 * is the last full desired set. A valid envelope value wins; absent or poison
 * **clears** the transcript field. Mid-turn server writers must copy-forward
 * existing meta so a one-key update cannot clear siblings.
 */
export function overlayEnvelopeMeta(
  snapshot: SessionSnapshot,
  envMeta: Record<string, unknown> | undefined,
): SessionSnapshot {
  if (!envMeta || typeof envMeta !== 'object' || Array.isArray(envMeta)) {
    return snapshot;
  }
  const out: SessionSnapshot = { ...snapshot };

  const sandbox = envMeta.activeSandboxId;
  if (typeof sandbox === 'string' && sandbox && isRedisSafeOpaqueId(sandbox)) {
    out.activeSandboxId = sandbox;
  } else {
    delete out.activeSandboxId;
  }

  const cwd = normalizeSessionCwd(envMeta.logicalCwd);
  if (cwd !== undefined) out.cwd = cwd;
  else delete out.cwd;

  const usage = decodeUsageMetaString(envMeta.usage);
  if (usage !== undefined) out.usage = usage;
  else delete out.usage;

  const selectedModel = sanitizeModelId(envMeta.selectedModel);
  if (selectedModel !== undefined) out.selectedModel = selectedModel;
  else delete out.selectedModel;

  if (envMeta.attachedSkills !== undefined) {
    out.attachedSlugs = parseAttachedSkills(envMeta.attachedSkills);
  } else {
    delete out.attachedSlugs;
  }

  const pid = envMeta.personaId;
  if (typeof pid === 'string' && pid && isRedisSafeOpaqueId(pid)) {
    out.personaId = pid;
  } else {
    delete out.personaId;
  }

  // backend-agents A1–A3: overlay the three turn carriers from the envelope meta.
  // Same reserved-meta replace contract as PUT/GET: a valid value wins; **absent or
  // poison clears** the transcript field. `completed` is preserved (first-class
  // terminal, so C15's 409 stays live-only); `turnStreamCursor=0` is preserved.
  const turnRunId = sanitizeTurnRunId(envMeta.turnRunId);
  if (turnRunId !== undefined) out.turnRunId = turnRunId;
  else delete out.turnRunId;

  const turnStatus = sanitizeTurnStatus(envMeta.turnStatus);
  if (turnStatus !== undefined) out.turnStatus = turnStatus;
  else delete out.turnStatus;

  const turnStreamCursor = sanitizeTurnStreamCursor(envMeta.turnStreamCursor);
  if (turnStreamCursor !== undefined) out.turnStreamCursor = turnStreamCursor;
  else delete out.turnStreamCursor;

  return out;
}

/**
 * Merge `usage` on same-id adopt so a server snapshot without `meta.usage`
 * (other tab on a pre-#626 bundle, or any prior persist that omitted usage)
 * does not wipe an honest local last-completed value.
 *
 * - Same id: `server.usage ?? local.usage` — server wins when it has one.
 * - Different id: server-only (a switch is a different session).
 */
export function mergeAdoptedUsage(
  server: SessionSnapshot,
  local: SessionSnapshot,
): SessionSnapshot {
  if (server.id === local.id) {
    return { ...server, usage: server.usage ?? local.usage };
  }
  return server;
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
  meta?: {
    activeSandboxId?: string;
    logicalCwd?: string;
    personaId?: string;
    /**
     * Phase 2 (#517): the session-sticky attached-skill set as a JSON-array
     * string of slugs (the server's reserved `meta.attachedSkills` surface).
     * Absent = clear (RESERVED_META_KEYS replace contract); `'[]'` = explicit
     * detach-all value. Folded from `snapshot.attachedSlugs`.
     */
    attachedSkills?: string;
    /**
     * Plan #616 (source #610): the selected model id (non-secret printable-ASCII
     * catalog string). Folded from `snapshot.selectedModel` via `sanitizeModelId`
     * (drop-to-unset on invalid). Absent = clear (no model pick carried).
     */
    selectedModel?: string;
    /**
     * backend-agents A1 (#795): the Workflow run id, folded from
     * `snapshot.turnRunId` via `sanitizeTurnRunId`. Absent = clear.
     */
    turnRunId?: string;
    /**
     * backend-agents A2 (#796): the turn-status enum, folded from
     * `snapshot.turnStatus` via `sanitizeTurnStatus`. Absent = clear. `completed`
     * is a first-class terminal member (preserved).
     */
    turnStatus?: string;
    /**
     * backend-agents A3 (#797): the attach/replay stream cursor, folded from
     * `snapshot.turnStreamCursor` via `sanitizeTurnStreamCursor`. Absent = clear.
     */
    turnStreamCursor?: number;
    /**
     * Last-completed provider usage as a JSON string of a sanitized
     * UsageSummary. Absent = clear (hide the context slot).
     */
    usage?: string;
  };
};

/**
 * Fold the session-carrier fields into the reserved `meta` for the cloud PUT
 * (P1/GAP-1, #452): `logicalCwd` from `snapshot.cwd`, `activeSandboxId` from
 * `snapshot.activeSandboxId`. The cwd is run through `normalizeSessionCwd` (the
 * same form sent to `/api/agent`) so the persisted `meta.logicalCwd` is ALWAYS a
 * form the request path accepts on any device — a P1-legal-but-escaping `..`
 * cannot round-trip into Redis (review #453 residual).
 *
 * Reserved-meta write contract (`RESERVED_META_KEYS`): this object is the
 * **full desired set**. A key left off is a **clear**, not a hole. Returns
 * `undefined` when every carrier is unset (empty desired set).
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
  // Phase 3 (#488): the bound persona rides the PUT meta (reserved key) so the
  // cloud record retains `meta.personaId` alongside the server-set snapshot —
  // reload/device-switch rebuild the local binding. Never the body text.
  const pid =
    typeof snapshot.personaId === 'string' &&
    snapshot.personaId &&
    isRedisSafeOpaqueId(snapshot.personaId)
      ? snapshot.personaId
      : undefined;
  if (pid !== undefined) meta.personaId = pid;
  // attachedSkills: fold the known set on every PUT. Omit = clear at the store
  // (RESERVED_META_KEYS contract). `[]` is the empty-set value. `attachedSlugs`
  // undefined (never loaded) still omits — that host hole is a store clear.
  // Never persist a malformed value — re-serialize the validated parse.
  const attachedSkills = Array.isArray(snapshot.attachedSlugs)
    ? serializeAttachedSkills(snapshot.attachedSlugs)
    : undefined;
  if (attachedSkills !== undefined) meta.attachedSkills = attachedSkills;
  // Plan #616 (source #610): the selected model id rides the reserved
  // `meta.selectedModel` so the cloud record retains the pick across reload /
  // device-switch. Sanitized via the shared client-safe predicate (drop-to-unset
  // on invalid — never a sticky 400). Absent = clear.
  const selectedModel = snapshot.selectedModel
    ? sanitizeModelId(snapshot.selectedModel)
    : undefined;
  if (selectedModel !== undefined) meta.selectedModel = selectedModel;
  // backend-agents A1–A3: fold the three turn carriers from the snapshot through
  // the shared client-safe predicates (drop-to-unset on poison — never a sticky
  // 400; absent = clear, RESERVED_META_KEYS replace contract). `completed` is a
  // first-class terminal member (preserved via `sanitizeTurnStatus`); `turnStreamCursor=0`
  // is a valid value (preserved).
  const turnRunId = sanitizeTurnRunId(snapshot.turnRunId);
  if (turnRunId !== undefined) meta.turnRunId = turnRunId;
  const turnStatus = sanitizeTurnStatus(snapshot.turnStatus);
  if (turnStatus !== undefined) meta.turnStatus = turnStatus;
  const turnStreamCursor = sanitizeTurnStreamCursor(snapshot.turnStreamCursor);
  if (turnStreamCursor !== undefined) meta.turnStreamCursor = turnStreamCursor;
  const usage = encodeUsageMetaString(snapshot.usage);
  if (usage !== undefined) meta.usage = usage;
  return meta.logicalCwd === undefined &&
    meta.activeSandboxId === undefined &&
    meta.personaId === undefined &&
    meta.attachedSkills === undefined &&
    meta.selectedModel === undefined &&
    meta.turnRunId === undefined &&
    meta.turnStatus === undefined &&
    meta.turnStreamCursor === undefined &&
    meta.usage === undefined
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
 *
 * `maxBytes` selects the wire surface:
 * - Default (`HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES`, 2 MiB) — the **rollforward**
 *   one-shot full-record PUT to `/api/sessions/:id`, which crosses a Vercel Function
 *   and so must stay well under the 4.5 MB payload ceiling (#512/#514 lock: a raised
 *   cap must never re-enable one-shot Function-carried writes).
 * - Pass `HARNESS_SESSION_MAX_BODY_BYTES` (8 MiB object ceiling) on the phase-0
 *   #515 envelope/Blob path, where the transcript object is ferried **client→Blob**
 *   and never through a Function body.
 */
export function trimForCloudPut(
  snapshot: SessionSnapshot,
  maxBytes: number = HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES,
): CloudPutBody {
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

  while (out.messages.length > 0 && cloudBodyBytes(out) > maxBytes) {
    if (out.messages.length === 1) {
      // Single message still too large — shrink text until under body cap.
      const only = out.messages[0];
      let budget = Math.min(HARNESS_SESSION_MAX_MSG_BYTES, utf8ByteLength(only.text));
      let best = '';
      while (budget > 0) {
        const candidate = truncateUtf8(only.text, budget);
        if (cloudBodyBytes(fresh([{ ...only, text: candidate }])) <= maxBytes) {
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

  /**
   * Phase 0 (#515) envelope read: `GET /envelope` then page the transcript object
   * (client→Blob) instead of a whole-record Function GET. Used when the envelope
   * carrier is active; the transcript object stores the same `{ id, updatedAt,
   * messages, meta? }` shape the full-record GET returns so `parseCloudSessionSnapshot`
   * reconstructs the same `SessionSnapshot`.
   */
  async function getEnvelope(id: string): Promise<CloudGetResult> {
    try {
      const res = await fetchImpl(`${path}/${encodeURIComponent(id)}/envelope`, {
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
      const env = (await res.json()) as { transcriptReadUrl?: unknown; meta?: Record<string, unknown> };
      const readUrl = typeof env.transcriptReadUrl === 'string' ? env.transcriptReadUrl : undefined;
      const pointer =
        env.meta && typeof env.meta.transcriptPointer === 'string'
          ? env.meta.transcriptPointer
          : undefined;
      if (!readUrl || !pointer) {
        // Envelope present but no transcript object yet (fresh/empty session).
        return { action: 'notfound' };
      }
      const t = await fetchImpl(readUrl, { method: 'GET', credentials: 'omit' });
      if (t.status === 401) {
        // A 401 here is from the Blob object host (cross-origin, `credentials:'omit'`),
        // e.g. a stale/expired signed URL or a Blob auth blip — NOT an Auth.js session
        // sign-out. Disabling the whole repo on this would silently turn off every
        // cloud read/write for the page load, so we treat it as a transient error and
        // keep the repo enabled (reader's Minor L1).
        return {
          action: 'error',
          status: t.status,
          message: 'Transcript fetch denied (signed URL expired or object non-existent).',
        };
      }
      if (!t.ok) {
        return {
          action: 'error',
          status: t.status,
          message: `Transcript fetch failed (${t.status}).`,
        };
      }
      const parsed = parseCloudSessionSnapshot(await t.json(), id);
      if (!parsed) {
        return { action: 'error', status: 0, message: 'Invalid transcript body.' };
      }
      return {
        action: 'ok',
        snapshot: overlayEnvelopeMeta(parsed, env.meta),
      };
    } catch {
      return { action: 'error', status: 0, message: 'Network error pulling session.' };
    }
  }

  async function get(id: string): Promise<CloudGetResult> {
    if (!enabled) return { action: 'disabled' };
    if (carrier === 'envelope') return getEnvelope(id);
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

  /**
   * Phase 0 (#515) envelope carrier writer: mint → client→Blob PUT of the transcript
   * object (no full-document JSON PUT through a Function) → push the small envelope
   * with the object's `transcriptPointer`. **Fail-closed:** if the object upload
   * fails (non-2xx / network), the envelope pointer is NOT advanced — a later restore
   * can never land on a missing/empty object hole (reader's Minor L1). The transcript
   * object stores the same `{ id, updatedAt, messages, meta? }` shape the full-record
   * PUT sends, so the envelope read (`getEnvelope`) reconstructs the identical
   * `SessionSnapshot`.
   */
  async function putEnvelopeOnce(
    id: string,
    snapshot: SessionSnapshot,
    scheduledEpoch: number,
    c: Channel,
  ): Promise<CloudPutResult> {
    if (!enabled || snapshot.id !== id) return { action: 'disabled' };
    // The transcript object is ferried client→Blob (never through a Function), so it
    // is trimmed to the 8 MiB **object** ceiling (`HARNESS_SESSION_MAX_BODY_BYTES`) —
    // the generous #514 body cap is legal HERE (Blob object), not on a Function body.
    const body = trimForCloudPut(snapshot, HARNESS_SESSION_MAX_BODY_BYTES);

    const mint = await mintUpload(id);
    if (c.epoch !== scheduledEpoch) {
      await deleteOne(id);
      return { action: 'disabled' };
    }
    if (mint.action === 'disabled') return { action: 'disabled' };
    if (mint.action !== 'ok') {
      return { action: 'error', status: mint.status, message: mint.message };
    }

    const uploaded = await putTranscriptObject(mint.uploadUrl, body);
    if (c.epoch !== scheduledEpoch) {
      await deleteOne(id);
      return { action: 'disabled' };
    }
    if (!uploaded) {
      return {
        action: 'error',
        status: 0,
        message: 'Transcript upload failed; envelope pointer not advanced.',
      };
    }

    const pushed = await pushEnvelope(id, {
      updatedAt: snapshot.updatedAt,
      pointer: mint.objectId,
      meta: body.meta,
    });
    if (c.epoch !== scheduledEpoch) {
      await deleteOne(id);
      return { action: 'disabled' };
    }
    if (pushed.action === 'disabled') return { action: 'disabled' };
    if (pushed.action !== 'ok' && pushed.action !== 'adopt') {
      return { action: 'error', status: pushed.status, message: pushed.message };
    }
    return { action: 'ok', snapshot };
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
        // The carrier flag actually switches the write path (reader's Major L1):
        // 'envelope' → mint → client→Blob → pushEnvelope; 'rollforward' → the
        // one-shot full-record PUT (today's default, behavior-identical).
        if (carrier === 'envelope') {
          await putEnvelopeOnce(id, next, scheduledEpoch, c);
        } else {
          await putOnce(id, next, scheduledEpoch, c);
        }
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

  // Phase 0 (#515) envelope carrier. This module is client-safe (no Node env), so the
  // host toggles the carrier via a PUBLIC `NEXT_PUBLIC_HARNESS_CARRIER_ENVELOPE` flag.
  // The server's `BLOB_READ_WRITE_TOKEN` is never read client-side. Default roll-forward
  // keeps the existing one-shot full-record PUT until a deploy opts the envelope carrier in.
  // The flag only takes effect when it actually swaps the write/read path (put/get
  // dispatch on `carrier` below) — a no-op getter alone was reader's Major L1.
  const carrier: 'envelope' | 'rollforward' =
    opts.carrier ??
    (typeof process !== 'undefined' &&
    process.env.NEXT_PUBLIC_HARNESS_CARRIER_ENVELOPE === '1'
      ? 'envelope'
      : 'rollforward');

  async function mintUpload(id: string) {
    if (!enabled) return { action: 'disabled' as const };
    try {
      const res = await fetchImpl(`${path}/${encodeURIComponent(id)}/transcript`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.status === 401) {
        disable();
        return { action: 'disabled' as const };
      }
      if (!res.ok) {
        return {
          action: 'error' as const,
          status: res.status,
          message: `Transcript mint failed (${res.status}).`,
        };
      }
      const body = (await res.json()) as { uploadUrl?: unknown; objectId?: unknown };
      if (
        typeof body.uploadUrl !== 'string' ||
        !body.uploadUrl ||
        typeof body.objectId !== 'string' ||
        !body.objectId
      ) {
        return { action: 'error' as const, status: res.status, message: 'Invalid mint body.' };
      }
      return { action: 'ok' as const, uploadUrl: body.uploadUrl, objectId: body.objectId };
    } catch {
      return { action: 'error' as const, status: 0, message: 'Network error minting transcript.' };
    }
  }

  /**
   * PUT a transcript body directly to a minted Blob URL (client→Blob, no Function).
   * Returns **true only on a successful (2xx) upload**. On failure it returns false
   * so the envelope carrier does NOT advance `transcriptPointer` to a missing/empty
   * object — fail-closed on the one write that matters (host adopt would otherwise
   * restore a hole; reader's Minor L1).
   */
  async function putTranscriptObject(uploadUrl: string, body: unknown): Promise<boolean> {
    try {
      const res = await fetchImpl(uploadUrl, {
        method: 'PUT',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async function pushEnvelope(
    id: string,
    env: { updatedAt: number; pointer?: string; meta?: Record<string, unknown> },
  ) {
    if (!enabled) return { action: 'disabled' as const };
    const meta: Record<string, unknown> = { ...env.meta };
    if (env.pointer) meta.transcriptPointer = env.pointer;
    const body = { id, updatedAt: env.updatedAt, meta };
    try {
      const res = await fetchImpl(`${path}/${encodeURIComponent(id)}/envelope`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        disable();
        return { action: 'disabled' as const };
      }
      if (res.status === 409) {
        return { action: 'adopt' as const, envelope: await res.json() };
      }
      if (!res.ok) {
        return {
          action: 'error' as const,
          status: res.status,
          message: `Envelope push failed (${res.status}).`,
        };
      }
      await res.json();
      return { action: 'ok' as const };
    } catch {
      return { action: 'error' as const, status: 0, message: 'Network error pushing envelope.' };
    }
  }

  return {
    get enabled() {
      return enabled;
    },
    get carrier() {
      return carrier;
    },
    get,
    put,
    list,
    create,
    createFirst,
    remove,
    mintUpload,
    putTranscriptObject,
    pushEnvelope,
  };
}
