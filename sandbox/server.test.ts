import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INVINCIBLE_SANDBOX_PROTOCOL,
  INVINCIBLE_SANDBOX_DAEMON_VERSION,
  SANDBOX_EXPECTED_DAEMON_VERSION_HEADER,
  SANDBOX_DAEMON_OUT_OF_DATE_CODE,
} from './constants.mjs';
import { createSandboxServer } from './createServer.mjs';

async function listen(
  server: http.Server,
): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    base,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('sandbox HTTP server', () => {
  let tmp: string;
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  });

  async function start(token = 'test-token-secret') {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-http-'));
    const server = createSandboxServer({ token, workspace: tmp });
    const h = await listen(server);
    close = h.close;
    return { base: h.base, token, workspace: tmp };
  }

  it('GET /health returns version without auth', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: number;
      daemonVersion: number;
    };
    expect(body).toEqual({
      ok: true,
      version: INVINCIBLE_SANDBOX_PROTOCOL,
      daemonVersion: INVINCIBLE_SANDBOX_DAEMON_VERSION,
    });
  });

  it('GET /health works without auth and exposes daemonVersion', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      version: INVINCIBLE_SANDBOX_PROTOCOL,
      daemonVersion: INVINCIBLE_SANDBOX_DAEMON_VERSION,
    });
    void token;
  });

  it('daemon gate: header expected > running → 426, tool not executed', async () => {
    const { base, token } = await start();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      [SANDBOX_EXPECTED_DAEMON_VERSION_HEADER]: String(
        INVINCIBLE_SANDBOX_DAEMON_VERSION + 1,
      ),
    };
    const res = await fetch(`${base}/v1/list_dir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '.' }),
    });
    expect(res.status).toBe(426);
    const body = (await res.json()) as {
      error: string;
      code: string;
      running: number;
      expected: number;
    };
    expect(body.code).toBe(SANDBOX_DAEMON_OUT_OF_DATE_CODE);
    expect(body.running).toBe(INVINCIBLE_SANDBOX_DAEMON_VERSION);
    expect(body.expected).toBe(INVINCIBLE_SANDBOX_DAEMON_VERSION + 1);
    expect(body.error).toMatch(/Sandbox daemon out of date \(running \d+, expected \d+\)/);
  });

  it('daemon gate: header expected == running → tool runs', async () => {
    const { base, token } = await start();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      [SANDBOX_EXPECTED_DAEMON_VERSION_HEADER]: String(
        INVINCIBLE_SANDBOX_DAEMON_VERSION,
      ),
    };
    const res = await fetch(`${base}/v1/list_dir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '.' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('daemon gate: header expected < running (fork ahead) → tool runs', async () => {
    const { base, token } = await start();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      [SANDBOX_EXPECTED_DAEMON_VERSION_HEADER]: '0',
    };
    const res = await fetch(`${base}/v1/list_dir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: '.' }),
    });
    expect(res.status).toBe(200);
  });

  it('daemon gate: no header → tool runs (older clients / curl compat)', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/v1/list_dir`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path: '.' }),
    });
    expect(res.status).toBe(200);
  });

  it('daemon gate: malformed header → tool runs (treated as absent)', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/v1/list_dir`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        [SANDBOX_EXPECTED_DAEMON_VERSION_HEADER]: 'not-a-number',
      },
      body: JSON.stringify({ path: '.' }),
    });
    expect(res.status).toBe(200);
  });

  it('daemon gate: 401 wins before the version gate', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/list_dir`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong',
        [SANDBOX_EXPECTED_DAEMON_VERSION_HEADER]: String(
          INVINCIBLE_SANDBOX_DAEMON_VERSION + 5,
        ),
      },
      body: JSON.stringify({ path: '.' }),
    });
    expect(res.status).toBe(401);
  });

  it('daemon gate: onOutOfDate hook fires when expected > running', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-http-'));
    const calls: Array<{ running: number; expected: number }> = [];
    const server = createSandboxServer({
      token: 't',
      workspace: tmp,
      onOutOfDate: (info) => calls.push(info),
    });
    const h = await listen(server);
    close = h.close;
    const res = await fetch(`${h.base}/v1/list_dir`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
        [SANDBOX_EXPECTED_DAEMON_VERSION_HEADER]: String(
          INVINCIBLE_SANDBOX_DAEMON_VERSION + 1,
        ),
      },
      body: JSON.stringify({ path: '.' }),
    });
    expect(res.status).toBe(426);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      running: INVINCIBLE_SANDBOX_DAEMON_VERSION,
      expected: INVINCIBLE_SANDBOX_DAEMON_VERSION + 1,
    });
  });

  it('missing bearer → 401', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/list_dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '.' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Unauthorized');
    expect(JSON.stringify(body)).not.toContain('test-token');
  });

  it('wrong bearer → 401', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/v1/list_dir`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ path: '.' }),
    });
    expect(res.status).toBe(401);
  });

  it('authorized list/write/read/exec work', async () => {
    const { base, token } = await start();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };

    const write = await fetch(`${base}/v1/write_file`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'note.txt', content: 'hi' }),
    });
    expect(write.status).toBe(200);
    const writeBody = await write.json();
    expect(writeBody).toMatchObject({ ok: true, bytes: 2, size: 2 });
    expect(Number.isInteger(writeBody.mtimeMs)).toBe(true);

    const read = await fetch(`${base}/v1/read_file`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'note.txt' }),
    });
    expect(read.status).toBe(200);
    const readBody = await read.json();
    expect(readBody).toMatchObject({ content: 'hi', size: 2 });
    expect(Number.isInteger(readBody.mtimeMs)).toBe(true);

    const list = await fetch(`${base}/v1/list_dir`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      entries: { name: string; type: string }[];
    };
    expect(listBody.entries).toContainEqual({ name: 'note.txt', type: 'file' });

    const exec = await fetch(`${base}/v1/exec`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cmd: process.execPath,
        args: ['-e', 'process.stdout.write("1")'],
        timeoutMs: 5000,
      }),
    });
    expect(exec.status).toBe(200);
    const execBody = (await exec.json()) as {
      exitCode: number;
      stdout: string;
    };
    expect(execBody.exitCode).toBe(0);
    expect(execBody.stdout).toBe('1');
  });

  it('jail escape via API returns 400', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/v1/read_file`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ path: '../secrets' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/jail|escape/i);
  });

  it('POST /v1/exec feeds stdin through HTTP', async () => {
    const { base, token } = await start();
    const payload = 'hello-from-http-stdin\n';
    const res = await fetch(`${base}/v1/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        cmd: process.execPath,
        args: [
          '-e',
          'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{process.stdout.write(s); process.exit(0);});',
        ],
        stdin: payload,
        timeoutMs: 5000,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toBe(payload);
  });

  it('POST /v1/exec accepts heredoc alias over HTTP', async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/v1/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        cmd: process.execPath,
        args: [
          '-e',
          'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{process.stdout.write(s); process.exit(0);});',
        ],
        heredoc: 'via-http-heredoc',
        timeoutMs: 5000,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exitCode: number; stdout: string };
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toBe('via-http-heredoc');
  });

  it('POST /v1/stat returns file metadata; 404 missing; 400 empty; jail 400', async () => {
    const { base, token } = await start();
    const write = await fetch(`${base}/v1/write_file`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: 's.txt', content: 'ab' }),
    });
    expect(write.status).toBe(200);

    const st = await fetch(`${base}/v1/stat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: 's.txt' }),
    });
    expect(st.status).toBe(200);
    const body = await st.json();
    expect(body).toMatchObject({ path: 's.txt', type: 'file', size: 2 });
    expect(Number.isInteger(body.mtimeMs)).toBe(true);

    const missing = await fetch(`${base}/v1/stat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: 'nope.txt' }),
    });
    expect(missing.status).toBe(404);

    const empty = await fetch(`${base}/v1/stat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: '' }),
    });
    expect(empty.status).toBe(400);

    const jail = await fetch(`${base}/v1/stat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: '../etc/passwd' }),
    });
    expect(jail.status).toBe(400);
  });
});
