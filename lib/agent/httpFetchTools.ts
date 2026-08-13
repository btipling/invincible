import { jsonSchema, tool } from 'ai';
import { TOOL_RESULT_MAX_CHARS } from '../sandbox/config';
import { redactSecrets, truncateForModel } from './redact';
import { assertSafePublicHttps } from '../net/publicUrlPolicy';
import type {
  HttpFetchGetResult,
  HttpFetchRunner,
} from './httpFetchTypes';

export const HTTP_GET_SYSTEM_ADDENDUM =
  'You may use http_get to retrieve public HTTPS pages (read-only). Prefer it for docs and references. Do not invent URLs with secrets.';

export const HTTP_ONLY_SYSTEM =
  'You are the Invincible agent. Workspace filesystem tools are unavailable this turn. Use http_get for public HTTPS information when needed. Be concise.';

/** Max hop-by-hop redirects (each Location re-checked by SSRF policy). */
export const HTTP_FETCH_MAX_REDIRECTS = 5;

/** Text-ish Content-Types safe to return to the model. */
export function isTextishContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.startsWith('text/')) return true;
  if (base === 'application/json') return true;
  if (base === 'application/javascript') return true;
  if (base === 'application/xml') return true;
  if (base.endsWith('+json') || base.endsWith('+xml')) return true;
  return false;
}

/** Classic redirect statuses that carry a Location to follow. */
export function isHttpRedirectStatus(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

export type CreateHttpFetchToolsOptions = {
  runner: HttpFetchRunner;
  secrets?: Array<string | undefined | null>;
  /** Root-resolved server secrets (phase 2 — #439); merged for redaction. */
  serverSecrets?: import('../di').ServerSecrets;
  signal?: AbortSignal;
  /** Default max bytes for body read (clamped by caller / runner). */
  maxBytes: number;
  timeoutMs: number;
  /** Include http_head tool. Default true. */
  includeHead?: boolean;
  /** Max redirects to follow (default HTTP_FETCH_MAX_REDIRECTS). */
  maxRedirects?: number;
};

function finalize(
  text: string,
  secrets: Array<string | undefined | null>,
): string {
  return truncateForModel(redactSecrets(text, secrets), TOOL_RESULT_MAX_CHARS);
}

/**
 * Resolve a Location header against the request URL.
 * Returns absolute href or null if unparseable.
 */
export function resolveRedirectLocation(
  location: string,
  baseHref: string,
): string | null {
  const loc = location.trim();
  if (!loc) return null;
  try {
    return new URL(loc, baseHref).href;
  } catch {
    return null;
  }
}

export type RedirectFetchOk = {
  ok: true;
  result: HttpFetchGetResult;
  /** Final policy-checked URL whose body/status we return. */
  finalUrl: string;
  /** Number of redirects followed (0 if direct). */
  redirects: number;
};

export type RedirectFetchErr = {
  ok: false;
  error: string;
};

/**
 * Hop-B still uses curl --max-redirs 0. App follows redirects only after
 * assertSafePublicHttps on each Location (blocks private/metadata targets).
 */
export async function fetchFollowingRedirects(opts: {
  runner: HttpFetchRunner;
  url: string;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  head?: boolean;
  maxRedirects?: number;
}): Promise<RedirectFetchOk | RedirectFetchErr> {
  const maxRedirects = Math.max(
    0,
    Math.floor(opts.maxRedirects ?? HTTP_FETCH_MAX_REDIRECTS),
  );
  let currentUrl = opts.url;
  let redirects = 0;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const result = await opts.runner.get({
      url: currentUrl,
      maxBytes: opts.head ? 0 : opts.maxBytes,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      head: opts.head,
    });

    if (!isHttpRedirectStatus(result.status)) {
      return { ok: true, result, finalUrl: currentUrl, redirects };
    }

    // Never trust 3xx bodies (open-redirect / intermediate HTML).
    if (redirects >= maxRedirects) {
      return {
        ok: false,
        error: `too many redirects (max ${maxRedirects}, last status ${result.status})`,
      };
    }

    const rawLoc = result.location;
    if (!rawLoc?.trim()) {
      return {
        ok: false,
        error: `redirect missing Location (status ${result.status})`,
      };
    }

    const resolved = resolveRedirectLocation(rawLoc, currentUrl);
    if (!resolved) {
      return {
        ok: false,
        error: `redirect has invalid Location (status ${result.status})`,
      };
    }

    const policy = await assertSafePublicHttps(resolved);
    if (!policy.ok) {
      return {
        ok: false,
        error: `redirect blocked (${result.status} → ${resolved}): ${policy.error}`,
      };
    }

    currentUrl = policy.href;
    redirects += 1;
  }

  return {
    ok: false,
    error: `too many redirects (max ${maxRedirects})`,
  };
}

