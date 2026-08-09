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
 *   --dry-run   list candidates only (default when DRY_RUN=1)
 *   --cleanup   stop+delete candidates (requires CONFIRM_CLEANUP=1 or --cleanup)
 *
 * Never Sandbox.create / getOrCreate. Never delete names present in
 * user_sandbox_instances.vercel_name.
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
 * @param {number} [ageMs]
 */
export function isOrphanCandidate(sb, denylist, nowMs, ageMs = ORPHAN_AGE_MS) {
  const name = (sb?.name ?? '').trim();
  if (!name) return false;
  if (denylist.has(name)) return false;

  const prefixHit = PRODUCT_NAME_PREFIXES.some((p) => name.startsWith(p));
  if (prefixHit) return true;

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
 */
export function selectOrphanCandidates(sandboxes, denylistNames, nowMs = Date.now()) {
  const denylist = new Set(
    [...denylistNames].map((n) => String(n).trim()).filter(Boolean),
  );
  return sandboxes.filter((sb) => isOrphanCandidate(sb, denylist, nowMs));
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
  // Explicit --dry-run wins; else cleanup when requested; else dry-run safe default.
  if (argv.includes('--dry-run') || (wantDry && !wantCleanup)) {
    return { dryRun: true, cleanup: false };
  }
  if (wantCleanup) {
    return { dryRun: false, cleanup: true };
  }
  return { dryRun: true, cleanup: false };
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

async function deleteCandidate(name, creds) {
  const sb = await Sandbox.get({
    name,
    token: creds.token,
    teamId: creds.teamId,
    projectId: creds.projectId,
    resume: false,
  });
  try {
    await sb.stop();
  } catch {
    // ignore stop errors
  }
  try {
    await sb.delete();
  } catch {
    // ignore delete errors (not_found)
  }
}

async function main() {
  const { dryRun, cleanup } = parseArgs(process.argv.slice(2));
  const databaseUrl = requireEnv('DATABASE_URL');
  const creds = {
    token: requireEnv('VERCEL_TOKEN'),
    teamId: requireEnv('VERCEL_TEAM_ID'),
    projectId: requireEnv('VERCEL_PROJECT_ID'),
  };

  const denylist = await loadDenylist(databaseUrl);
  const listed = await listAllSandboxes(creds);
  const candidates = selectOrphanCandidates(listed, denylist);

  const summary = {
    listed: listed.length,
    denylist: denylist.length,
    candidates: candidates.length,
    dryRun: dryRun || !cleanup,
    deleted: 0,
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
        await deleteCandidate(c.name, creds);
        summary.deleted += 1;
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
