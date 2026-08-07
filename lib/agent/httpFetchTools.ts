import { jsonSchema, tool } from 'ai';
import { TOOL_RESULT_MAX_CHARS } from '../sandbox/config';
import { redactSecrets, truncateForModel } from './redact';
import { assertSafePublicHttps } from '../net/publicUrlPolicy';
import type { HttpFetchRunner } from './httpFetchTypes';

export const HTTP_GET_SYSTEM_ADDENDUM =
  'You may use http_get to retrieve public HTTPS pages (read-only). Prefer it for docs and references. Do not invent URLs with secrets.';

export const HTTP_ONLY_SYSTEM =
  'You are the Invincible agent. Workspace filesystem tools are unavailable this turn. Use http_get for public HTTPS information when needed. Be concise.';

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

export type CreateHttpFetchToolsOptions = {
  runner: HttpFetchRunner;
  secrets?: Array<string | undefined | null>;
  signal?: AbortSignal;
  /** Default max bytes for body read (clamped by caller / runner). */
  maxBytes: number;
  timeoutMs: number;
  /** Include http_head tool. Default true. */
  includeHead?: boolean;
};

function finalize(
  text: string,
  secrets: Array<string | undefined | null>,
): string {
  return truncateForModel(redactSecrets(text, secrets), TOOL_RESULT_MAX_CHARS);
}

/**
 * Native AI SDK tools for builtin HTTPS fetch.
 * Soft-fail: never throw from execute.
 */
export function createHttpFetchTools(opts: CreateHttpFetchToolsOptions) {
  const secrets = opts.secrets ?? [];
  const includeHead = opts.includeHead !== false;
  const defaultMaxBytes = opts.maxBytes;
  const timeoutMs = opts.timeoutMs;
  const { runner, signal } = opts;

  const http_get = tool({
    description:
      'Fetch a public HTTPS URL (GET). Returns text/JSON/XML bodies only. No redirect following. Read-only.',
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
        const result = await runner.get({
          url: policy.href,
          maxBytes,
          timeoutMs,
          signal,
        });
        if (result.status >= 300 && result.status < 400) {
          return finalize(
            `ERROR http_get: redirect not followed (status ${result.status})`,
            secrets,
          );
        }
        if (!isTextishContentType(result.contentType)) {
          return finalize(
            `ERROR http_get: unsupported content-type ${result.contentType ?? '(none)'} (status ${result.status})`,
            secrets,
          );
        }
        const flag = result.truncated ? ' (truncated)' : '';
        return finalize(
          `http_get ${policy.href} → ${result.status}${flag}\n${result.body}`,
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
      'HTTP HEAD for a public HTTPS URL. Returns status and headers only. No redirect following.',
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
        const result = await runner.get({
          url: policy.href,
          maxBytes: 0,
          timeoutMs,
          signal,
          head: true,
        });
        if (result.status >= 300 && result.status < 400) {
          return finalize(
            `ERROR http_head: redirect not followed (status ${result.status})`,
            secrets,
          );
        }
        return finalize(
          `http_head ${policy.href} → ${result.status} content-type=${result.contentType ?? '(none)'}`,
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
