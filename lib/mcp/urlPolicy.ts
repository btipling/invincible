/**
 * SSRF policy for user-supplied MCP remote URLs (parent #116 / phase #117).
 * https only; no userinfo; block private/link-local/metadata hosts.
 */

/** Well-known cloud metadata / internal hostnames (lowercase). */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/** True if IPv4 is loopback, RFC1918, link-local, or unspecified. */
function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number);
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

/** True if IPv6 is loopback, link-local, ULA, or unspecified (normalized lower). */
function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fe80:')) return true; // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // ULA
  // IPv4-mapped :ffff:x.x.x.x
  const m = h.match(/^:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m && isIpv4(m[1]) && isPrivateIpv4(m[1])) return true;
  // compressed forms containing ffff:private
  const m2 = h.match(/ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m2 && isIpv4(m2[1]) && isPrivateIpv4(m2[1])) return true;
  return false;
}

export type SafeMcpUrlResult =
  | { ok: true; href: string }
  | { ok: false; error: string };

/**
 * Validate a user-supplied MCP endpoint URL.
 * Does not perform DNS (callers may add post-DNS checks where available).
 */
export function assertSafeMcpUrl(url: string): SafeMcpUrlResult {
  const raw = url?.trim() ?? '';
  if (!raw) {
    return { ok: false, error: 'url is required' };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'invalid url' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'url must be https' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'url must not include credentials' };
  }

  const host = stripBrackets(parsed.hostname).toLowerCase();
  if (!host) {
    return { ok: false, error: 'url host is required' };
  }

  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, error: 'url host is not allowed' };
  }

  if (host.endsWith('.localhost') || host.endsWith('.local')) {
    return { ok: false, error: 'url host is not allowed' };
  }

  if (isIpv4(host)) {
    if (isPrivateIpv4(host)) {
      return { ok: false, error: 'url must not target a private address' };
    }
  } else if (host.includes(':')) {
    if (isPrivateIpv6(host)) {
      return { ok: false, error: 'url must not target a private address' };
    }
  }

  // Block bare metadata IP even if somehow not caught
  if (host === '169.254.169.254' || host === '169.254.170.2') {
    return { ok: false, error: 'url host is not allowed' };
  }

  return { ok: true, href: parsed.href };
}
