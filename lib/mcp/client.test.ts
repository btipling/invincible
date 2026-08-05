import { describe, expect, it, vi } from 'vitest';
import { buildUserMcpTools, probeUserMcpServer } from './client';
import { MAX_MCP_TOOLS } from './limits';
import type { UserMcpSecretRow } from '../tenancy/userMcpServers';

function secret(
  overrides: Partial<UserMcpSecretRow> & Pick<UserMcpSecretRow, 'id' | 'slug'>,
): UserMcpSecretRow {
  return {
    id: overrides.id,
    tenantId: 'ten-1',
    userId: 'user-1',
    name: overrides.name ?? overrides.slug,
    slug: overrides.slug,
    url: overrides.url ?? 'https://example.com/mcp',
    transport: 'http',
    authHeaderName: overrides.authHeaderName ?? null,
    authMode: overrides.apiKey ? 'api_key' : 'none',
    apiKey: overrides.apiKey ?? null,
    enabled: true,
    lastError: null,
  };
}

describe('buildUserMcpTools', () => {
  it('returns empty when no secrets', async () => {
    const result = await buildUserMcpTools('user-1', {
      loadSecrets: async () => ({ ok: true, value: [] }),
    });
    expect(result.tools).toEqual({});
    expect(result.secretsToRedact).toEqual([]);
    await result.close();
  });

  it('prefixes tools, first-wins collision, redacts secrets list', async () => {
    const close = vi.fn(async () => {});
    const createClient = vi.fn(async () => ({
      tools: async () => ({
        web_search: {
          description: 'search',
          execute: async () => 'ok',
        },
        'bad name!!': {
          description: 'x',
          execute: async () => 'ok',
        },
      }),
      close,
    }));

    const setLastError = vi.fn(async () => ({
      ok: true as const,
      value: { id: 's1' },
    }));

    const result = await buildUserMcpTools('user-1', {
      createClient: createClient as never,
      setLastError: setLastError as never,
      loadSecrets: async () => ({
        ok: true,
        value: [
          secret({
            id: 's1',
            slug: 'exa',
            apiKey: 'mcp-secret-key-aaaa',
            authHeaderName: 'x-api-key',
          }),
        ],
      }),
    });

    expect(Object.keys(result.tools).sort()).toEqual([
      'mcp_exa__bad_name',
      'mcp_exa__web_search',
    ]);
    expect(result.secretsToRedact).toContain('mcp-secret-key-aaaa');
    expect(result.connectedSlugs).toEqual(['exa']);
    expect(setLastError).toHaveBeenCalledWith('user-1', 's1', null);

    await result.close();
    expect(close).toHaveBeenCalled();
  });

  it('soft-fails connect and records last_error', async () => {
    const setLastError = vi.fn(async () => ({
      ok: true as const,
      value: { id: 's1' },
    }));
    const createClient = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const result = await buildUserMcpTools('user-1', {
      createClient: createClient as never,
      setLastError: setLastError as never,
      loadSecrets: async () => ({
        ok: true,
        value: [secret({ id: 's1', slug: 'down', url: 'https://example.com/mcp' })],
      }),
    });

    expect(result.tools).toEqual({});
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].slug).toBe('down');
    expect(setLastError).toHaveBeenCalledWith(
      'user-1',
      's1',
      expect.stringMatching(/ECONNREFUSED|connect/i),
    );
    await result.close();
  });

  it('soft-fails tool execute with ERROR string and redaction', async () => {
    const secretVal = 'super-secret-mcp-token-zzzz';
    const createClient = vi.fn(async () => ({
      tools: async () => ({
        boom: {
          execute: async () => {
            throw new Error(`failed with ${secretVal}`);
          },
        },
      }),
      close: async () => {},
    }));

    const result = await buildUserMcpTools('user-1', {
      createClient: createClient as never,
      setLastError: async () => ({ ok: true, value: { id: 's1' } }),
      loadSecrets: async () => ({
        ok: true,
        value: [
          secret({
            id: 's1',
            slug: 'exa',
            apiKey: secretVal,
            authHeaderName: 'x-api-key',
          }),
        ],
      }),
    });

    const tool = result.tools['mcp_exa__boom'];
    expect(tool).toBeDefined();
    const out = await tool.execute({});
    expect(out).toMatch(/^ERROR mcp_exa__boom:/);
    expect(out).not.toContain(secretVal);
    expect(out).toContain('[redacted]');
    await result.close();
  });

  it('caps total tools at MAX_MCP_TOOLS', async () => {
    const many: Record<string, { execute: () => Promise<string> }> = {};
    for (let i = 0; i < MAX_MCP_TOOLS + 10; i++) {
      many[`t${i}`] = { execute: async () => 'ok' };
    }
    const createClient = vi.fn(async () => ({
      tools: async () => many,
      close: async () => {},
    }));

    const result = await buildUserMcpTools('user-1', {
      createClient: createClient as never,
      setLastError: async () => ({ ok: true, value: { id: 's1' } }),
      loadSecrets: async () => ({
        ok: true,
        value: [secret({ id: 's1', slug: 'big' })],
      }),
    });

    expect(Object.keys(result.tools).length).toBe(MAX_MCP_TOOLS);
    await result.close();
  });

  it('closes clients even when one connect fails and another succeeds', async () => {
    const closeOk = vi.fn(async () => {});
    const createClient = vi.fn(
      async (cfg: { transport: { url: string } }) => {
        if (cfg.transport.url.includes('/a')) {
          throw new Error('fail-a');
        }
        return {
          tools: async () => ({
            a: { execute: async () => 'ok' },
          }),
          close: closeOk,
        };
      },
    );

    const result = await buildUserMcpTools('user-1', {
      createClient: createClient as never,
      setLastError: async () => ({ ok: true, value: { id: 'x' } }),
      loadSecrets: async () => ({
        ok: true,
        value: [
          secret({ id: 'a', slug: 'a', url: 'https://example.com/a' }),
          secret({ id: 'b', slug: 'b', url: 'https://example.com/b' }),
        ],
      }),
    });

    expect(result.connectedSlugs).toEqual(['b']);
    expect(result.skipped.some((s) => s.slug === 'a')).toBe(true);
    await result.close();
    expect(closeOk).toHaveBeenCalled();
  });

  it('uses redirect error on transport config', async () => {
    const createClient = vi.fn(async (cfg: { transport: { redirect?: string } }) => {
      expect(cfg.transport.redirect).toBe('error');
      return {
        tools: async () => ({}),
        close: async () => {},
      };
    });
    await buildUserMcpTools('user-1', {
      createClient: createClient as never,
      setLastError: async () => ({ ok: true, value: { id: 's1' } }),
      loadSecrets: async () => ({
        ok: true,
        value: [secret({ id: 's1', slug: 'exa' })],
      }),
    });
    expect(createClient).toHaveBeenCalled();
  });
});

describe('probeUserMcpServer', () => {
  it('returns tool names and closes', async () => {
    const close = vi.fn(async () => {});
    const createClient = vi.fn(async () => ({
      listTools: async () => ({
        tools: [{ name: 'web_search' }, { name: 'other' }],
      }),
      close,
    }));

    const result = await probeUserMcpServer({
      url: 'https://example.com/mcp',
      createClient: createClient as never,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.toolNames).toEqual(['web_search', 'other']);
    expect(close).toHaveBeenCalled();
  });

  it('fails closed on bad url', async () => {
    const result = await probeUserMcpServer({
      url: 'http://example.com/mcp',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected fail');
    expect(result.error).toMatch(/https/i);
  });
});
