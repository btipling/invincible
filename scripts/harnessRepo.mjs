/**
 * Pure harness artifact GitHub owner/repo resolution (no I/O).
 * Used by scripts/fetch-harness-artifact.mjs so unit tests never import the
 * side-effectful fetch entry (which always runs main()).
 */

/**
 * @param {string | undefined | null} raw
 * @returns {{ owner: string | null, repo: string | null }}
 */
export function parseGithubRepository(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { owner: null, repo: null };
  const slash = s.indexOf('/');
  if (slash <= 0) return { owner: null, repo: null };
  const owner = s.slice(0, slash).trim();
  const rest = s.slice(slash + 1);
  // take second path segment only (org/name[...ignored])
  const repoSeg = rest.split('/')[0]?.trim() ?? '';
  if (!owner || !repoSeg) return { owner: null, repo: null };
  return { owner, repo: repoSeg };
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function isHarnessRequire(env) {
  if (env.HARNESS_REQUIRE === '0') return false;
  if (env.VERCEL === '1' || env.VERCEL === 'true') return true;
  if (env.HARNESS_REQUIRE === '1') return true;
  return false;
}

/**
 * @param {string | undefined | null} value
 * @returns {string | null}
 */
function trimEnv(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

/**
 * Resolve GitHub owner/repo for harness-wasm artifact download.
 *
 * Precedence (per field):
 *   HARNESS_OWNER / HARNESS_REPO
 *   || VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG
 *   || GITHUB_REPOSITORY segments
 *   || local last-resort fallback (only when not require-mode)
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {{ owner: string, repo: string, source: 'explicit' | 'vercel-git' | 'github-repository' | 'fallback' }}
 */
export function resolveHarnessRepo(env = process.env) {
  const explicitOwner = trimEnv(env.HARNESS_OWNER);
  const explicitRepo = trimEnv(env.HARNESS_REPO);
  const vercelOwner = trimEnv(env.VERCEL_GIT_REPO_OWNER);
  const vercelSlug = trimEnv(env.VERCEL_GIT_REPO_SLUG);
  const gh = parseGithubRepository(env.GITHUB_REPOSITORY);

  let owner = explicitOwner || vercelOwner || gh.owner;
  let repo = explicitRepo || vercelSlug || gh.repo;

  /** @type {'explicit' | 'vercel-git' | 'github-repository' | 'fallback'} */
  let source;
  if (explicitOwner || explicitRepo) {
    source = 'explicit';
  } else if (vercelOwner || vercelSlug) {
    source = 'vercel-git';
  } else if (gh.owner && gh.repo) {
    source = 'github-repository';
  } else {
    source = 'fallback';
  }

  if (!owner || !repo) {
    if (isHarnessRequire(env)) {
      throw new Error(
        'Cannot resolve GitHub owner/repo for harness artifact. ' +
          'Set HARNESS_OWNER and HARNESS_REPO, or deploy with Vercel Git integration ' +
          '(VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG), or set GITHUB_REPOSITORY. ' +
          'Knobs: HARNESS_OWNER, HARNESS_REPO, VERCEL_GIT_REPO_*, GITHUB_REPOSITORY.',
      );
    }
    owner = owner || 'btipling';
    repo = repo || 'invincible';
    source = 'fallback';
  }

  return { owner, repo, source };
}

/**
 * Paths that must produce a commit-matched `build-harness` artifact when changed
 * (mirrors `.github/workflows/build-harness.yml` path filters).
 * @param {string} path
 * @returns {boolean}
 */
export function isHarnessBuildPath(path) {
  if (typeof path !== 'string' || !path) return false;
  const p = path.replace(/\\/g, '/');
  if (p === 'native/ZIG_VERSION') return true;
  if (p === '.github/workflows/build-harness.yml') return true;
  if (p === 'native/harness' || p.startsWith('native/harness/')) return true;
  return false;
}

/**
 * @param {Iterable<string> | null | undefined} paths
 * @returns {boolean}
 */
export function commitTouchesHarnessBuild(paths) {
  if (!paths) return false;
  for (const p of paths) {
    if (isHarnessBuildPath(p)) return true;
  }
  return false;
}
