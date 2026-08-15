/**
 * Phase 2 (#538/#540): server-side git branch/commit probe for the workspace
 * status bar git slot.
 *
 * This module is a **pure probe builder**: it never constructs I/O. It receives
 * the resolved-bind `SandboxClient` (from the DI composition root, via the
 * route) and runs bounded, argv-only, read-only git invocations AT THE BIND
 * WORKSPACE ROOT. di-gate requires this — no `createSandboxClient` /
 * `new RedisSessionStore` / `fetch` in the body.
 *
 * Contract (from plan #540, review-verified):
 * - Probe `cwd` is the **bind workspace root** (`'.'`), never the caller's
 *   logical session cwd — branch/SHA must reflect the repo, not a transient
 *   cwd/subdir.
 * - Read-only argv-only git only: `rev-parse --abbrev-ref HEAD` +
 *   `rev-parse --short HEAD` + `status --porcelain` (dirty detection). Never
 *   `git clean` / any mutating invocation.
 * - Non-git / empty-git-dir / exec error → `{}` (fail soft; git slot stays
 *   empty and other slots are unaffected).
 * - stdout is truncated to `STATUS_GIT_PROBE_OUT_MAX_BYTES` before being
 *   surfaced (bounded model/client wire, never a leaked daemon blob).
 */
import type { SandboxClient } from '../sandbox/client';

/** Bounded git stdout per probe invocation (new cap — plan #540 Caps table). */
export const STATUS_GIT_PROBE_OUT_MAX_BYTES = 512;

/** Result shape for a successful git probe. */
export type GitStatusProbeResult = {
  branch?: string;
  sha?: string;
  /**
   * true when the working tree is dirty (`status --porcelain` printed any
   * non-empty line). Absent (undefined) when clean / unprobed.
   */
  dirty?: boolean;
};

function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return text;
  const sliced = encoded.subarray(0, maxBytes);
  return Buffer.from(sliced).toString('utf8').replace(/\uFFFD.*$/u, '');
}

/**
 * Run one bounded, argv-only git command against the bind workspace root.
 * Fail-soft on any non-ok exec (non-repo, empty git dir, out-of-date daemon,
 * timeout, error) → `''`. Returns a raw (un-trimmed) stdout so callers can
 * detect "non-empty" (used for dirty); callers trim for branch/SHA.
 */
async function runGit(
  client: SandboxClient,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  try {
    const res = await client.exec(
      {
        cmd: 'git',
        // Bind workspace root — NEVER the caller's logical session cwd.
        cwd: '.',
        args,
        timeoutMs: 10_000,
      },
      { signal },
    );
    if (res.exitCode !== 0) return '';
    return truncateUtf8(res.stdout ?? '', STATUS_GIT_PROBE_OUT_MAX_BYTES);
  } catch {
    return '';
  }
}

/**
 * Probe the bind workspace root for git branch/SHA/dirty. Fail-soft `{}` on any
 * error. All `git` invocations are read-only and bounded.
 */
export async function probeGitStatus(
  client: SandboxClient,
  signal?: AbortSignal,
): Promise<GitStatusProbeResult> {
  const [branchRaw, shaRaw, porcelain] = await Promise.all([
    runGit(client, ['rev-parse', '--abbrev-ref', 'HEAD'], signal),
    runGit(client, ['rev-parse', '--short', 'HEAD'], signal),
    runGit(client, ['status', '--porcelain'], signal),
  ]);

  const res: GitStatusProbeResult = {};
  const branch = branchRaw.trim();
  if (branch) res.branch = branch;
  const sha = shaRaw.trim();
  if (sha) res.sha = sha;
  // Any non-empty porcelain output → dirty working tree. Trim to be safe.
  if (porcelain.trim().length > 0) res.dirty = true;
  // Reject the detached-HEAD pseudo-branch (not a useful status-bar branch).
  if (res.branch === 'HEAD') delete res.branch;
  return Object.keys(res).length ? res : {};
}

/** Format a git probe result into the status-slot value (`branch@sha[∗]`). */
export function formatGitStatusSlot(res: GitStatusProbeResult): string {
  if (!res.branch && !res.sha) return '';
  const branch = res.branch ?? '';
  const sha = res.sha ? `@${res.sha}` : '';
  return `${branch}${sha}${res.dirty ? '*' : ''}`;
}
