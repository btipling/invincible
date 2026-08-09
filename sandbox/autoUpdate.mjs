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
 * @param {Record<string, string | undefined>} env
 */
export function resolveAutoUpdateConfig(env = process.env) {
  const raw = env.SANDBOX_AUTO_UPDATE?.trim();
  const enabled = raw != null && ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
  const gitDir = env.SANDBOX_GIT_DIR?.trim() || '';
  const ref = env.SANDBOX_GIT_REF?.trim() || 'origin/main';
  const intervalRaw = Number(env.SANDBOX_UPDATE_CHECK_MS);
  const intervalMs =
    env.SANDBOX_UPDATE_CHECK_MS != null &&
    Number.isFinite(intervalRaw) &&
    intervalRaw > 0
      ? Math.floor(intervalRaw)
      : 60_000;
  return {
    enabled,
    gitDir: enabled && gitDir ? gitDir : null,
    ref,
    intervalMs,
  };
}

/**
 * Attempt a fast-forward update of `gitDir` to `ref`. Returns `{ updated }` only
 * when HEAD actually advanced. Fails closed on divergent local work or git errors
 * (caller stays up and keeps serving 426 when a client expects newer code).
 * @param {{ enabled: boolean, gitDir: string | null, ref: string }} cfg
 * @returns {Promise<{ updated: boolean, reason?: string, detail?: string }>}
 */
export async function attemptAutoUpdate(cfg) {
  if (!cfg || cfg.enabled !== true) return { updated: false, reason: 'disabled' };
  if (!cfg.gitDir) return { updated: false, reason: 'no-git-dir' };

  const fetchRes = await runGit(cfg.gitDir, ['fetch', '--quiet', '--prune', 'origin']);
  if (!fetchRes.ok) {
    return { updated: false, reason: 'fetch-failed', detail: fetchRes.err.trim() || undefined };
  }

  const before = await runGit(cfg.gitDir, ['rev-parse', 'HEAD']);
  const revBefore = before.ok ? before.out.trim() : null;

  const mergeRes = await runGit(cfg.gitDir, ['merge', '--ff-only', cfg.ref]);
  if (!mergeRes.ok) {
    return { updated: false, reason: 'merge-failed', detail: mergeRes.err.trim() || undefined };
  }

  const after = await runGit(cfg.gitDir, ['rev-parse', 'HEAD']);
  const revAfter = after.ok ? after.out.trim() : null;
  const advanced = Boolean(revBefore && revAfter && revBefore !== revAfter);
  return { updated: advanced };
}