/**
 * Native AI SDK tools for builtin HTTPS fetch.
 * Soft-fail: never throw from execute.
 */
export function createHttpFetchTools(opts: CreateHttpFetchToolsOptions) {
  // Scrub the Gateway key from model-facing tool strings. Secrets are injected
  // (route-resolved serverSecrets) — no process.env reads in this body.
  const secrets: Array<string | undefined | null> = [
    ...(opts.secrets ?? []),
    opts.serverSecrets?.gatewayKey,
  ];
  const includeHead = opts.includeHead !== false;
  const defaultMaxBytes = opts.maxBytes;
  const timeoutMs = opts.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? HTTP_FETCH_MAX_REDIRECTS;
  const { runner, signal } = opts;

  const http_get = tool({
    description:
      'Fetch a public HTTPS URL (GET). Returns text/JSON/XML bodies only. Follows redirects only to policy-safe HTTPS targets. Read-only.',
    inputSchema: jsonSchema<{ url: string; maxBytes?: number }>({
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute https URL to fetch',
        },
        maxBytes: {
          type: 'number',
          description: 'Optional max response bytes (server-capped)',
        },
      },
      required: ['url'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const rawUrl = input?.url?.trim() ?? '';
        if (!rawUrl) {
          return finalize('ERROR http_get: url is required', secrets);
        }
        const policy = await assertSafePublicHttps(rawUrl);
        if (!policy.ok) {
          return finalize(`ERROR http_get: ${policy.error}`, secrets);
        }
        let maxBytes = defaultMaxBytes;
        if (input?.maxBytes != null && Number.isFinite(Number(input.maxBytes))) {
          maxBytes = Math.min(
            defaultMaxBytes,
            Math.max(1, Math.floor(Number(input.maxBytes))),
          );
        }
        const followed = await fetchFollowingRedirects({
          runner,
          url: policy.href,
          maxBytes,
          timeoutMs,
          signal,
          maxRedirects,
        });
        if (!followed.ok) {
          return finalize(`ERROR http_get: ${followed.error}`, secrets);
        }
        const { result, finalUrl, redirects } = followed;
        if (!isTextishContentType(result.contentType)) {
          return finalize(
            `ERROR http_get: unsupported content-type ${result.contentType ?? '(none)'} (status ${result.status})`,
            secrets,
          );
        }
        const flag = result.truncated ? ' (truncated)' : '';
        const via =
          redirects > 0
            ? ` via ${redirects} redirect${redirects === 1 ? '' : 's'}`
            : '';
        return finalize(
          `http_get ${finalUrl} → ${result.status}${flag}${via}\n${result.body}`,
          secrets,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR http_get: ${msg}`, secrets);
      }
    },
  });

  if (!includeHead) {
    return { http_get };
  }

  const http_head = tool({
    description:
      'HTTP HEAD for a public HTTPS URL. Returns status and headers only. Follows redirects only to policy-safe HTTPS targets.',
    inputSchema: jsonSchema<{ url: string }>({
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute https URL',
        },
      },
      required: ['url'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      try {
        const rawUrl = input?.url?.trim() ?? '';
        if (!rawUrl) {
          return finalize('ERROR http_head: url is required', secrets);
        }
        const policy = await assertSafePublicHttps(rawUrl);
        if (!policy.ok) {
          return finalize(`ERROR http_head: ${policy.error}`, secrets);
        }
        const followed = await fetchFollowingRedirects({
          runner,
          url: policy.href,
          maxBytes: 0,
          timeoutMs,
          signal,
          head: true,
          maxRedirects,
        });
        if (!followed.ok) {
          return finalize(`ERROR http_head: ${followed.error}`, secrets);
        }
        const { result, finalUrl, redirects } = followed;
        const via =
          redirects > 0
            ? ` via ${redirects} redirect${redirects === 1 ? '' : 's'}`
            : '';
        return finalize(
          `http_head ${finalUrl} → ${result.status} content-type=${result.contentType ?? '(none)'}${via}`,
          secrets,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR http_head: ${msg}`, secrets);
      }
    },
  });

  return { http_get, http_head };
}
