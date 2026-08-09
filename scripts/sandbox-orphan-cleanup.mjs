/**
 * Optional orphan Vercel Sandbox cleanup (parent #298 / phase 5).
 *
 * Primary operator path: GitHub Actions workflow `sandbox-orphan-cleanup`
 * (workflow_dispatch, confirm=cleanup, dry_run default true).
 *
 * Env (names only — never log values):
 *   DATABASE_URL, VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 *
 * Flags:
 *   --dry-run                 list candidates only (default when DRY_RUN=1)
 *   --cleanup                 stop+delete candidates (requires CONFIRM_CLEANUP=1 or --cleanup)
 *   --include-non-product     also select non-product non-persistent VMs ≥ age (off by default)
 *
 * Never Sandbox.create / getOrCreate. Never delete names present in
 * user_sandbox_instances.vercel_name.
 * Default selection: product prefixes (inv-workspace- / inv-http-) not on denylist only.
 */

import postgres from 'postgres';
import { pathToFileURL } from 'node:url';
import { Sandbox } from '@vercel/sandbox';

export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
export const PRODUCT_NAME_PREFIXES = ['inv-workspace-', 'inv-http-'];

/**
 * @param {{ name: string, persistent?: boolean, createdAt?: number }} sb
 * @param {Set<string>} denylist
 * @param {number} nowMs
 * @param {{ ageMs?: number, includeNonProduct?: boolean }} [opts]
 */
export function isOrphanCandidate(sb, denylist, nowMs, opts = {}) {
  const ageMs = opts.ageMs ?? ORPHAN_AGE_MS;
  const includeNonProduct = opts.includeNonProduct === true;
  const name = (sb?.name ?? '').trim();
  if (!name) return false;
  if (denylist.has(name)) return false;

  const prefixHit = PRODUCT_NAME_PREFIXES.some((p) => name.startsWith(p));
  if (prefixHit) return true;

  if (!includeNonProduct) return false;

  const persistent = sb.persistent === true;
  if (persistent) return false;

  const createdAt = Number(sb.createdAt);
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  const age = nowMs - createdAt;
  return age >= ageMs;
}

/**
 * @param {Array<{ name: string, persistent?: boolean, createdAt?: number, status?: string }>} sandboxes
 * @param {Iterable<string>} denylistNames
 * @param {number} [nowMs]
 * @param {{ includeNonProduct?: boolean, ageMs?: number }} [opts]
 */
export function selectOrphanCandidates(
  sandboxes,
  denylistNames,
  nowMs = Date.now(),
  opts = {},
) {
  const denylist = new Set(
    [...denylistNames].map((n) => String(n).trim()).filter(Boolean),
  );
  return sandboxes.filter((sb) => isOrphanCandidate(sb, denylist, nowMs, opts));
}

function isNotFoundError(err) {
  if (!err || typeof err !== 'object') return false;
  const e = err;
  if (e.response?.status === 404) return true;
  if (e.code === 'not_found') return true;
  if (e.json?.error?.code === 'not_found') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /not[_ ]found/i.test(msg);
}

function parseArgs(argv) {
  const wantDry =
    argv.includes('--dry-run') ||
    process.env.DRY_RUN === '1' ||
    process.env.DRY_RUN === 'true';
  const wantCleanup =
    argv.includes('--cleanup') ||
    process.env.CONFIRM_CLEANUP === '1' ||
    process.env.CONFIRM_CLEANUP === 'cleanup';
  const includeNonProduct =
    argv.includes('--include-non-product') ||
    process.env.INCLUDE_NON_PRODUCT === '1' ||
    process.env.INCLUDE_NON_PRODUCT === 'true';
  // Explicit --dry-run wins; else cleanup when requested; else dry-run safe default.
  let dryRun = true;
  let cleanup = false;
  if (argv.includes('--dry-run') || (wantDry && !wantCleanup)) {
    dryRun = true;
    cleanup = false;
  } else if (wantCleanup) {
    dryRun = false;
    cleanup = true;
  }
  return { dryRun, cleanup, includeNonProduct };
}

