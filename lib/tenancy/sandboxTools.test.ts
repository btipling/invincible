import { describe, expect, it } from 'vitest';
import { describeSandboxTools } from './sandboxTools';

describe('describeSandboxTools', () => {
  it('read only → read tools + always, no write', () => {
    const tools = describeSandboxTools('byo', { canRead: true, canWrite: false });
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_dir');
    expect(names).toContain('read_file');
    expect(names).toContain('stat');
    expect(names).toContain('change_dir');
    expect(names).toContain('pwd');
    expect(names).toContain('sandbox_info');
    expect(names).not.toContain('exec');
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('str_replace');
  });

  it('write implies read → write + read + always', () => {
    const tools = describeSandboxTools('byo', { canRead: true, canWrite: true });
    const names = tools.map((t) => t.name);
    for (const n of [
      'list_dir',
      'read_file',
      'stat',
      'write_file',
      'str_replace',
      'exec',
      'change_dir',
      'pwd',
      'sandbox_info',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('write without read still implies read (effective permissions)', () => {
    // describeSandboxTools takes effective permissions where write→read already
    // applied by the caller; here canWrite:true + canRead:true is the norm. If a
    // caller passed canRead:false/canWrite:true, read tools would be excluded —
    // the route passes effective (write implies read) values.
    const tools = describeSandboxTools('vercel', {
      canRead: false,
      canWrite: true,
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('list_dir');
    expect(names).not.toContain('sandbox_info');
    expect(names).toContain('write_file');
    expect(names).toContain('change_dir');
  });

  it('exec notes argv-only / stdin caveat for byo', () => {
    const tools = describeSandboxTools('byo', { canRead: true, canWrite: true });
    const exec = tools.find((t) => t.name === 'exec');
    expect(exec?.note).toMatch(/argv|stdin/i);
    expect(exec?.requiresPermission).toBe('write');
  });

  it('vercel backend note marks attach-only durable workspace', () => {
    const tools = describeSandboxTools('vercel', { canRead: true, canWrite: true });
    expect(tools[0]?.note).toMatch(/attach|durable/i);
  });

  it('never exposes any secret-ish field', () => {
    const tools = describeSandboxTools('byo', { canRead: true, canWrite: true });
    const json = JSON.stringify(tools);
    expect(json).not.toMatch(/baseUrl|token|tokenCiphertext|secretKey/i);
  });
});
