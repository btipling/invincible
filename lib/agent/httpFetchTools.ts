/**
 * Native AI SDK tools: http_get (+ optional http_head) with injectable runner.
 * Soft-fail strings; policy before egress; text-ish bodies only; TOOL_RESULT_MAX_CHARS.
 * Parent #225 / phase #226.
 */

import { jsonSchema, tool } from 'ai';
import { TOOL_RESULT_MAX_CHARS } from '../sandbox/config';
import { assertSafePublicHttps } from '../net/publicUrlPolicy';
import { redactSecrets, truncateForModel } from './redact';
import type { HttpFetchRunner } from './httpFetchTypes';

export type CreateHttpFetchToolsOptions = {
  runner: HttpFetchRunner;
  secrets?: Array<string | undefined | null>;
  signal?: AbortSignal;
  /** Default max body bytes before truncation at runner. Clamped 1..262144. */
  maxBytes?: number;
  /** Default timeout ms. Clamped 1..20000. */
  timeoutMs?: number;
  /** Include http_head when runner.head is present (default true if head exists). */
  includeHead?: boolean;
};

const DEFAULT_MAX_BYTES = 65_536;
const HARD_MAX_BYTES = 262_144; // 256 KiB
const DEFAULT_TIMEOUT_MS = 10_000;
const HARD_MAX_TIMEOUT_MS = 20_000;

/** Content types we pass through as text to the model. */
const TEXTISH = /^(text\/|application\/(json|javascript|xml)|application\/[\w.+-]*\+(json|xml))/i;

function clampMaxBytes(n?: number): number {
  if (n == null || !Number.isFinite(Number(n))) return DEFAULT_MAX_BYTES;
  const i = Math.floor(Number(n));
  if (i < 1) return 1;
  if (i > HARD_MAX_BYTES) return HARD_MAX_BYTES;
  return i;
}

function clampTimeoutMs(n?: number): number {
  if (n == null || !Number.isFinite(Number(n))) return DEFAULT_TIMEOUT_MS;
  const i = Math.floor(Number(n));
  if (i < 1) return 1;
  if (i > HARD_MAX_TIMEOUT_MS) return HARD_MAX_TIMEOUT_MS;
  return i;
}

function finalize(
  text: string,
  secrets: Array<string | undefined | null>,
): string {
  return truncateForModel(redactSecrets(text, secrets), TOOL_RESULT_MAX_CHARS);
}

function isTextish(contentType?: string): boolean {
  if (!contentType) return false;
  const ct = contentType.split(';')[0]?.trim() ?? '';
  return TEXTISH.test(ct);
}

/**
 * Create http_get and optionally http_head tools.
 * Soft-fail: never throw from execute.
 */
export function createHttpFetchTools(opts: CreateHttpFetchToolsOptions) {
  const secrets = opts.secrets ?? [];
  const defaultMaxBytes = clampMaxBytes(opts.maxBytes);
  const defaultTimeoutMs = clampTimeoutMs(opts.timeoutMs);
  const { runner, signal } = opts;
  const wantHead =
    opts.includeHead !== false && typeof runner.head === 'function';

  const http_get = tool({
    description:
      'Fetch a public HTTPS URL (GET, no redirects). Returns status and text body when content-type is text-ish (text/*, JSON, JS, XML). Binary or unknown types return a short error. Use for public documentation and APIs only — never secrets or private hosts.',
    inputSchema: jsonSchema<{ url: string; maxBytes?: number }>({
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute https URL',
        },
        maxBytes: {
          type: 'number',
          description: `Optional max response bytes (default ${DEFAULT_MAX_BYTES}, max ${HARD_MAX_BYTES})`,
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
        const maxBytes = clampMaxBytes(input.maxBytes ?? defaultMaxBytes);
        const result = await runner.get({
          url: policy.href,
          maxBytes,
          timeoutMs: defaultTimeoutMs,
          signal,
        });
        if (result.status >= 300 && result.status < 400) {
          return finalize(
            `ERROR http_get: redirect status ${result.status} (redirects not followed)`,
            secrets,
          );
        }
        if (!isTextish(result.contentType) && result.body.length > 0) {
          return finalize(
            `ERROR http_get: non-text content-type ${result.contentType ?? '(none)'} status=${result.status}`,
            secrets,
          );
        }
        const flag = result.truncated ? ' (truncated)' : '';
        return finalize(
          `http_get ${policy.href} status=${result.status}${flag}:\n${result.body}`,
          secrets,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR http_get: ${msg}`, secrets);
      }
    },
  });

  if (!wantHead) {
    return { http_get };
  }

  const http_head = tool({
    description:
      'HTTP HEAD for a public HTTPS URL (no redirects). Returns status, content-type, and content-length when available.',
    inputSchema: jsonSchema<{ url: string }>({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute https URL' },
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
        const result = await runner.head!({
          url: policy.href,
          timeoutMs: defaultTimeoutMs,
          signal,
        });
        if (result.status >= 300 && result.status < 400) {
          return finalize(
            `ERROR http_head: redirect status ${result.status} (redirects not followed)`,
            secrets,
          );
        }
        const parts = [
          `http_head ${policy.href}`,
          `status=${result.status}`,
        ];
        if (result.contentType) parts.push(`content-type=${result.contentType}`);
        if (result.contentLength) {
          parts.push(`content-length=${result.contentLength}`);
        }
        return finalize(parts.join(' '), secrets);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return finalize(`ERROR http_head: ${msg}`, secrets);
      }
    },
  });

  return { http_get, http_head };
}

export type HttpFetchToolSet = ReturnType<typeof createHttpFetchTools>;
