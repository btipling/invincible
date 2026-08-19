import { describe, expect, it } from 'vitest';
import {
  SANDBOX_INFO_ENV_MAX_KEYS,
  canonicalizePathEntry,
  envUnavailableReason,
  formatSandboxInfoEnv,
  parseEnvStdout,
  shouldOmitEnvKey,
} from './sandboxInfo';

const R = '/jail/ws';

describe('parseEnvStdout', () => {
  it('splits KEY=VALUE on the first equals', () => {
    expect(parseEnvStdout('FOO=bar=baz\nPATH=/usr/bin')).toEqual([
      ['FOO', 'bar=baz'],
      ['PATH', '/usr/bin'],
    ]);
  });

  it('skips malformed and empty lines', () => {
    expect(parseEnvStdout('=nope\nNOT A LINE\nOK=1\n')).toEqual([['OK', '1']]);
  });
});

describe('shouldOmitEnvKey', () => {
  it('omits known secret names and *_TOKEN / DEK prefixes', () => {
    expect(shouldOmitEnvKey('GITHUB_TOKEN')).toBe(true);
    expect(shouldOmitEnvKey('GH_TOKEN')).toBe(true);
    expect(shouldOmitEnvKey('SANDBOX_TOKEN')).toBe(true);
    expect(shouldOmitEnvKey('MY_SECRET')).toBe(true);
    expect(shouldOmitEnvKey('FOO_KEY')).toBe(true);
    expect(shouldOmitEnvKey('DEK_WRAP')).toBe(true);
    expect(shouldOmitEnvKey('DEK')).toBe(true);
    expect(shouldOmitEnvKey('AWS_ACCESS_KEY_ID')).toBe(true);
    expect(shouldOmitEnvKey('PATH')).toBe(false);
    expect(shouldOmitEnvKey('HOME')).toBe(false);
  });
});

describe('canonicalizePathEntry', () => {
  it('maps entries under R and keeps out-of-jail OS paths', () => {
    expect(canonicalizePathEntry(R, `${R}/node_modules/.bin`)).toBe(
      'node_modules/.bin',
    );
    expect(canonicalizePathEntry(R, R)).toBe('.');
    expect(canonicalizePathEntry(R, '/usr/bin')).toBe('/usr/bin');
    expect(canonicalizePathEntry(R, 'relative/bin')).toBe('relative/bin');
  });

  it('is a no-op when R is null', () => {
    expect(canonicalizePathEntry(null, `${R}/bin`)).toBe(`${R}/bin`);
  });
});

describe('formatSandboxInfoEnv', () => {
  it('rewrites PATH per colon entry — not the #468 joined-line corruption', () => {
    const { lines } = formatSandboxInfoEnv(
      `PATH=/usr/bin:${R}/node_modules/.bin\n`,
      R,
    );
    expect(lines).toEqual([
      'env.PATH=["/usr/bin","node_modules/.bin"]',
    ]);
    expect(lines[0]).not.toBe('env.PATH=/usr/bin:node_modules/.bin');
  });

  it('maps PWD/HOME under R and omits remaining host-absolute HOME', () => {
    const { lines } = formatSandboxInfoEnv(
      [`PWD=${R}`, `HOME=${R}/x`, 'OLDPWD=/home/foo', 'LANG=C'].join('\n'),
      R,
    );
    expect(lines).toContain('env.PWD=.');
    expect(lines).toContain('env.HOME=x');
    expect(lines).toContain('env.LANG=C');
    expect(lines.some((l) => l.startsWith('env.OLDPWD='))).toBe(false);
  });

  it('with R null: PATH raw, host-abs PWD omitted, no R field invented', () => {
    const { lines } = formatSandboxInfoEnv(
      `PATH=/usr/bin:${R}/bin\nPWD=${R}\nFOO=1\n`,
      null,
    );
    expect(lines).toContain(`env.PATH=["/usr/bin","${R}/bin"]`);
    expect(lines).toContain('env.FOO=1');
    expect(lines.some((l) => l.startsWith('env.PWD='))).toBe(false);
    expect(lines.join('\n')).toContain(R); // PATH entry may still include R
  });

  it('omits secret key names and values that contain secrets[]', () => {
    const secret = 'sk-super-secret';
    const { lines } = formatSandboxInfoEnv(
      ['GITHUB_TOKEN=ghp_x', `CUSTOM=pre-${secret}-post`, 'OK=1'].join('\n'),
      R,
      [secret],
    );
    expect(lines).toEqual(['env.OK=1']);
  });

  it('secret keys do not consume a cap slot', () => {
    const eligible = Array.from({ length: SANDBOX_INFO_ENV_MAX_KEYS + 1 }, (_, i) => {
      const n = String(i).padStart(4, '0');
      return `K${n}=v`;
    });
    const { lines, omittedByCap } = formatSandboxInfoEnv(
      ['GITHUB_TOKEN=ghp_x', 'DEK_WRAP=nope', ...eligible].join('\n'),
      R,
    );
    expect(lines).toHaveLength(SANDBOX_INFO_ENV_MAX_KEYS);
    expect(omittedByCap).toBe(1);
    expect(lines.some((l) => l.includes('GITHUB_TOKEN') || l.includes('DEK_WRAP'))).toBe(
      false,
    );
  });

  it('sorts keys and reports omittedByCap past SANDBOX_INFO_ENV_MAX_KEYS', () => {
    const keys = Array.from({ length: SANDBOX_INFO_ENV_MAX_KEYS + 3 }, (_, i) => {
      const n = String(i).padStart(4, '0');
      return `K${n}=v`;
    });
    const { lines, omittedByCap } = formatSandboxInfoEnv(keys.join('\n'), R);
    expect(lines).toHaveLength(SANDBOX_INFO_ENV_MAX_KEYS);
    expect(omittedByCap).toBe(3);
  });
});

describe('envUnavailableReason', () => {
  it('uses generic reasons without stdout', () => {
    expect(envUnavailableReason({ throwStatus: 504, threw: true })).toBe(
      'env: unavailable (timeout)',
    );
    expect(envUnavailableReason({ throwName: 'AbortError', threw: true })).toBe(
      'env: unavailable (timeout)',
    );
    expect(envUnavailableReason({ threw: true })).toBe('env: unavailable (error)');
    expect(envUnavailableReason({ timedOut: true })).toBe(
      'env: unavailable (timeout)',
    );
    expect(envUnavailableReason({ exitCode: 127 })).toBe(
      'env: unavailable (exit=127)',
    );
  });
});
