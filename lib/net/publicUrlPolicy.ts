/**
 * Public HTTPS URL policy for agent builtin fetch (and reusable SSRF gate).
 * Wraps the MCP URL policy — same https-only / no-userinfo / private DNS rules.
 */

import {
  assertSafeMcpUrl,
  type AssertSafeMcpUrlOptions,
  type SafeMcpUrlResult,
} from '../mcp/urlPolicy';

export type AssertSafePublicHttpsOptions = AssertSafeMcpUrlOptions;
export type SafePublicHttpsResult = SafeMcpUrlResult;

/**
 * Validate a user-supplied absolute HTTPS URL for outbound fetch.
 * Rejects private/link-local/metadata hosts; may resolve DNS.
 */
export async function assertSafePublicHttps(
  url: string,
  opts: AssertSafePublicHttpsOptions = {},
): Promise<SafePublicHttpsResult> {
  return assertSafeMcpUrl(url, opts);
}
