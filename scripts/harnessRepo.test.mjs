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
});
