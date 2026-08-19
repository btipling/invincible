/**
 * Pure helpers for the `sandbox_info` tool: parse `env` stdout, omit secrets,
 * canonicalize PATH-like values **per colon-separated entry** via
 * `workspaceAbsToRel` (never `rewriteExecRootToRel` on a joined PATH= line).
 */
import { workspaceAbsToRel } from './workPath';

/** Generous cap vs a typical Unix env (~50–150 keys). */
export const SANDBOX_INFO_ENV_MAX_KEYS = 512;

/** Must not use the 5 min exec default — same order as BYO health probe. */
export const SANDBOX_INFO_ENV_EXEC_TIMEOUT_MS = 10_000;

export const PATH_LIKE_ENV_KEYS = new Set([
  'PATH',
  'NODE_PATH',
  'PYTHONPATH',
  'LD_LIBRARY_PATH',
  'MANPATH',
  'GOPATH',
  'CDPATH',
]);

export const SINGLE_PATH_ENV_KEYS = new Set(['PWD', 'HOME', 'OLDPWD', 'TMPDIR']);

export const SANDBOX_INFO_OMIT_ENV_KEYS = new Set([
  'SANDBOX_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'AI_GATEWAY_API_KEY',
  'BLOB_READ_WRITE_TOKEN',
  'DATABASE_URL',
  'REDIS_URL',
  'AUTH_SECRET',
  'CREDENTIALS_ENCRYPTION_KEY',
]);

const OMIT_NAME_SUFFIX = /(_TOKEN|_SECRET|_KEY|_PASSWORD|_CIPHERTEXT)(_|$)/i;
const OMIT_NAME_PREFIX = /^(DEK|AMK|KEK)(_|$)/i;
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export type SandboxInfoBind = {
  backend: 'byo' | 'vercel';
  sandboxId: string;
  name: string;
  slug: string;
  status: string;
  image?: string | null;
};

export type FormattedEnv = {
  lines: string[];
  omittedByCap: number;
};

export function shouldOmitEnvKey(name: string): boolean {
  if (SANDBOX_INFO_OMIT_ENV_KEYS.has(name)) return true;
  if (OMIT_NAME_SUFFIX.test(name)) return true;
  if (OMIT_NAME_PREFIX.test(name)) return true;
  return false;
}

export function parseEnvStdout(stdout: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const src = stdout == null ? '' : String(stdout);
  for (const line of src.split('\n')) {
    if (!line) continue;
    const m = ENV_LINE.exec(line);
    if (!m) continue;
    out.push([m[1]!, m[2]!]);
  }
  return out;
}

function secretHit(
  value: string,
  secrets: Array<string | undefined | null>,
): boolean {
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    if (value.includes(s)) return true;
  }
  return false;
}

/** Map one path-shaped entry. Out-of-jail absolutes stay; missing R is a no-op. */
export function canonicalizePathEntry(
  R: string | null | undefined,
  entry: string,
): string {
  if (!entry.startsWith('/')) return entry;
  if (typeof R !== 'string' || R === '') return entry;
  try {
    return workspaceAbsToRel(R, entry);
  } catch {
    return entry;
  }
}

export function formatSandboxInfoEnv(
  stdout: string,
  R: string | null | undefined,
  secrets: Array<string | undefined | null> = [],
): FormattedEnv {
  const parsed = parseEnvStdout(stdout);
  parsed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const lines: string[] = [];
  let kept = 0;
  let omittedByCap = 0;
  for (const [key, value] of parsed) {
    if (shouldOmitEnvKey(key) || secretHit(value, secrets)) continue;
    const formatted = formatEnvValue(R, key, value);
    if (formatted === null) continue;
    if (kept >= SANDBOX_INFO_ENV_MAX_KEYS) {
      omittedByCap += 1;
      continue;
    }
    lines.push(`env.${key}=${formatted}`);
    kept += 1;
  }
  return { lines, omittedByCap };
}

function formatEnvValue(
  R: string | null | undefined,
  key: string,
  value: string,
): string | null {
  if (PATH_LIKE_ENV_KEYS.has(key)) {
    const entries = value.split(':').map((e) => canonicalizePathEntry(R, e));
    return JSON.stringify(entries);
  }
  if (SINGLE_PATH_ENV_KEYS.has(key)) {
    const mapped = canonicalizePathEntry(R, value);
    if (mapped.startsWith('/')) return null;
    return mapped;
  }
  if (value.startsWith('/') && !value.includes('://')) {
    const mapped = canonicalizePathEntry(R, value);
    return mapped;
  }
  return value;
}

export function envUnavailableReason(opts: {
  timedOut?: boolean;
  exitCode?: number | null;
  threw?: boolean;
  throwStatus?: number;
  throwName?: string;
}): string {
  if (opts.timedOut) return 'env: unavailable (timeout)';
  if (opts.threw) {
    if (opts.throwStatus === 504 || opts.throwName === 'AbortError') {
      return 'env: unavailable (timeout)';
    }
    return 'env: unavailable (error)';
  }
  const code = opts.exitCode;
  if (code === undefined || code === null) return 'env: unavailable (error)';
  if (code !== 0) return `env: unavailable (exit=${code})`;
  return 'env: unavailable (error)';
}
