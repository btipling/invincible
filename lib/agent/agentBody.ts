/**
 * Agent-only request body parse. Chat stays on parseChatBody (no cwd).
 */
import { parseChatBody } from '../chatServer';
import { isRedisSafeOpaqueId, sanitizeReasoningEffort } from '../sessionCloudCaps';
import { parseInitialCwd } from './workPath';

export type ParsedAgentBody =
  | {
      ok: true;
      prompt: string;
      modelId?: string;
      cwd: string;
      /** Optional session-owned active sandbox id (server-resolved override). */
      sandboxId?: string;
      /** Optional persona id (Redis-safe opaque; Phase 3 resolves body by id). */
      personaId?: string;
      /**
       * Optional session id (Redis-safe opaque). Parent #485 lock, phase 3 #488:
       * the ONLY seam for the agent route to find a session's `meta.personaSnapshot`
       * and push the snapshot back for later turns / Continue. Absent/foreign →
       * no inject (fail closed, no existence leak).
       */
      sessionId?: string;
      /**
       * Optional reasoning-effort token (plan #897). Omit/null/whitespace →
       * unset (server default). Present invalid → 400.
       */
      reasoning?: string;
    }
  | { ok: false; error: string; status: number };

/**
 * Parse POST /api/agent body: { prompt, modelId?, cwd? }.
 * - Body omits `cwd` (or null) → `'.'` (workspace-root default; env ignored —
 *   there is no host-wide `SANDBOX_DEFAULT_CWD`). Session controls cwd (#452).
 * - Body provides `cwd` → `parseInitialCwd` (host-absolute / invalid → 400).
 */
export function parseAgentBody(
  body: unknown,
  _env: Record<string, string | undefined> = process.env,
): ParsedAgentBody {
  const base = parseChatBody(body);
  if (!base.ok) {
    return base;
  }

  const obj =
    body != null && typeof body === 'object'
      ? (body as {
          cwd?: unknown;
          sandboxId?: unknown;
          personaId?: unknown;
          sessionId?: unknown;
          reasoning?: unknown;
        })
      : {};

  const sandboxId = parseSandboxId(obj.sandboxId);
  if (!sandboxId.ok) {
    return sandboxId;
  }
  const personaId = parsePersonaId(obj.personaId);
  if (!personaId.ok) {
    return personaId;
  }
  const sessionId = parseSessionId(obj.sessionId);
  if (!sessionId.ok) {
    return sessionId;
  }
  const reasoning = parseReasoning(obj.reasoning);
  if (!reasoning.ok) {
    return reasoning;
  }

  const extra = {
    ...(sandboxId.value !== undefined ? { sandboxId: sandboxId.value } : {}),
    ...(personaId.value !== undefined ? { personaId: personaId.value } : {}),
    ...(sessionId.value !== undefined ? { sessionId: sessionId.value } : {}),
    ...(reasoning.value !== undefined ? { reasoning: reasoning.value } : {}),
  };

  // Omit / null → '.' always. Distinguish from present invalid (400) or empty (→ ".").
  if (!('cwd' in obj) || obj.cwd === undefined || obj.cwd === null) {
    return {
      ok: true,
      prompt: base.prompt,
      modelId: base.modelId,
      cwd: '.',
      ...extra,
    };
  }

  const cwdParsed = parseInitialCwd(obj.cwd);
  if (!cwdParsed.ok) {
    return { ok: false, status: 400, error: cwdParsed.error };
  }

  return {
    ok: true,
    prompt: base.prompt,
    modelId: base.modelId,
    cwd: cwdParsed.cwd,
    ...extra,
  };
}

/**
 * Parse the optional `sandboxId` override. Omit/null → no override (undefined);
 * a present non-Redis-safe value → 400 (fail closed). The id is session-owned (a
 * sandbox row id, Redis-safe, mirrored from the session-carrier validation).
 */
function parseSandboxId(
  raw: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: string; status: 400 } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (isRedisSafeOpaqueId(raw)) {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    error: 'sandboxId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    status: 400,
  };
}

/**
 * Parse the optional `sessionId`. Omit/null → no override (undefined); a present
 * non-Redis-safe value → 400 (fail closed). Same Redis-safe opaque rule as
 * `sandboxId`/`personaId`/session meta keys; Phase 3 reads the session's
 * `meta.personaSnapshot` through it. Unknown/foreign sessions fail closed at the
 * store (never an existence leak).
 */
function parseSessionId(
  raw: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: string; status: 400 } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (isRedisSafeOpaqueId(raw)) {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    error: 'sessionId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    status: 400,
  };
}

/**
 * Parse the optional `personaId`. Omit/null → no override (undefined); a present
 * non-Redis-safe value → 400 (fail closed). Same Redis-safe opaque rule as
 * `sandboxId`/session meta; Phase 3 resolves the body by id, unknown/other-user
 * ids fail closed at the store (never an existence leak).
 */
function parsePersonaId(
  raw: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: string; status: 400 } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (isRedisSafeOpaqueId(raw)) {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    error: 'personaId must be a Redis-safe opaque id (^[A-Za-z0-9_-]{1,512}$).',
    status: 400,
  };
}

/**
 * Parse optional `reasoning`. Omit/null/whitespace → unset (server default).
 * Present invalid charset/length → 400.
 */
function parseReasoning(
  raw: unknown,
): { ok: true; value: string | undefined } | { ok: false; error: string; status: 400 } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    return { ok: true, value: undefined };
  }
  const cleaned = sanitizeReasoningEffort(raw);
  if (cleaned !== undefined) {
    return { ok: true, value: cleaned };
  }
  return {
    ok: false,
    error: 'reasoning must be a lowercase effort token (^[a-z0-9_-]{1,32}$).',
    status: 400,
  };
}

