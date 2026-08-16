import { describe, expect, it } from 'vitest';
import {
  isHarnessRequire,
  parseGithubRepository,
  resolveHarnessRepo,
} from './harnessRepo.mjs';

describe('parseGithubRepository', () => {
  it('parses org/name', () => {
    expect(parseGithubRepository('org/r')).toEqual({ owner: 'org', repo: 'r' });
  });

  it('returns nulls for invalid or empty', () => {
    expect(parseGithubRepository('')).toEqual({ owner: null, repo: null });
    expect(parseGithubRepository(undefined)).toEqual({ owner: null, repo: null });
    expect(parseGithubRepository('bad')).toEqual({ owner: null, repo: null });
    expect(parseGithubRepository('/only')).toEqual({ owner: null, repo: null });
    expect(parseGithubRepository('only/')).toEqual({ owner: null, repo: null });
  });

  it('uses first two segments only', () => {
    expect(parseGithubRepository('org/name/extra')).toEqual({
      owner: 'org',
      repo: 'name',
    });
  });
});

describe('isHarnessRequire', () => {
  it('is true on Vercel unless HARNESS_REQUIRE=0', () => {
    expect(isHarnessRequire({ VERCEL: '1' })).toBe(true);
    expect(isHarnessRequire({ VERCEL: 'true' })).toBe(true);
    expect(isHarnessRequire({ VERCEL: '1', HARNESS_REQUIRE: '0' })).toBe(false);
  });

  it('is true when HARNESS_REQUIRE=1 off Vercel', () => {
    expect(isHarnessRequire({ HARNESS_REQUIRE: '1' })).toBe(true);
  });

  it('is false by default off Vercel', () => {
    expect(isHarnessRequire({})).toBe(false);
  });
});

describe('resolveHarnessRepo', () => {
  it('uses Vercel git env only → alice/my-invincible, source vercel-git', () => {
    expect(
      resolveHarnessRepo({
        VERCEL_GIT_REPO_OWNER: 'alice',
        VERCEL_GIT_REPO_SLUG: 'my-invincible',
      }),
    ).toEqual({
      owner: 'alice',
      repo: 'my-invincible',
      source: 'vercel-git',
    });
  });

  it('HARNESS_* overrides Vercel git → source explicit', () => {
    expect(
      resolveHarnessRepo({
        HARNESS_OWNER: 'upstream',
        HARNESS_REPO: 'harness-src',
        VERCEL_GIT_REPO_OWNER: 'alice',
        VERCEL_GIT_REPO_SLUG: 'my-invincible',
      }),
    ).toEqual({
      owner: 'upstream',
      repo: 'harness-src',
      source: 'explicit',
    });
  });

  it('GITHUB_REPOSITORY only → source github-repository', () => {
    expect(resolveHarnessRepo({ GITHUB_REPOSITORY: 'org/r' })).toEqual({
      owner: 'org',
      repo: 'r',
      source: 'github-repository',
    });
  });

  it('Vercel + missing all → throws', () => {
    expect(() => resolveHarnessRepo({ VERCEL: '1' })).toThrow(
      /Cannot resolve GitHub owner\/repo/,
    );
  });

  it('local missing all → fallback + source fallback', () => {
    expect(resolveHarnessRepo({})).toEqual({
      owner: 'btipling',
      repo: 'invincible',
      source: 'fallback',
    });
  });

  it('HARNESS_REQUIRE=1 local missing → throws', () => {
    expect(() => resolveHarnessRepo({ HARNESS_REQUIRE: '1' })).toThrow(
      /Cannot resolve GitHub owner\/repo/,
    );
  });

  it('invalid GITHUB_REPOSITORY → fallback off require', () => {
    expect(resolveHarnessRepo({ GITHUB_REPOSITORY: 'bad' })).toEqual({
      owner: 'btipling',
      repo: 'invincible',
      source: 'fallback',
    });
  });

  it('invalid GITHUB_REPOSITORY on Vercel → throws', () => {
    expect(() =>
      resolveHarnessRepo({ VERCEL: '1', GITHUB_REPOSITORY: 'bad' }),
    ).toThrow(/Cannot resolve GitHub owner\/repo/);
  });

  it('whitespace-only HARNESS_OWNER is ignored', () => {
    expect(
      resolveHarnessRepo({
        HARNESS_OWNER: '   ',
        VERCEL_GIT_REPO_OWNER: 'alice',
        VERCEL_GIT_REPO_SLUG: 'my-invincible',
      }),
    ).toEqual({
      owner: 'alice',
      repo: 'my-invincible',
      source: 'vercel-git',
    });
  });

  it('mixed HARNESS_OWNER + VERCEL slug → source explicit', () => {
    expect(
      resolveHarnessRepo({
        HARNESS_OWNER: 'upstream',
        VERCEL_GIT_REPO_SLUG: 'fork-app',
      }),
    ).toEqual({
      owner: 'upstream',
      repo: 'fork-app',
      source: 'explicit',
    });
  });

  it('partial resolve on Vercel with only owner → throws', () => {
    expect(() =>
      resolveHarnessRepo({
        VERCEL: '1',
        VERCEL_GIT_REPO_OWNER: 'alice',
      }),
    ).toThrow(/Cannot resolve GitHub owner\/repo/);
  });

  it('partial owner only off require → fills invincible, source fallback', () => {
    expect(resolveHarnessRepo({ HARNESS_OWNER: 'acme' })).toEqual({
      owner: 'acme',
      repo: 'invincible',
      source: 'fallback',
    });
  });

  it('partial repo only off require → fills btipling, source fallback', () => {
    expect(resolveHarnessRepo({ HARNESS_REPO: 'my-app' })).toEqual({
      owner: 'btipling',
      repo: 'my-app',
      source: 'fallback',
    });
  });
});

