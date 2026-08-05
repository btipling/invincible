/**
 * SSRF policy for user-supplied MCP remote URLs (parent #116 / phase #117).
 * https only; no userinfo; block private/link-local/metadata hosts.
 * Rejects private A/AAAA after DNS lookup when hostname is not an IP literal.
 */

import { promises as dns } from 'node:dns';

/** Well-known cloud metadata / internal hostnames (lowercase, no trailing dot). */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'kubernetes.default',
  'kubernetes.default.svc',
]);

export type UrlPolicyLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export type AssertSafeMcpUrlOptions = {
  /** Inject DNS lookup (tests). Defaults to dns.promises.lookup. */
  lookup?: UrlPolicyLookup;
  /** Skip DNS when true (literal-only checks). Default false. */
  skipDns?: boolean;
};

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/** True if IPv4 is loopback, RFC1918, link-local, CGNAT, or unspecified. */
function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number);
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  // AWS/ECS task metadata commonly 169.254.170.2 — covered by 169.254/16 above
  return false;
}

function stripBrackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1);
  }
  return host;
}

/**
 * Normalize hostname: strip brackets, lowercase, strip trailing FQDN dots.
 */
function normalizeHostname(host: string): string {
  let h = stripBrackets(host).toLowerCase();
  while (h.endsWith('.')) {
    h = h.slice(0, -1);
  }
  return h;
}

/**
 * Parse IPv4-mapped IPv6 hex form ::ffff:HHHH:LLLL → dotted IPv4, or null.
 * Node URL normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1 (brackets optional).
 */
function ipv4FromMappedHex(host: string): string | null {
  const h = host.toLowerCase();
  // Matches ::ffff:7f00:1, 0:0:0:0:0:ffff:7f00:1, :ffff:7f00:1, etc.
  const m = h.match(/:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo) || hi > 0xffff || lo > 0xffff) {
    return null;
  }
  const a = (hi >> 8) & 0xff;
  const b = hi & 0xff;
  const c = (lo >> 8) & 0xff;
  const d = lo & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

/** True if IPv6 is loopback, link-local, ULA, mapped-private, or unspecified. */
function isPrivateIpv6(host: string): boolean {
  const h = normalizeHostname(host);
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('fe80:')) return true; // link-local
  // Unique-local fc00::/7
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  // Multicast ff00::/8 — not a useful MCP target
  if (h.startsWith('ff')) return true;

  // IPv4-mapped dotted-decimal (:ffff:x.x.x.x or ::ffff:x.x.x.x)
  const dotted = h.match(/:ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted && isIpv4(dotted[1]) && isPrivateIpv4(dotted[1])) return true;

  // IPv4-mapped hex (::ffff:7f00:1)
  const mapped = ipv4FromMappedHex(h);
  if (mapped && isPrivateIpv4(mapped)) return true;

  return false;
}

function isBlockedHostname(host: string): boolean {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host === 'localhost' || host.startsWith('localhost.')) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // metadata IP literals handled via isPrivateIpv4
  if (host === '169.254.169.254' || host === '169.254.170.2') return true;
  return false;
}

function isIpLiteralPrivate(host: string): boolean {
  if (isIpv4(host)) {
    return isPrivateIpv4(host);
  }
  if (host.includes(':')) {
    return isPrivateIpv6(host);
  }
  return false;
}

export type SafeMcpUrlResult =
  | { ok: true; href: string }
  | { ok: false; error: string };

/**
 * Validate a user-supplied MCP endpoint URL (async: may resolve DNS).
 */
export async function assertSafeMcpUrl(
  url: string,
  opts: AssertSafeMcpUrlOptions = {},
): Promise<SafeMcpUrlResult> {
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

  const host = normalizeHostname(parsed.hostname);
  if (!host) {
    return { ok: false, error: 'url host is required' };
  }

  if (isBlockedHostname(host)) {
    return { ok: false, error: 'url host is not allowed' };
  }

  if (isIpLiteralPrivate(host)) {
    return { ok: false, error: 'url must not target a private address' };
  }

  // Hostname (not IP literal): resolve A/AAAA and reject private answers.
  const isLiteral = isIpv4(host) || host.includes(':');
  if (!isLiteral && !opts.skipDns) {
    const lookup: UrlPolicyLookup =
      opts.lookup ??
      ((hostname, options) => dns.lookup(hostname, options));
    try {
      const records = await lookup(host, { all: true, verbatim: true });
      if (!records.length) {
        return { ok: false, error: 'url host could not be resolved' };
      }
      for (const rec of records) {
        const addr = rec.address.toLowerCase();
        if (rec.family === 4 || isIpv4(addr)) {
          if (isPrivateIpv4(addr)) {
            return {
              ok: false,
              error: 'url must not resolve to a private address',
            };
          }
        } else if (rec.family === 6 || addr.includes(':')) {
          if (isPrivateIpv6(addr)) {
            return {
              ok: false,
              error: 'url must not resolve to a private address',
            };
          }
        }
      }
    } catch {
      return { ok: false, error: 'url host could not be resolved' };
    }
  }

  // Rebuild href with normalized hostname (drop trailing-dot / weird forms).
  // Keep path/query/port from parsed URL; force hostname without trailing dots.
  try {
    const normalized = new URL(parsed.href);
    // URL may re-bracket IPv6; assign host carefully
    if (isIpv4(host) || !host.includes(':')) {
      normalized.hostname = host;
    }
    return { ok: true, href: normalized.href };
  } catch {
    return { ok: true, href: parsed.href };
  }
}