function requireEnv(name) {
  const v = (process.env[name] ?? '').trim();
  if (!v) {
    console.error(`${name} is required (value not printed)`);
    process.exit(1);
  }
  return v;
}

async function loadDenylist(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await sql`
      SELECT vercel_name FROM user_sandbox_instances
      WHERE vercel_name IS NOT NULL AND trim(vercel_name) <> ''
    `;
    return rows.map((r) => String(r.vercel_name).trim());
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function listAllSandboxes(creds) {
  const result = await Sandbox.list({
    token: creds.token,
    teamId: creds.teamId,
    projectId: creds.projectId,
  });
  /** @type {Array<{ name: string, persistent?: boolean, createdAt?: number, status?: string }>} */
  let raw = [];
  if (typeof result.toArray === 'function') {
    raw = await result.toArray();
  } else if (Array.isArray(result.sandboxes)) {
    raw = result.sandboxes;
  } else {
    for await (const sb of result) {
      raw.push(sb);
    }
  }
  return raw.map((sb) => ({
    name: sb.name,
    persistent: sb.persistent,
    createdAt: sb.createdAt,
    status: sb.status,
  }));
}

/**
 * Stop + delete one candidate. Rethrows non-not_found failures so callers
 * do not count a successful delete when the platform still has the VM.
 * @param {string} name
 * @param {{ token: string, teamId: string, projectId: string }} creds
 */
export async function deleteCandidate(name, creds) {
  let sb;
  try {
    sb = await Sandbox.get({
      name,
      token: creds.token,
      teamId: creds.teamId,
      projectId: creds.projectId,
      resume: false,
    });
  } catch (err) {
    if (isNotFoundError(err)) {
      return { deleted: false, alreadyGone: true };
    }
    throw err;
  }
  try {
    await sb.stop();
  } catch (err) {
    // Stop may fail if already stopped — only ignore not_found-ish; keep going to delete.
    if (!isNotFoundError(err)) {
      // still attempt delete; stop failure alone is not fatal if delete works
    }
  }
  try {
    await sb.delete();
  } catch (err) {
    if (isNotFoundError(err)) {
      return { deleted: false, alreadyGone: true };
    }
    throw err;
  }
  return { deleted: true, alreadyGone: false };
}

async function main() {
  const { dryRun, cleanup, includeNonProduct } = parseArgs(process.argv.slice(2));
  const databaseUrl = requireEnv('DATABASE_URL');
  const creds = {
    token: requireEnv('VERCEL_TOKEN'),
    teamId: requireEnv('VERCEL_TEAM_ID'),
    projectId: requireEnv('VERCEL_PROJECT_ID'),
  };

  const denylist = await loadDenylist(databaseUrl);
  const listed = await listAllSandboxes(creds);
  const candidates = selectOrphanCandidates(listed, denylist, Date.now(), {
    includeNonProduct,
  });

  const summary = {
    listed: listed.length,
    denylist: denylist.length,
    candidates: candidates.length,
    includeNonProduct,
    dryRun: dryRun || !cleanup,
    deleted: 0,
    alreadyGone: 0,
    errors: 0,
  };

  for (const c of candidates) {
    const ageH =
      c.createdAt != null
        ? ((Date.now() - Number(c.createdAt)) / 3_600_000).toFixed(1)
        : '?';
    console.log(
      JSON.stringify({
        name: c.name,
        status: c.status ?? null,
        persistent: c.persistent ?? null,
        ageHours: ageH,
        action: summary.dryRun ? 'would_delete' : 'delete',
      }),
    );
  }

  if (!summary.dryRun) {
    for (const c of candidates) {
      try {
        const result = await deleteCandidate(c.name, creds);
        if (result.deleted) summary.deleted += 1;
        else if (result.alreadyGone) summary.alreadyGone += 1;
      } catch (err) {
        summary.errors += 1;
        console.error(
          JSON.stringify({
            name: c.name,
            error: err instanceof Error ? err.message : 'delete failed',
          }),
        );
      }
    }
  }

  console.log(JSON.stringify({ summary }));
  if (summary.errors > 0) process.exit(1);
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