import {
  commitTouchesHarnessBuild,
  isHarnessBuildPath,
  isShippableHarnessArtifact,
  pickLatestShippableHarnessArtifact,
} from './harnessRepo.mjs';

describe('isHarnessBuildPath / commitTouchesHarnessBuild', () => {
  it('matches build-harness path filters', () => {
    expect(isHarnessBuildPath('native/harness/src/rich/parse.zig')).toBe(true);
    expect(isHarnessBuildPath('native/harness')).toBe(true);
    expect(isHarnessBuildPath('native/ZIG_VERSION')).toBe(true);
    expect(isHarnessBuildPath('.github/workflows/build-harness.yml')).toBe(true);
    expect(isHarnessBuildPath('docs/harness-limits.md')).toBe(false);
    expect(isHarnessBuildPath('scripts/fetch-harness-artifact.mjs')).toBe(false);
    expect(isHarnessBuildPath('')).toBe(false);
  });

  it('commitTouchesHarnessBuild any-path', () => {
    expect(
      commitTouchesHarnessBuild([
        'docs/harness-limits.md',
        'native/harness/src/rich/link_url.zig',
      ]),
    ).toBe(true);
    expect(commitTouchesHarnessBuild(['docs/harness-limits.md', 'README.md'])).toBe(
      false,
    );
    expect(commitTouchesHarnessBuild(null)).toBe(false);
    expect(commitTouchesHarnessBuild([])).toBe(false);
  });
});

describe('isShippableHarnessArtifact / pickLatestShippableHarnessArtifact', () => {
  const main = {
    name: 'harness-wasm',
    expired: false,
    id: 1,
    workflow_run: { head_branch: 'main', head_sha: 'aaa' },
  };
  const pr = {
    name: 'harness-wasm',
    expired: false,
    id: 2,
    workflow_run: { head_branch: 'plan/composer-hug-status-bar-flush', head_sha: 'bbb' },
  };

  it('accepts only non-expired harness-wasm from main', () => {
    expect(isShippableHarnessArtifact(main)).toBe(true);
    expect(isShippableHarnessArtifact(pr)).toBe(false);
    expect(isShippableHarnessArtifact({ ...main, expired: true })).toBe(false);
    expect(isShippableHarnessArtifact({ ...main, name: 'harness-wasm-pr-584' })).toBe(
      false,
    );
    expect(isShippableHarnessArtifact({ ...main, workflow_run: undefined })).toBe(
      false,
    );
    expect(isShippableHarnessArtifact(null)).toBe(false);
  });

  it('picks newest main and skips a newer PR head', () => {
    expect(pickLatestShippableHarnessArtifact([pr, main])).toEqual(main);
    expect(pickLatestShippableHarnessArtifact([pr])).toBe(null);
    expect(pickLatestShippableHarnessArtifact([])).toBe(null);
    expect(pickLatestShippableHarnessArtifact(null)).toBe(null);
  });
});

