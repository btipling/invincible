/**
 * Opt-in sandbox daemon self-update + self-restart.
 *
 * When `SANDBOX_AUTO_UPDATE=1` and `SANDBOX_GIT_DIR` points at the repo checkout,
 * the daemon can fast-forward its git state and then exit so the supervisor
 * (systemd `Restart=always`) loads the new `sandbox/*.mjs`. Everything here is
 * **argv-only** (no shell) and fails closed: ff-only merges only, no force/reset,
 * and it never injects `SANDBOX_TOKEN` into unrelated processes.
 */
import { spawn } from 'node:child_process';

/** Git subprocess environment — minimal; never leaks SANDBOX_TOKEN. */
function gitEnv() {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    NO_COLOR: '1',
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  };
}

/** Run git argv-only; resolves on close; never throws. */
function runGit(dir, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd: dir,
        env: gitEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, out: '', err: String(err && err.message ? err.message : err) });
      return;
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      err += String(d);
    });
    child.on('error', (e) => {
      resolve({ ok: false, out, err: String(e && e.message ? e.message : e) });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, out, err });
    });
  });
}

/**
 * Resolve auto-update config from env.
 * Disabled by default (static/binary/BYO hosts stay free of git requirements).
 * `SANDBOX_UPDATE_CHECK_MS: 0` disables the background timer (header-only trigger).
 *
 * Interval semantics:
 *   unset / empty      → 60_000 (default background check)
 *   ">0"               → Math.floor(value) as the interval
 *   "0"                → 0 (disable the background timer; header-trigger only)
 *   negative / non-num → invalid → fail closed to 60_000 (never a silent 0)
 * @param {Record<string, string | undefined>} env
 */
export function resolveAutoUpdateConfig(env = process.env) {
  const raw = env.SANDBOX_AUTO_UPDATE?.trim();
  const enabled = raw != null && ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
  const gitDir = env.SANDBOX_GIT_DIR?.trim() || '';
  const ref = env.SANDBOX_GIT_REF?.trim() || 'origin/main';
  const rawMs = env.SANDBOX_UPDATE_CHECK_MS?.trim();
  let intervalMs = 60_000;
  if (rawMs != null && rawMs !== '') {
    const parsed = Number(rawMs);
    if (Number.isFinite(parsed) && parsed > 0) {
      intervalMs = Math.floor(parsed);
    } else if (parsed === 0) {
      intervalMs = 0;
    }
    // else: negative or non-numeric → invalid → fail closed to the default.
  }
  return {
    enabled,
    gitDir: enabled && gitDir ? gitDir : null,
    ref,
    intervalMs,
  };
}

/**
 * Single-flight latch so the background timer and a request-triggered `onOutOfDate`
 * (or concurrent supervisor restarts) can never stampede parallel `git fetch` /
 * `git merge` runs. Re-entrant callers get a fail-closed `in-progress` no-op.
 */
let updateInFlight = false;

/**
 * Attempt a fast-forward update of `gitDir` to `ref`. Returns `{ updated }` only
 * when HEAD actually advanced. Fails closed on divergent local work, a **dirty**
 * working tree, or git errors (caller stays up and keeps serving 426 when a
 * client expects newer code). Never merges over uncommitted operator changes.
 * @param {{ enabled: boolean, gitDir: string | null, ref: string }} cfg
 * @returns {Promise<{ updated: boolean, reason?: string, detail?: string }>}
 */
export async function attemptAutoUpdate(cfg) {
  if (!cfg || cfg.enabled !== true) return { updated: false, reason: 'disabled' };
  if (!cfg.gitDir) return { updated: false, reason: 'no-git-dir' };

  // Single-flight: if an update is already running (timer + onOutOfDate fire at
  // once), do not start a second concurrently — fail closed, never crash-loop.
  if (updateInFlight) {
    return { updated: false, reason: 'in-progress' };
  }
  updateInFlight = true;
  try {
    // Fail closed on a dirty working tree *before* touching the repo. `git status
    // --porcelain` is argv-only and outputs one line per unclean path (untracked
    // included); we never fetch/merge/exit over uncommitted operator changes.
    const statusRes = await runGit(cfg.gitDir, ['status', '--porcelain']);
    if (!statusRes.ok) {
      return {
        updated: false,
        reason: 'status-check-failed',
        detail: statusRes.err.trim() || undefined,
      };
    }
    if (statusRes.out.trim() !== '') {
      console.warn(
        '[sandbox] auto-update skipped: working tree is dirty; refusing to merge/restart over local changes',
      );
      return { updated: false, reason: 'dirty' };
    }

    const fetchRes = await runGit(cfg.gitDir, ['fetch', '--quiet', '--prune', 'origin']);
    if (!fetchRes.ok) {
      return {
        updated: false,
        reason: 'fetch-failed',
        detail: fetchRes.err.trim() || undefined,
      };
    }

    const before = await runGit(cfg.gitDir, ['rev-parse', 'HEAD']);
    const revBefore = before.ok ? before.out.trim() : null;

    // `--` terminates option parsing so a dash-prefixed `SANDBOX_GIT_REF` can
    // never be interpreted as a git flag. ff-only only (no force/reset).
    const mergeRes = await runGit(cfg.gitDir, ['merge', '--ff-only', '--', cfg.ref]);
    if (!mergeRes.ok) {
      return {
        updated: false,
        reason: 'merge-failed',
        detail: mergeRes.err.trim() || undefined,
      };
    }

    const after = await runGit(cfg.gitDir, ['rev-parse', 'HEAD']);
    const revAfter = after.ok ? after.out.trim() : null;
    const advanced = Boolean(revBefore && revAfter && revBefore !== revAfter);
    return { updated: advanced };
  } finally {
    updateInFlight = false;
  }
}
