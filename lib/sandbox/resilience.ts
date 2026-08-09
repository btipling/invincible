/**
 * Shared transient-error resilience for Vercel Sandbox SDK calls (FS tools +
 * hop-B HTTP runner). Server-only; never imported by client/Wasm.
 *
 * The @vercel/sandbox SDK already re-resumes / re-runs stopped / stopping /
 * snapshotting sandboxes internally (`Sandbox.withResume` — any 410,
 * 422 `sandbox_stopping`, 422 `sandbox_snapshotting`). App-level retries must
 * NOT double that work or amplify the platform's own stop/recovery. This module
 * therefore provides a *single* classifier that:
 *
 *   - passes the SDK-owned stopped / stopping / snapshotting family through
 *     untouched (no app retry, no backoff sleep),
 *   - retries bounded times on transient readiness / boot windows
 *     (image-not-ready races, 408/429/5xx, "preparing / not ready"),
 *   - fails fast (zero retries, zero sleep) on permanent config / auth / path /
 *     bad-image errors so a misconfigured sandbox never busy-loops.
 *
 * Both durable-backend call sites (lib/sandbox/vercelClient.ts and
 * lib/agent/vercelSandboxHttpRunner.ts) share this seam. The BYO HTTP daemon
 * backend is intentionally untouched.
 */

import { SandboxHttpError } from './types';
import { WorkPathError } from '../agent/workPath';

/**
 * How often a per-call `extendTimeout` heartbeat is allowed (throttle window
 * in ms). Default 5 minutes matches the 30m idle family with ample headroom so
 * a long multi-step turn never idles out from a forgotten mid-turn extend,
 * while staying far below the idle timeout. Injectable so tests can drive the
 * throttle with a fake clock.
 */
export const EXTEND_THROTTLE_MS = 300_000;

export type VercelErrorClass =
  | { kind: 'retryable'; status?: number; code?: string }
  | { kind: 'pass_through'; status?: number; code?: string }
  | { kind: 'permanent'; status?: number; code?: string };

/** HTTP statuses the SDK surfaces as readiness/control-plane flakiness we may retry. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Machine codes ⇒ "still booting / preparing" — safe to retry. */
const RETRYABLE_CODES = new Set([
  'image_not_ready',
  'image-not-ready',
  'not_ready',
  'not-ready',
  'sandbox_not_ready',
  'sandbox-not-ready',
  'sandbox_booting',
  'sandbox-booting',
  'preparing',
]);

/** Code families the SDK owns via `withResume` — never app-retried. */
const PASS_THROUGH_CODES = new Set(['sandbox_stopping', 'sandbox_snapshotting']);

/** Message fallback (only when no machine code) for the narrow readiness set. */
const RETRYABLE_MESSAGE_PHRASES = [
  'not ready',
  'not_ready',
  'image not ready',
  'image_not_ready',
  'image-not-ready',
  'sandbox_not_ready',
  'sandbox-not-ready',
  'sandbox_booting',
  'sandbox-booting',
  'is preparing',
  'preparing',
  'still booting',
];

/** Permanent bad-image config — never becomes ready; never retried. */
const PERMANENT_BAD_IMAGE_PHRASES = [
  'unknown image',
  'invalid image',
  'image not found',
  'image is not',
  'unoptimized',
  'unsupported architecture',
  'linux/amd64',
];

const PERMANENT_AUTH_PHRASES = ['unauthorized', 'forbidden', 'not authenticated'];

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Duck-typed @vercel/sandbox `APIError` (`{ response, json?.error?.code }`). */
function asAPIError(
  err: unknown,
): { status?: number; code?: string; message?: string } | null {
  if (err && typeof err === 'object' && 'response' in err) {
    const res = (err as { response?: { status?: unknown } }).response;
    const status =
      res && typeof res.status === 'number' ? res.status : undefined;
    const code = (err as { json?: { error?: { code?: unknown } } }).json?.error
      ?.code;
    return {
      status,
      code: typeof code === 'string' ? code : undefined,
      message: err instanceof Error ? err.message : undefined,
    };
  }
  return null;
}

/** Duck-typed `StreamError` (`{ code }`, no `response`). */
function asStreamError(err: unknown): { code?: string } | null {
  if (err && typeof err === 'object' && 'code' in err && !('response' in err)) {
    const code = (err as { code?: unknown }).code;
    return { code: typeof code === 'string' ? code : undefined };
  }
  return null;
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
}

/**
 * Map an arbitrary thrown value to a bounded transient class.
 *
 * Order matters:
 *  1. Abort / timeout → permanent 504 (never sleep, never retry).
 *  2. Already-mapped domain errors → permanent as authored.
 *  3. APIError → status/code first, narrow message fallback, fail closed.
 *  4. StreamError → code first, else permanent.
 *  5. Plain error → narrow message fallback, fail closed.
 */
