import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildToolWorld, type BuildToolWorldScope } from './buildToolWorld';
import type { SandboxClient } from '../sandbox/client';
import type { HarnessSessionRecord } from '../sessions/sessionStore';

const { throwInCreateHttpFetchTools } = vi.hoisted(() => ({
  throwInCreateHttpFetchTools: vi.fn<() => boolean>(() => false),
}));

vi.mock('./httpFetchTools', () => ({
  createHttpFetchTools: (opts: Record<string, unknown>) => {
    if (throwInCreateHttpFetchTools()) {
      throw new Error('createHttpFetchTools exploded');
    }
    return { http_get: { execute: vi.fn() } };
  },
}));

/**
 * C14a (#834) — `buildToolWorld` shared-cap seam unit tests.
 *
 * These cover the seam's own guarantees (tool-surface shape, redaction/
 * secrets accumulation, lifecycle ownership). Byte-identical delegation of
 * `/api/agent` to this seam is asserted by `app/api/agent/route.test.ts`
 * staying green (case 4 in the plan's testing matrix) — this file focuses on
 * the seam's contract directly.
 */

type McpResult = {
  tools: Record<string, unknown>;
  secretsToRedact: string[];
  close: () => Promise<void>;
  connectedSlugs: string[];
  skipped: Array<{ slug: string; reason: string }>;
};

function mcpEmpty(): McpResult {
  return {
    tools: {},
    secretsToRedact: [],
    close: vi.fn(async () => {}),
    connectedSlugs: [],
    skipped: [],
  };
}

