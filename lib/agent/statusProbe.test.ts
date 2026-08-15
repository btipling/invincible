import { describe, expect, it } from 'vitest';
import type { SandboxClient } from '../sandbox/client';
import type { ExecResult } from '../sandbox/types';
import {
  formatGitStatusSlot,
  probeGitStatus,
  STATUS_GIT_PROBE_OUT_MAX_BYTES,
} from './statusProbe';

function fakeClient(
  responses: Array<{ exitCode: number | null; stdout: string; stderr?: string }>,
  opts: { cwdAssert?: string } = {},
): { client: SandboxClient; calls: Array<{ args?: string[]; cwd?: string }> } {
  let i = 0;
  const calls: Array<{ args?: string[]; cwd?: string }> = [];
  const client: SandboxClient = {
    listDir: async () => ({ entries: [] }),
    readFile: async () => ({ content: '' }),
    writeFile: async () => ({ ok: true, bytes: 0 }),
    strReplace: async () => ({ ok: true, path: '', replacements: 0, bytes: 0 }),
    stat: async () => ({ path: '', type: 'other', size: 0 }),
    exec: async (body) => {
      calls.push({ args: body.args, cwd: body.cwd });
      if (opts.cwdAssert !== undefined && body.cwd !== opts.cwdAssert) {
        throw new Error(`cwd ${body.cwd} !== ${opts.cwdAssert}`);
      }
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr ?? '',
        ok: r.exitCode === 0,
      } as ExecResult;
    },
  };
  return { client, calls };
}

describe('statusProbe', () => {
  it('parses branch + short SHA (clean tree)', async () => {
    const { client, calls } = fakeClient([
      { exitCode: 0, stdout: 'main\n' },
      { exitCode: 0, stdout: 'a1b2c3d\n' },
      { exitCode: 0, stdout: '' },
    ]);
    const res = await probeGitStatus(client);
    expect(res).toEqual({ branch: 'main', sha: 'a1b2c3d' });
    expect(res.dirty).toBeUndefined();
    expect(calls.length).toBe(3);
    // Every probe invocation runs at the bind workspace root.
    for (const c of calls) expect(c.cwd).toBe('.');
  });

  it('marks dirty when porcelain is non-empty', async () => {
    const { client } = fakeClient([
      { exitCode: 0, stdout: 'main\n' },
      { exitCode: 0, stdout: 'a1b2c3d\n' },
      { exitCode: 0, stdout: ' M file.ts\n' },
    ]);
    const res = await probeGitStatus(client);
    expect(res).toEqual({ branch: 'main', sha: 'a1b2c3d', dirty: true });
  });

  it('fails soft to empty on non-git / dead bind', async () => {
    // git not a repo → non-zero exits; a dead/erroring client → catch.
    const { client } = fakeClient([
      { exitCode: 128, stdout: 'fatal: not a git repository\n' },
      { exitCode: 128, stdout: '' },
      { exitCode: 128, stdout: '' },
    ]);
    expect(await probeGitStatus(client)).toEqual({});
  });

  it('fails soft when client.exec throws (daemon down/out-of-date)', async () => {
    const client: SandboxClient = {
      listDir: async () => ({ entries: [] }),
      readFile: async () => ({ content: '' }),
      writeFile: async () => ({ ok: true, bytes: 0 }),
      strReplace: async () => ({ ok: true, path: '', replacements: 0, bytes: 0 }),
      stat: async () => ({ path: '', type: 'other', size: 0 }),
      exec: async () => {
        throw new Error('sandbox unavailable');
      },
    };
    expect(await probeGitStatus(client)).toEqual({});
  });

  it('truncates git stdout to the cap', async () => {
    const args = ['rev-parse', '--short', 'HEAD'];
    const longOut = 'x'.repeat(STATUS_GIT_PROBE_OUT_MAX_BYTES + 100);
    // Focus on the SHA truncation path via a lone long stdout:
    const { client } = fakeClient([
      { exitCode: 0, stdout: 'main\n' },
      { exitCode: 0, stdout: `${longOut}\n` },
      { exitCode: 0, stdout: '' },
    ]);
    const res = await probeGitStatus(client);
    void args;
    // SHA is truncated to the cap and trimmed.
    const shaLen = (res.sha ?? '').length;
    expect(shaLen).toBeLessThanOrEqual(STATUS_GIT_PROBE_OUT_MAX_BYTES);
  });

  it('probe runs at the bind workspace root, never a caller cwd', async () => {
    const { client, calls } = fakeClient(
      [
        { exitCode: 0, stdout: 'feat/x\n' },
        { exitCode: 0, stdout: 'bb00ff\n' },
        { exitCode: 0, stdout: '' },
      ],
      { cwdAssert: '.' },
    );
    const res = await probeGitStatus(client);
    expect(res).toEqual({ branch: 'feat/x', sha: 'bb00ff' });
    expect(calls.every((c) => c.cwd === '.')).toBe(true);
  });

  it('detached HEAD is not surfaced as a branch', async () => {
    const { client } = fakeClient([
      { exitCode: 0, stdout: 'HEAD\n' },
      { exitCode: 0, stdout: 'a1b2c3d\n' },
      { exitCode: 0, stdout: '' },
    ]);
    expect(await probeGitStatus(client)).toEqual({ sha: 'a1b2c3d' });
  });
});

describe('formatGitStatusSlot', () => {
  it('formats branch@sha clean', () => {
    expect(
      formatGitStatusSlot({ branch: 'main', sha: 'a1b2c3d' }),
    ).toBe('main@a1b2c3d');
  });

  it('appends * when dirty', () => {
    expect(
      formatGitStatusSlot({ branch: 'main', sha: 'a1b2c3d', dirty: true }),
    ).toBe('main@a1b2c3d*');
  });

  it('returns empty when nothing probed', () => {
    expect(formatGitStatusSlot({})).toBe('');
  });
});
