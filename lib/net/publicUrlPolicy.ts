/**
 * Public HTTPS URL policy for builtin http_get / http_head (parent #225 / phase #226).
 * Same SSRF rules as MCP remote URLs: https only, no userinfo, block private /
 * link-local / metadata hosts, DNS recheck when hostname is not an IP literal.
 */

import {
  assertSafeMcpUrl,
  type AssertSafeMcpUrlOptions,
  type SafeMcpUrlResult,
  type UrlPolicyLookup,
} from '../mcp/urlPolicy';

export type { UrlPolicyLookup, SafeMcpUrlResult };

export type AssertSafePublicHttpsOptions = AssertSafeMcpUrlOptions;

/**
 * Validate a user-supplied public HTTPS URL for builtin fetch tools.
 * Identical policy surface to assertSafeMcpUrl (shared implementation).
 */
export async function assertSafePublicHttps(
  url: string,
  opts: AssertSafePublicHttpsOptions = {},
): Promise<SafeMcpUrlResult> {
  return assertSafeMcpUrl(url, opts);
}
