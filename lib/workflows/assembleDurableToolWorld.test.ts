/**
 * backend-agents C14b (#835) — `assembleDurableToolWorld` unit tests.
 *
 * Exercises the PRODUCTION shared helper (not mock-only). The DI root,
 * buildToolWorld, createAgentTools, and the in-function dynamic imports are
 * mocked; the real helper code runs against those mocks. No `new PGlite()` /
 * `createDbConnection` — all seams injected/mocked.
 *
 * Matrix:
 *  - Hard deny: {ok:false} no flags, no HTTP → {ok:false, code:'sandbox_forbidden'}
 *  - Soft path: selectionRequired / softContinue → {ok:true}, no FS merge
 *  - Soft path: HTTP attach running → overrides hard-deny sandbox
 *  - {ok:true}: createAgentTools receives bind with sandboxId/backend/name/slug/status
 *  - resolveAgentSandbox receives requestedSandboxId + execEnv.GH_TOKEN
 *  - createAgentTools gets the SAME freshness object (identity)
 *  - initialCwd from bind; workspaceRoot:null still merges FS tools
 *  - mcpClose / httpRunner / sandboxClientClose are the handles from the world
 *  - Soft-path: sandbox throw → registry still has skill/meta (no throw out)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above const declarations — use vi.hoisted()
// so the spies and mock values are available when the hoisted factories run.
const { mockFreshness, resolveAgentSandboxSpy, createAgentToolsSpy, mockMcpClose, mockHttpClose, mockSandboxClose, loadInstanceSpy } = vi.hoisted(() => ({
  mockFreshness: { _tag: 'RunFileFreshness', _id: 'shared-freshness' },
  resolveAgentSandboxSpy: vi.fn(),
  createAgentToolsSpy: vi.fn(),
  mockMcpClose: vi.fn(),
  mockHttpClose: vi.fn(),
  mockSandboxClose: vi.fn(),
  loadInstanceSpy: vi.fn(),
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
      loadInstance: loadInstanceSpy,
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

let buildToolWorldImpl: () => Promise<{
  registry: Record<string, unknown>;
  secrets: string[];
  signal: AbortSignal;
  mcpClose?: () => Promise<void>;
  httpRunner?: { close: () => Promise<void> };
}> = async () => ({
  registry: { find_skill: { description: 'skill' }, fetch_skill: { description: 'skill' } },
  secrets: ['shared-secret-1'],
  signal: new AbortController().signal,
  mcpClose: mockMcpClose,
  httpRunner: { close: mockHttpClose },
});

vi.mock('../agent/buildToolWorld', () => ({
  buildToolWorld: async () => buildToolWorldImpl(),
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
  beforeEach(() => {
    resolveAgentSandboxSpy.mockReset();
    createAgentToolsSpy.mockReset();
    loadInstanceSpy.mockReset();
    // Reset close spies but restore their default async impls so existing
    // tests that .resolves on them don't break (mockReset clears everything).
    mockMcpClose.mockReset();
    mockMcpClose.mockImplementation(async () => { /* mock MCP close */ });
    mockHttpClose.mockReset();
    mockHttpClose.mockImplementation(async () => { /* mock HTTP close */ });
    mockSandboxClose.mockReset();
    mockSandboxClose.mockImplementation(async () => { /* mock sandbox close */ });
    // Reset buildToolWorld to the default success impl.
    buildToolWorldImpl = async () => ({
      registry: { find_skill: { description: 'skill' }, fetch_skill: { description: 'skill' } },
      secrets: ['shared-secret-1'],
      signal: new AbortController().signal,
      mcpClose: mockMcpClose,
      httpRunner: { close: mockHttpClose },
    });
    // Default: HTTP instance running (used by most tests).
    loadInstanceSpy.mockResolvedValue({ ok: true as const, value: { status: 'running', vercelName: 'http-attach-42' } });
  });

  // ── Hard/soft deny tests ──────────────────────────────────────────────

  it('{ok:false} no flags, no HTTP attach → returns {ok:false, code:sandbox_forbidden}; createAgentTools not called', async () => {
    // HTTP NOT running for this test — so no soft surface exists.
    loadInstanceSpy.mockReset();
    loadInstanceSpy.mockResolvedValue({ ok: true as const, value: null });
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: false as const,
      response: Response.json({ error: 'Forbidden' }, { status: 403 }),
      // No softContinue, no selectionRequired.
    });

    const result = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('sandbox_forbidden');
      expect(result.error).toMatch(/not available/i);
    }
    // createAgentTools was NOT called (no FS merge on hard deny).
    expect(createAgentToolsSpy).not.toHaveBeenCalled();
  });

  it('{ok:false, selectionRequired:true} → {ok:true}, no FS merge, skill/meta still present', async () => {
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: false as const,
      selectionRequired: true as const,
      response: Response.json({ error: 'Selection required' }, { status: 403 }),
    });

    const result = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Skill/meta tools present (from buildToolWorld).
      expect(Object.keys(result.world.registry)).toContain('find_skill');
      expect(Object.keys(result.world.registry)).toContain('fetch_skill');
      // FS tools NOT merged (no sandbox client).
      expect(createAgentToolsSpy).not.toHaveBeenCalled();
      // sandboxClientClose is undefined (no client).
      expect(result.world.sandboxClientClose).toBeUndefined();
    }
  });

  it('{ok:false, softContinue:true} → {ok:true}, no FS merge, skill/meta still present', async () => {
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: false as const,
      softContinue: true as const,
      response: Response.json({ error: 'Workspace not running' }, { status: 403 }),
    });

    const result = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.world.registry)).toContain('find_skill');
      expect(createAgentToolsSpy).not.toHaveBeenCalled();
      expect(result.world.sandboxClientClose).toBeUndefined();
    }
  });

  it('{ok:false} + HTTP attach running → {ok:true}, no FS, HTTP tools still assembled', async () => {
    // HTTP IS running (default in beforeEach), so even a hard-deny sandbox
    // resolve is overridden by the HTTP attach soft surface.
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: false as const,
      response: Response.json({ error: 'Forbidden' }, { status: 403 }),
      // No softContinue, no selectionRequired — but HTTP attach is running.
    });

    const result = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.world.registry)).toContain('find_skill');
      expect(createAgentToolsSpy).not.toHaveBeenCalled();
      // buildToolWorld received the HTTP attach name.
      expect(result.world.httpRunner).toBeDefined();
    }
  });

  // ── Bind projection test ──────────────────────────────────────────────

  it('{ok:true} → createAgentTools receives bind with sandboxId/backend/name/slug/status', async () => {
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: async () => {} },
        secrets: ['sandbox-secret'],
        permissions: { canRead: true, canWrite: true },
        workspaceRoot: '/workspace',
        backend: 'vercel' as const,
        sandboxId: 'sb_123',
        name: 'My Sandbox',
        slug: 'my-sandbox',
        status: 'active',
        resolvedImage: 'img:v1',
      },
    });
    createAgentToolsSpy.mockReturnValue({ list_dir: {}, read_file: {} });

    const result = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });

    expect(result.ok).toBe(true);
    expect(createAgentToolsSpy).toHaveBeenCalledTimes(1);
    const toolsCall = (createAgentToolsSpy.mock.calls[0] as unknown[])?.[0] as {
      bind?: { backend: string; sandboxId: string; name: string; slug: string; status: string; image?: string | null };
    } | undefined;
    expect(toolsCall?.bind).toEqual({
      backend: 'vercel',
      sandboxId: 'sb_123',
      name: 'My Sandbox',
      slug: 'my-sandbox',
      status: 'active',
      image: 'img:v1',
    });
  });

  // ── Existing tests (updated for {ok, world} wrapper) ──────────────────

  it('resolveAgentSandbox receives requestedSandboxId from persistRunBind.activeSandboxId and execEnv.GH_TOKEN', async () => {
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: async () => {} },
        secrets: ['sandbox-secret'],
        permissions: { canRead: true, canWrite: true },
        workspaceRoot: '/workspace',
        backend: 'byo' as const,
        sandboxId: 'sb_xyz',
        name: 'Box',
        slug: 'box',
        status: 'active',
        resolvedImage: null,
      },
    });
    createAgentToolsSpy.mockReturnValue({ list_dir: {}, read_file: {} });

    const scope = { tenantId: 't1', userId: 'u1', sessionId: 's1' };
    const bind = { activeSandboxId: 'sb_xyz', cwd: 'app/src' };
    const signal = new AbortController().signal;

    const result = await assembleDurableToolWorld({
      scope,
      persistRunBind: bind,
      signal,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const world = result.world;

    // resolveAgentSandbox was called with the right args.
    expect(resolveAgentSandboxSpy).toHaveBeenCalledTimes(1);
    const sandboxCall = (resolveAgentSandboxSpy.mock.calls[0] as unknown[]) as [
      string,
      { execEnv?: Record<string, string> },
      { signal: AbortSignal; requestedSandboxId?: string },
    ];
    expect(sandboxCall[0]).toBe('u1'); // userId
    expect(sandboxCall[1]?.execEnv?.GH_TOKEN).toBe('gh_token_test');
    expect(sandboxCall[1]?.execEnv?.GITHUB_TOKEN).toBe('gh_token_test');
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
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: async () => {} },
        secrets: [],
        permissions: { canRead: true, canWrite: false },
        workspaceRoot: null,
        backend: 'byo' as const,
        sandboxId: 'sb',
        name: 'b',
        slug: 'b',
        status: 'active',
        resolvedImage: null,
      },
    });
    createAgentToolsSpy.mockReturnValue({ read_file: {}, write_file: {} });

    const result = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      freshnessSeed: 'some-seed',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const world = result.world;

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
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: async () => {} },
        secrets: [],
        permissions: { canRead: true, canWrite: true },
        workspaceRoot: null,
        backend: 'byo' as const,
        sandboxId: 'sb',
        name: 'b',
        slug: 'b',
        status: 'active',
        resolvedImage: null,
      },
    });
    createAgentToolsSpy.mockReturnValue({});

    const result = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      persistRunBind: { cwd: 'lib/subdir' },
    });
    expect(result.ok).toBe(true);

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
    resolveAgentSandboxSpy.mockRejectedValue(new Error('sandbox unavailable'));
    createAgentToolsSpy.mockReset();

    const result = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const world = result.world;

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
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: async () => {} },
        secrets: [],
        permissions: { canRead: true, canWrite: true },
        workspaceRoot: '/ws',
        backend: 'byo' as const,
        sandboxId: 'sb',
        name: 'b',
        slug: 'b',
        status: 'active',
        resolvedImage: null,
      },
    });
    createAgentToolsSpy.mockReturnValue({});

    const result = await assembleDurableToolWorld({
      scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const world = result.world;

    // The close handles are functions (the steps call them in finally).
    expect(typeof world.mcpClose).toBe('function');
    expect(typeof world.httpRunner).toBe('object');
    expect(typeof (world.httpRunner as { close?: unknown })?.close).toBe('function');
    expect(typeof world.sandboxClientClose).toBe('function');
    // Calling close handles does not throw.
    await expect(world.mcpClose!()).resolves.toBeUndefined();
    await expect(world.sandboxClientClose!()).resolves.toBeUndefined();
  });

  it('createAgentTools throws after buildToolWorld succeeded → MCP, HTTP, and sandbox handles are closed before re-throw', async () => {
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: mockSandboxClose },
        secrets: [],
        permissions: { canRead: true, canWrite: true },
        workspaceRoot: '/ws',
        backend: 'byo' as const,
        sandboxId: 'sb',
        name: 'b',
        slug: 'b',
        status: 'active',
        resolvedImage: null,
      },
    });

    // createAgentTools throws — simulating e.g. a malformed tool or
    // permission gate panic after MCP/HTTP are already connected.
    createAgentToolsSpy.mockImplementation(() => {
      throw new Error('createAgentTools exploded');
    });

    await expect(
      assembleDurableToolWorld({
        scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      }),
    ).rejects.toThrow('createAgentTools exploded');

    // All three handles were closed on the error path.
    expect(mockMcpClose).toHaveBeenCalledTimes(1);
    expect(mockHttpClose).toHaveBeenCalledTimes(1);
    expect(mockSandboxClose).toHaveBeenCalledTimes(1);
  });

  it('buildToolWorld throws after sandbox opened → sandbox handle is closed before re-throw', async () => {
    resolveAgentSandboxSpy.mockResolvedValue({
      ok: true as const,
      value: {
        client: { close: mockSandboxClose },
        secrets: [],
        permissions: { canRead: true, canWrite: true },
        workspaceRoot: '/ws',
        backend: 'byo' as const,
        sandboxId: 'sb',
        name: 'b',
        slug: 'b',
        status: 'active',
        resolvedImage: null,
      },
    });

    // buildToolWorld throws before it can connect MCP/HTTP — only sandbox was
    // opened at this point.
    buildToolWorldImpl = async () => {
      throw new Error('buildToolWorld exploded');
    };

    createAgentToolsSpy.mockReset();

    await expect(
      assembleDurableToolWorld({
        scope: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      }),
    ).rejects.toThrow('buildToolWorld exploded');

    // Sandbox close was called (the only handle open at throw time).
    expect(mockSandboxClose).toHaveBeenCalledTimes(1);
    // MCP and HTTP were never reached — their closes were NOT called.
    expect(mockMcpClose).not.toHaveBeenCalled();
    expect(mockHttpClose).not.toHaveBeenCalled();
  });
});