export function classifyVercelError(err: unknown): VercelErrorClass {
  if (isAbortError(err)) {
    return { kind: 'permanent', status: 504 };
  }
  if (err instanceof SandboxHttpError) {
    return { kind: 'permanent', status: err.status };
  }
  if (err instanceof WorkPathError) {
    return { kind: 'permanent', status: 400 };
  }

  const api = asAPIError(err);
  if (api) {
    const { status, code } = api;

    // SDK owns stopped / stopping / snapshotting resume — pass through.
    if (status === 410) {
      return { kind: 'pass_through', status, code };
    }
    if (
      status === 422 &&
      code &&
      (code === 'sandbox_stopping' || code === 'sandbox_snapshotting')
    ) {
      return { kind: 'pass_through', status, code };
    }

    // Explicit readiness codes even when wrapped in a 400/409/422.
    if (code && RETRYABLE_CODES.has(code)) {
      return { kind: 'retryable', status, code };
    }
    // HTTP-level transient flakiness.
    if (status !== undefined && RETRYABLE_STATUS.has(status)) {
      return { kind: 'retryable', status, code };
    }
    // Permanent status families.
    if (status === 403 || status === 404 || status === 413) {
      return { kind: 'permanent', status, code };
    }

    const msg = api.message ? api.message.toLowerCase() : '';
    if (PERMANENT_BAD_IMAGE_PHRASES.some((p) => msg.includes(p))) {
      return { kind: 'permanent', status: status ?? 400 };
    }
    if (RETRYABLE_MESSAGE_PHRASES.some((p) => msg.includes(p))) {
      return { kind: 'retryable', status, code };
    }
    if (PERMANENT_AUTH_PHRASES.some((p) => msg.includes(p))) {
      return { kind: 'permanent', status: status ?? 403 };
    }
    // Unknown API error — fail closed (conservative, no retry).
    return { kind: 'permanent', status: status ?? 502 };
  }

  const stream = asStreamError(err);
  if (stream) {
    if (stream.code && RETRYABLE_CODES.has(stream.code)) {
      return { kind: 'retryable', status: undefined, code: stream.code };
    }
    return { kind: 'permanent', status: undefined, code: stream.code };
  }

  const msg = messageOf(err);
  if (PERMANENT_BAD_IMAGE_PHRASES.some((p) => msg.includes(p))) {
    return { kind: 'permanent', status: 400 };
  }
  if (RETRYABLE_MESSAGE_PHRASES.some((p) => msg.includes(p))) {
    return { kind: 'retryable' };
  }
  if (PERMANENT_AUTH_PHRASES.some((p) => msg.includes(p))) {
    return { kind: 'permanent', status: 403 };
  }
  if (msg.includes('not found') || msg.includes('enoent')) {
    return { kind: 'permanent', status: 404 };
  }
  if (msg.includes('too large') || msg.includes('exceeds')) {
    return { kind: 'permanent', status: 413 };
  }
  return { kind: 'permanent', status: undefined };
}

function abortedError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/** Abort-aware sleep: rejects immediately if `signal` fires while backing off. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(abortedError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type TransientRetryOptions = {
  /** Max retries after the first attempt (default 4 → up to 5 attempts). */
  retries?: number;
  /** Base backoff ms (doubles each attempt). */
  baseMs?: number;
  /** Hard cap for any single backoff (ms). */
  capMs?: number;
  /** Jitter upper bound (ms). Tests pass `0` for deterministic fake timers. */
  jitterMs?: number;
  /** Turn-stop / client-abort signal; cancels backoff immediately. */
  signal?: AbortSignal;
  /** Called after the last retryable attempt failed (e.g. invalidate latch). */
  onExhaustedRetryable?: (err: unknown) => void;
};

/**
 * Run `fn`, retrying only on `retryable`-classified errors with bounded
 * exponential backoff. Permanent / SDK-owned (`pass_through`) errors and
 * aborts never retry and never sleep.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: TransientRetryOptions = {},
): Promise<T> {
  const {
    retries = 4,
    baseMs = 250,
    capMs = 4000,
    jitterMs = baseMs,
    signal,
    onExhaustedRetryable,
  } = opts;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw abortedError();
    try {
      return await fn();
    } catch (err) {
      const cls = classifyVercelError(err);
      if (cls.kind !== 'retryable') {
        // Permanent, or SDK-owned pass_through — never app-retry.
        throw err;
      }
      if (attempt >= retries) {
        onExhaustedRetryable?.(err);
        throw err;
      }
      const delay = Math.min(
        baseMs * 2 ** attempt +
          (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0),
        capMs,
      );
      await sleep(delay, signal);
    }
  }
  // Unreachable: the loop returns or throws on every path.
  throw abortedError();
}

/**
 * Tool-visible HTTP status for a surfaced Vercel SDK error.
 * - exhausted/retryable or SDK-owned pass_through → 502 (platform not ready)
 * - abort/timeout → 504 (classifier marks permanent 504)
 * - permanent → its own status (fallback otherwise)
 */
export function statusFromClassified(
  err: unknown,
  fallbackStatus = 502,
): number {
  const cls = classifyVercelError(err);
  switch (cls.kind) {
    case 'retryable':
      return 502;
    case 'pass_through':
      return 502;
    case 'permanent':
      return cls.status ?? fallbackStatus;
  }
}
