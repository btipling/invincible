import { describe, expect, it, vi } from 'vitest';
import { TOOL_RESULT_MAX_CHARS } from '../sandbox/config';
import type { SandboxClient } from '../sandbox/client';
import { createAgentTools } from './tools';

function mockClient(partial: Partial<SandboxClient>): SandboxClient {
  return {
    listDir: vi.fn(async () => ({ entries: [] })),
    readFile: vi.fn(async () => ({ content: '' })),
    writeFile: vi.fn(async () => ({ ok: true as const, bytes: 0 })),
    exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    ...partial,
  };
}

describe('createAgentTools', () => {
  it('soft-fails on client error without throwing', async () => {
    const client = mockClient({
      listDir: vi.fn(async () => {
        throw new Error('boom secret-token-value');
      }),
    });
    const tools = createAgentTools({
      client,
      secrets: ['secret-token-value'],
    });
    const out = await tools.list_dir.execute!({ path: '.' }, {
      toolCallId: '1',
      messages: [],
    } as never);
    expect(typeof out).toBe('string');
    expect(out as string).toMatch(/^ERROR list_dir:/);
    expect(out as string).not.toContain('secret-token-value');
    expect(out as string).toContain('[redacted]');
  });

  it('includes timed out exec in result text', async () => {
    const client = mockClient({
      exec: vi.fn(async () => ({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
      })),
    });
    const tools = createAgentTools({ client });
    const out = (await tools.exec.execute!(
      { cmd: 'sleep', args: ['99'], timeoutMs: 100 },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out).toContain('TIMED_OUT');
  });

  it('truncates huge tool results', async () => {
    const big = 'x'.repeat(TOOL_RESULT_MAX_CHARS + 500);
    const client = mockClient({
      readFile: vi.fn(async () => ({ content: big })),
    });
    const tools = createAgentTools({ client });
    const out = (await tools.read_file.execute!(
      { path: 'big.txt' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS + 20);
    expect(out).toContain('…[truncated]');
  });

  it('list_dir success path', async () => {
    const client = mockClient({
      listDir: vi.fn(async () => ({
        entries: [
          { name: 'a.ts', type: 'file' as const },
          { name: 'b', type: 'dir' as const },
        ],
      })),
    });
    const tools = createAgentTools({ client });
    const out = (await tools.list_dir.execute!(
      { path: '.' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(out).toContain('2 entries');
    expect(out).toContain('a.ts');
  });
});

describe('createAgentTools permissions', () => {
  it('read-only denies write_file and exec without calling client', async () => {
    const writeFile = vi.fn(async () => ({ ok: true as const, bytes: 1 }));
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const listDir = vi.fn(async () => ({ entries: [{ name: 'a', type: 'file' as const }] }));
    const client = mockClient({ writeFile, exec, listDir });
    const tools = createAgentTools({
      client,
      permissions: { canRead: true, canWrite: false },
    });

    const w = (await tools.write_file.execute!(
      { path: 'x.txt', content: 'hi' },
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(w).toMatch(/permission denied \(need write\)/);
    expect(writeFile).not.toHaveBeenCalled();

    const e = (await tools.exec.execute!(
      { cmd: 'true' },
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(e).toMatch(/permission denied \(need write\)/);
    expect(exec).not.toHaveBeenCalled();

    const l = (await tools.list_dir.execute!(
      { path: '.' },
      { toolCallId: '3', messages: [] } as never,
    )) as string;
    expect(l).toContain('1 entries');
    expect(listDir).toHaveBeenCalled();
  });

  it('write-only effective caller allows all when canRead true canWrite true', async () => {
    // Caller passes *effective* flags (write⇒read already applied)
    const client = mockClient({
      listDir: vi.fn(async () => ({ entries: [] })),
      writeFile: vi.fn(async () => ({ ok: true as const, bytes: 2 })),
    });
    const tools = createAgentTools({
      client,
      permissions: { canRead: true, canWrite: true },
    });
    const l = (await tools.list_dir.execute!(
      {},
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(l).toContain('0 entries');
    const w = (await tools.write_file.execute!(
      { path: 'a', content: 'b' },
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(w).toContain('ok bytes=2');
  });

  it('no-read denies list/read', async () => {
    const listDir = vi.fn(async () => ({ entries: [] }));
    const readFile = vi.fn(async () => ({ content: 'x' }));
    const client = mockClient({ listDir, readFile });
    const tools = createAgentTools({
      client,
      permissions: { canRead: false, canWrite: false },
    });
    const l = (await tools.list_dir.execute!(
      {},
      { toolCallId: '1', messages: [] } as never,
    )) as string;
    expect(l).toMatch(/permission denied \(need read\)/);
    expect(listDir).not.toHaveBeenCalled();
    const r = (await tools.read_file.execute!(
      { path: 'a' },
      { toolCallId: '2', messages: [] } as never,
    )) as string;
    expect(r).toMatch(/permission denied \(need read\)/);
    expect(readFile).not.toHaveBeenCalled();
  });
});