function baseScope(
  overrides: Partial<BuildToolWorldScope> = {},
): BuildToolWorldScope {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyTools = (map: Record<string, unknown>): any => map;
  const emptyStore = { listUserSkills: vi.fn(), getSkillBySlug: vi.fn() };
  const personaStore = {
    listUserPersonas: vi.fn(),
    getPersonaById: vi.fn(),
    createUserPersona: vi.fn(),
    renameUserPersona: vi.fn(),
    updateUserPersonaBody: vi.fn(),
    setDefaultPersona: vi.fn(),
    clearDefaultPersona: vi.fn(),
    deleteUserPersona: vi.fn(),
    resolveDefaultPersona: vi.fn(),
    updateRecommendedSlugs: vi.fn(),
    listPersonaVersions: vi.fn(),
    getPersonaVersion: vi.fn(),
    rollbackPersona: vi.fn(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skillStore: any = {
    listUserSkills: vi.fn(),
    getSkillBySlug: vi.fn(),
    createUserSkill: vi.fn(),
    updateUserSkillSummary: vi.fn(),
    updateUserSkillBody: vi.fn(),
    deleteUserSkill: vi.fn(),
  };

  const scope: BuildToolWorldScope = {
    userId: 'user-1',
    sessionId: 'sess_1',
    signal: new AbortController().signal,
    serverSecrets: { gatewayKey: 'gw-secret' },
    services: {
      userSkills: skillStore,
      userPersonas: personaStore,
      userPreferredSandbox: {
        listUserSandboxChoices: vi.fn(async () => ({
          ok: true as const,
          value: { preferredSandboxId: null, options: [] },
        })),
      },
      userMcpServers: {
        loadEnabledUserMcpSecrets: vi.fn(async () => ({
          ok: true as const,
          value: [],
        })),
        setUserMcpServerLastError: vi.fn(),
      },
      createHttpRunner: vi.fn(() => ({
        get: vi.fn(),
        close: vi.fn(async () => {}),
      })),
    },
    sessionStoreSeam: {
      resolveSessionStore: vi.fn(async () => ({
        ok: true as const,
        value: {
          get: vi.fn(async () => null),
          put: vi.fn(async () => ({
            status: 'stored' as const,
            record: {
              id: 'sess_1',
              userId: 'user-1',
              tenantId: 'tenant-1',
              createdAt: 0,
              updatedAt: 0,
              messages: [],
              meta: { sync: {} },
            } as HarnessSessionRecord,
          })),
          list: vi.fn(async () => []),
          remove: vi.fn(async () => true),
          readEnvelope: vi.fn(async () => null),
          upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
        },
      })),
      resolveTenantIdForUser: vi.fn(async () => ({
        ok: true as const,
        value: 'tenant-1',
      })),
    },
    buildUserMcpTools: vi.fn(async () => mcpEmpty()),
    byokSecretsToRedact: ['byok-1'],
    ghSecrets: [],
    httpAttachName: null,
  };
  void anyTools;
  void emptyStore;
  return { ...scope, ...overrides };
}

describe('buildToolWorld', () => {
  afterEach(() => {
    throwInCreateHttpFetchTools.mockReturnValue(false);
  });

  it('always assembles skill + meta-persona + meta-sandbox tools (case 1)', async () => {
    const world = await buildToolWorld(baseScope());
    expect(world.registry.find_skill).toBeTruthy();
    expect(world.registry.fetch_skill).toBeTruthy();
    expect(world.registry.meta_persona_list).toBeTruthy();
    expect(world.registry.meta_skill_list).toBeTruthy();
    expect(world.registry.meta_sandbox_list).toBeTruthy();
    expect(world.registry.meta_sandbox_switch).toBeTruthy();
    expect(world.signal).toBeInstanceOf(AbortSignal);
  });

  it('always-on tools present even on the soft/no-sandbox path; MCP ignored when no grant (case 2)', async () => {
    const world = await buildToolWorld(
      baseScope({
        buildUserMcpTools: vi.fn(async () => mcpEmpty()),
      }),
    );
    // No sandbox fold (scope.sandbox undefined), empty MCP → just the
    // always-on families.
    const names = Object.keys(world.registry);
    expect(names).toContain('find_skill');
    expect(names).toContain('meta_sandbox_list');
    expect(world.registry.mcp_).toBeUndefined();
  });

  it('merges MCP + builtin-HTTP + sandbox secrets into registry/redact + owns close (case 3)', async () => {
    const mcpClose = vi.fn(async () => {});
    const httpClose = vi.fn(async () => {});
    const buildUserMcpTools = vi.fn(async (): Promise<McpResult> => ({
      tools: { mcp_demo_ping: { execute: async () => 'pong' } },
      secretsToRedact: ['mcp-secret'],
      close: mcpClose,
      connectedSlugs: ['demo'],
      skipped: [],
    }));
    const world = await buildToolWorld(
      baseScope({
        buildUserMcpTools,
        httpAttachName: 'inv-http-1',
        sandbox: {
          client: {
            listDir: vi.fn(),
            readFile: vi.fn(),
            writeFile: vi.fn(),
            strReplace: vi.fn(),
            stat: vi.fn(),
            exec: vi.fn(),
            close: vi.fn(async () => {}),
          } as SandboxClient,
          secrets: ['sandbox-secret'],
        },
      }),
    );
    // MCP tool merged into the registry.
    expect(world.registry.mcp_demo_ping).toBeTruthy();
    // HTTP fetch tools merged into the registry (not lost to the empty mock).
    expect(world.registry.http_get).toBeTruthy();
    // Builtin-HTTP runner owned for later close.
    expect(world.httpRunner).toBeTruthy();
    const createRunner = world.httpRunner;
    expect(createRunner).toBeTruthy();
    // Sandbox + byok + mcp secrets accumulated in the redaction list.
    expect(world.redactList).toContain('sandbox-secret');
    expect(world.redactList).toContain('byok-1');
    expect(world.redactList).toContain('mcp-secret');
    // runParams.secrets carries the sandbox fold first, then byok, gh, mcp.
    expect(world.secrets).toEqual([
      'sandbox-secret',
      'byok-1',
      'mcp-secret',
    ]);
    // MCP close handle surfaced for the caller's lifecycle.
    expect(world.mcpClose).toBe(mcpClose);
    void httpClose;
  });

  it('no http tools when no running HTTP instance attaches (case 2/3 variant)', async () => {
    const world = await buildToolWorld(baseScope());
    expect(world.httpRunner).toBeUndefined();
    expect(world.registry.http_get).toBeUndefined();
  });

  it('MCP close runs when buildUserMcpTools connects then a later line (HTTP runner) throws', async () => {
    // Scenario: MCP connects successfully, but createHttpRunner throws.
    // The MCP handle must be closed on the error path (otherwise it leaks).
    const mcpClose = vi.fn(async () => {});
    const buildUserMcpTools = vi.fn(async (): Promise<McpResult> => ({
      tools: { mcp_demo_ping: { execute: async () => 'pong' } },
      secretsToRedact: ['mcp-secret'],
      close: mcpClose,
      connectedSlugs: ['demo'],
      skipped: [],
    }));

    // createHttpRunner throws — simulates a runtime failure after MCP is connected.
    const httpClose = vi.fn(async () => {});
    const services = {
      ...baseScope().services,
      createHttpRunner: vi.fn(() => {
        // Create the runner's close handle so we can assert it runs on the error path.
        const runner = { get: vi.fn(), close: httpClose };
        throw new Error('http runner creation failed');
      }),
    };

    await expect(
      buildToolWorld(
        baseScope({
          buildUserMcpTools,
          httpAttachName: 'inv-http-1',
          services: services as BuildToolWorldScope['services'],
        }),
      ),
    ).rejects.toThrow('http runner creation failed');

    // MCP was connected before the throw — its close must have been called.
    expect(mcpClose).toHaveBeenCalledTimes(1);
    // HTTP runner was never created (createHttpRunner threw before returning).
    expect(httpClose).not.toHaveBeenCalled();
  });

  it('MCP close AND HTTP runner close both run when httpTools assembly throws after both connected', async () => {
    // Scenario: MCP connects, HTTP runner is created, then createHttpFetchTools
    // throws. Both MCP close AND HTTP runner close must run on the error path.
    const mcpClose = vi.fn(async () => {});
    const buildUserMcpTools = vi.fn(async (): Promise<McpResult> => ({
      tools: { mcp_demo_ping: { execute: async () => 'pong' } },
      secretsToRedact: ['mcp-secret'],
      close: mcpClose,
      connectedSlugs: ['demo'],
      skipped: [],
    }));

    const httpClose = vi.fn(async () => {});

    // Enable the mock throw in createHttpFetchTools.
    throwInCreateHttpFetchTools.mockReturnValue(true);

    await expect(
      buildToolWorld(
        baseScope({
          buildUserMcpTools,
          httpAttachName: 'inv-http-1',
          services: {
            ...baseScope().services,
            createHttpRunner: vi.fn(() => ({
              get: vi.fn(),
              close: httpClose,
            })),
          } as BuildToolWorldScope['services'],
        }),
      ),
    ).rejects.toThrow('createHttpFetchTools exploded');

    // Both handles were closed on the error path.
    expect(mcpClose).toHaveBeenCalledTimes(1);
    expect(httpClose).toHaveBeenCalledTimes(1);
  });

  it('injects the request signal into the world (settled by toolExecuteStep resolver)', async () => {
    const controller = new AbortController();
    const world = await buildToolWorld(
      baseScope({ signal: controller.signal }),
    );
    expect(world.signal).toBe(controller.signal);
  });
});
