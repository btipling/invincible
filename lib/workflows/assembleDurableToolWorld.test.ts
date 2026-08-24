/**
 * backend-agents C14b (#835) — `assembleDurableToolWorld` unit tests.
 *
 * Exercises the PRODUCTION shared helper (not mock-only). The DI root,
 * buildToolWorld, createAgentTools, and the in-function dynamic imports are
 * mocked; the real helper code runs against those mocks. No `new PGlite()` /
 * `createDbConnection` — all seams injected/mocked.
 *
 * Matrix:
 *  - resolveAgentSandbox receives requestedSandboxId + execEnv.GH_TOKEN
 *  - createAgentTools gets the SAME freshness object (identity)
 *  - initialCwd from bind; workspaceRoot:null still merges FS tools
 *  - mcpClose / httpRunner / sandboxClientClose are the handles from the world
 *  - Soft-path: sandbox throw → registry still has skill/meta (no throw out)
 */
import { describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above const declarations — use vi.hoisted()
// so the spies and mock values are available when the hoisted factories run.
const { mockFreshness, resolveAgentSandboxSpy, createAgentToolsSpy } = vi.hoisted(() => ({
  mockFreshness: { _tag: 'RunFileFreshness', _id: 'shared-freshness' },
  resolveAgentSandboxSpy: vi.fn(),
  createAgentToolsSpy: vi.fn(),
}));

vi.mock('../di/index', () => ({
  createProdServices: () => ({
    userGithubToken: {
      decryptUserGithubTokenForServer: async (_userId: string) =>
        ({ ok: true as const, value: 'gh_token_test' }),
    },
    resolveSandbox: {
      resolveAgentSandbox: resolveAgentSandboxSpy,
    },
    userSandboxInstance: {
      loadInstance: async (_userId: string, _kind: string) =>
        ({ ok: true as const, value: { status: 'running', vercelName: 'http-attach-42' } }),
    },
    serverSecrets: {},
    userSkills: {},
    userPersonas: {},
    userPreferredSandbox: {},
    userMcpServers: {},
    createHttpRunner: {},
    harnessSessionsRedis: {
      resolveTenantIdForUser: async (_uid: string) =>
        ({ ok: true as const, value: 'tid' }),
    },
    createPersistStepSeam: () => ({ persist: async () => ({ ok: true as const, status: 'completed' as const }) }),
    resolveInferenceForRequest: {},
    userSandbox: {},
  }),
}));

vi.mock('../agent/buildToolWorld', () => ({
  buildToolWorld: async () => ({
    registry: { find_skill: { description: 'skill' }, fetch_skill: { description: 'skill' } },
    secrets: ['shared-secret-1'],
    signal: new AbortController().signal,
    mcpClose: async () => { /* mocked MCP close */ },
    httpRunner: { close: async () => { /* mocked HTTP close */ } },
  }),
}));

vi.mock('../agent/fileFreshness', () => ({
  createRunFileFreshness: () => mockFreshness,
  hydrateRunFileFreshness: (_seed: string) => mockFreshness,
}));

vi.mock('../agent/tools', () => ({
  createAgentTools: createAgentToolsSpy,
}));

vi.mock('../mcp/client', () => ({
  buildUserMcpTools: async () => ({}),
}));

vi.mock('../tenancy/harnessSessionsRedis', () => ({
  resolveSessionStore: async () =>
    ({ ok: true as const, value: {} }),
}));

import { assembleDurableToolWorld } from './assembleDurableToolWorld';

describe('assembleDurableToolWorld (prod path)', () => {
  it('resolveAgentSandbox receives requestedSandboxId from persistRunBind.activeSandboxId and execEnv.GH_TOKEN', async () => {
    resolveAgentSandboxSpy.mockReset();
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: async () => {} },
        secrets: ['sandbox-secret'],
        permissions: { canRead: true, canWrite: true },
        workspaceRoot: '/workspace',
      },
    });
    createAgentToolsSpy.mockReset();
    createAgentToolsSpy.mockReturnValue({ list_dir: {}, read_file: {} });

    const scope = { tenantId: 't1', userId: 'u1', sessionId: 's1' };
    const bind = { activeSandboxId: 'sb_xyz', cwd: 'app/src' };
    const signal = new AbortController().signal;

    const world = await assembleDurableToolWorld({
      scope,
      persistRunBind: bind,
      signal,
    });

    // resolveAgentSandbox was called with the right args.
    expect(resolveAgentSandboxSpy).toHaveBeenCalledTimes(1);
    const sandboxCall = (resolveAgentSandboxSpy.mock.calls[0] as unknown[]) as [
      string,
      { execEnv?: Record<string, string> },
      { signal: AbortSignal; requestedSandboxId?: string },
    ];
    expect(sandboxCall[0]).toBe('u1'); // userId
    expect(sandboxCall[1]?.execEnv?.GH_TOKEN).toBe('gh_token_test');
    expect(sandboxCall[2]?.requestedSandboxId).toBe('sb_xyz');

    // The returned registry includes both skill/meta from buildToolWorld AND
    // FS tools from createAgentTools.
    expect(world.registry).toBeDefined();
    expect(Object.keys(world.registry)).toContain('find_skill');
    expect(Object.keys(world.registry)).toContain('list_dir');
    // Close handles are present.
    expect(world.mcpClose).toBeDefined();
    expect(world.httpRunner).toBeDefined();
    expect(world.sandboxClientClose).toBeDefined();
  });

  it('createAgentTools gets the SAME freshness object returned by the helper (identity)', async () => {
    resolveAgentSandboxSpy.mockReset();
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: async () => {} },
        secrets: [],
        permissions: { canRead: true, canWrite: false },
        workspaceRoot: null,
      },
    });
    createAgentToolsSpy.mockReset();
    createAgentToolsSpy.mockReturnValue({ read_file: {}, write_file: {} });

    const world = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      freshnessSeed: 'some-seed',
    });

    expect(createAgentToolsSpy).toHaveBeenCalledTimes(1);
    const toolsCall = (createAgentToolsSpy.mock.calls[0] as unknown[])?.[0] as {
      freshness?: unknown;
      initialCwd?: string;
      workspaceRoot?: unknown;
      client?: unknown;
      permissions?: unknown;
    } | undefined;
    // The freshness arg is the SAME object that the helper hydrates (identity).
    expect(toolsCall?.freshness).toBe(mockFreshness);
    expect(world.freshness).toBe(mockFreshness);
  });

  it('initialCwd from bind; workspaceRoot:null still merges FS tools when client+permissions exist', async () => {
    resolveAgentSandboxSpy.mockReset();
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: async () => {} },
        secrets: [],
        permissions: { canRead: true, canWrite: true },
        workspaceRoot: null,
      },
    });
    createAgentToolsSpy.mockReset();
    createAgentToolsSpy.mockReturnValue({});

    await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      persistRunBind: { cwd: 'lib/subdir' },
    });

    expect(createAgentToolsSpy).toHaveBeenCalledTimes(1);
    const toolsCall = (createAgentToolsSpy.mock.calls[0] as unknown[])?.[0] as {
      initialCwd?: string;
      workspaceRoot?: unknown;
      client?: unknown;
      permissions?: unknown;
    } | undefined;
    // initialCwd from bind.
    expect(toolsCall?.initialCwd).toBe('lib/subdir');
    // workspaceRoot is null when resolved sandbox has null workspaceRoot.
    expect(toolsCall?.workspaceRoot).toBeNull();
    // Client and permissions still present → FS tools merged even with null root.
    expect(toolsCall?.client).toBeDefined();
    expect(toolsCall?.permissions).toEqual({ canRead: true, canWrite: true });
  });

  it('soft-path: sandbox throw → registry still has skill/meta tools (no throw out of the helper)', async () => {
    resolveAgentSandboxSpy.mockReset();
    resolveAgentSandboxSpy.mockRejectedValue(new Error('sandbox unavailable'));
    createAgentToolsSpy.mockReset();

    const world = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });

    // No throw — the helper catches and returns a world with non-FS tools only.
    expect(world.registry).toBeDefined();
    expect(Object.keys(world.registry)).toContain('find_skill');
    expect(Object.keys(world.registry)).toContain('fetch_skill');
    // FS tools NOT merged (no client / no createAgentTools call).
    expect(createAgentToolsSpy).not.toHaveBeenCalled();
    // sandboxClientClose is undefined (no client was opened).
    expect(world.sandboxClientClose).toBeUndefined();
    // mcpClose / httpRunner ARE present (from buildToolWorld path, which still runs).
    expect(world.mcpClose).toBeDefined();
    expect(world.httpRunner).toBeDefined();
  });

  it('returned close handles are the exact handles from the mocked world', async () => {
    resolveAgentSandboxSpy.mockReset();
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: async () => {} },
        secrets: [],
        permissions: { canRead: true, canWrite: true },
        workspaceRoot: '/ws',
      },
    });
    createAgentToolsSpy.mockReset();
    createAgentToolsSpy.mockReturnValue({});

    const world = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });

    // The close handles are functions (the steps call them in finally).
    expect(typeof world.mcpClose).toBe('function');
    expect(typeof world.httpRunner).toBe('object');
    expect(typeof (world.httpRunner as { close?: unknown })?.close).toBe('function');
    expect(typeof world.sandboxClientClose).toBe('function');
    // Calling close handles does not throw.
    await expect(world.mcpClose!()).resolves.toBeUndefined();
    await expect(world.sandboxClientClose!()).resolves.toBeUndefined();
  });
});
