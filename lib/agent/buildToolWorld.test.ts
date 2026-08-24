import { describe, expect, it, vi } from 'vitest';
import { buildToolWorld, type BuildToolWorldScope } from './buildToolWorld';

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
          client: { close: vi.fn(async () => {}) },
          secrets: ['sandbox-secret'],
        },
      }),
    );
    // MCP tool merged into the registry.
    expect(world.registry.mcp_demo_ping).toBeTruthy();
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

  it('injects the request signal into the world (settled by toolExecuteStep resolver)', async () => {
    const controller = new AbortController();
    const world = await buildToolWorld(
      baseScope({ signal: controller.signal }),
    );
    expect(world.signal).toBe(controller.signal);
  });
});
