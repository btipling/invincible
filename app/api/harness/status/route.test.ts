import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/harness/status — read-only git probe for the status-bar git slot.
 * We mock the DI composition root (resolveSandbox + harnessSessionsRedis seam),
 * the session gate, and the envelope store; the resolved client's `exec` drives
 * the bounded git probe. Rate-limit + bind-precedence behavior is asserted here
 * and in the pure statusProbe unit tests.
 */
describe('GET /api/harness/status', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.doUnmock('../../../../lib/di');
    vi.doUnmock('../../../../lib/tenancy/session');
    vi.doUnmock('../../../../lib/tenancy/harnessSessionsRedis');
    vi.resetModules();
  });

  type MockOptions = {
    resolved?:
      | { ok: true; value: Partial<any> }
      | { ok: false; response: Response };
    tenantRes?: { ok: boolean; value?: string };
    envelope?: { meta?: { activeSandboxId?: string } } | null;
    execResults?: Array<{ exitCode: number; stdout: string }>;
  };

  function mockDeps(opts: MockOptions = {}) {
    const {
      resolved = { ok: true, value: { sandboxId: 'sbx_a', client: fakeClient() } },
      tenantRes = { ok: true, value: 'tenant-1' },
      envelope = { meta: { activeSandboxId: 'sbx_a' } },
      execResults = [
        { exitCode: 0, stdout: 'main\n' },
        { exitCode: 0, stdout: 'a1b2c3d\n' },
        { exitCode: 0, stdout: '' },
      ],
    } = opts;

    function fakeClient() {
      let i = 0;
      return {
        exec: vi.fn(async () => {
          const r = execResults[Math.min(i, execResults.length - 1)];
          i += 1;
          return { exitCode: r.exitCode, stdout: r.stdout, stderr: '' };
        }),
        close: vi.fn(async () => {}),
      };
    }

    vi.doMock('../../../../lib/di', () => ({
      createProdServices: () => ({
        harnessSessionsRedis: {
          resolveTenantIdForUser: vi.fn(async () => tenantRes),
        },
        resolveSandbox: {
          resolveAgentSandbox: vi.fn(async () => resolved),
        },
      }),
      createScriptConnection: vi.fn(),
    }));

    vi.doMock('../../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: vi.fn(async () => ({
        ok: true,
        value: {
          readEnvelope: vi.fn(async () => envelope),
          upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
        },
      })),
      sessionKeyFor: vi.fn((tenantId, userId, sessionId) =>
        `${tenantId}:${userId}:${sessionId}`,
      ),
    }));

    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: true,
        user: { id: 'u1' },
      })),
    }));
  }

  function mockUnauth() {
    vi.doMock('../../../../lib/di', () => ({
      createProdServices: () => ({ harnessSessionsRedis: {}, resolveSandbox: {} }),
      createScriptConnection: vi.fn(),
    }));
    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({
        ok: false,
        response: Response.json(
          { error: 'Authentication required.' },
          { status: 401 },
        ),
      })),
    }));
    vi.doMock('../../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: vi.fn(),
      sessionKeyFor: vi.fn(),
    }));
  }

  function req(query = ''): Request {
    return new Request(`http://localhost/api/harness/status${query}`);
  }

  it('unauthenticated → 401 (auth edge)', async () => {
    vi.resetModules();
    mockUnauth();
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('resolves the bind + runs the probe at workspace root, returns git branch/SHA', async () => {
    vi.resetModules();
    mockDeps();
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.git).toEqual({ branch: 'main', sha: 'a1b2c3d' });
    expect(body.value).toBe('main@a1b2c3d');
  });

  it('no /api/harness/status secrets on the wire (no base_url/token ever)', async () => {
    vi.resetModules();
    mockDeps({
      resolved: { ok: true, value: { sandboxId: 'sbx_a', client: { exec: vi.fn() } } },
    });
    const { GET } = await import('./route');
    const res = await GET(req());
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('base_url');
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('ciphertext');
    expect(raw).not.toMatch(/secret/i);
  });

  it('envelope meta.activeSandboxId wins over a stale ?sandboxId= carry (bind precedence)', async () => {
    vi.resetModules();
    const resolveAgentSandbox = vi.fn(async () => ({
      ok: true,
      value: { sandboxId: 'sbx_a', client: { exec: vi.fn() } },
    }));
    vi.doMock('../../../../lib/di', () => ({
      createProdServices: () => ({
        harnessSessionsRedis: {
          resolveTenantIdForUser: vi.fn(async () => ({
            ok: true,
            value: 'tenant-1',
          })),
        },
        resolveSandbox: { resolveAgentSandbox },
      }),
      createScriptConnection: vi.fn(),
    }));
    vi.doMock('../../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: vi.fn(async () => ({
        ok: true,
        value: {
          readEnvelope: vi.fn(async () => ({
            meta: { activeSandboxId: 'sbx_a' },
          })),
          upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
        },
      })),
      sessionKeyFor: vi.fn(),
    }));
    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({ ok: true, user: { id: 'u1' } })),
    }));
    const { GET } = await import('./route');
    // Envelope-read requires a sessionId (envelope-wins precedence is scoped to
    // session-bound calls — no sessionId, no envelope seed).
    await GET(req('?sandboxId=sbx_stale&sessionId=sid'));
    // The envelope bind (sbx_a) seeds resolve — the stale carry must not.
    expect(resolveAgentSandbox).toHaveBeenCalledWith(
      'u1',
      {},
      { requestedSandboxId: 'sbx_a', signal: expect.anything() },
    );
  });

  it('non-Redis-safe ?sandboxId= carry is ignored (falls back to envelope), never a 400/override', async () => {
    vi.resetModules();
    const resolveAgentSandbox = vi.fn(async () => ({
      ok: true,
      value: { sandboxId: 'sbx_a', client: { exec: vi.fn() } },
    }));
    vi.doMock('../../../../lib/di', () => ({
      createProdServices: () => ({
        harnessSessionsRedis: {
          resolveTenantIdForUser: vi.fn(async () => ({
            ok: true,
            value: 'tenant-1',
          })),
        },
        resolveSandbox: { resolveAgentSandbox },
      }),
      createScriptConnection: vi.fn(),
    }));
    vi.doMock('../../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: vi.fn(async () => ({
        ok: true,
        value: {
          readEnvelope: vi.fn(async () => ({
            meta: { activeSandboxId: 'sbx_a' },
          })),
          upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
        },
      })),
      sessionKeyFor: vi.fn(),
    }));
    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({ ok: true, user: { id: 'u1' } })),
    }));
    const { GET } = await import('./route');
    const res = await GET(req('?sandboxId=bad:value&sessionId=sid'));
    expect(res.status).toBe(200);
    expect(resolveAgentSandbox).toHaveBeenCalledWith(
      'u1',
      {},
      { requestedSandboxId: 'sbx_a', signal: expect.anything() },
    );
  });

  it('dirty tree surfaces */branch@sha* and rates the value', async () => {
    vi.resetModules();
    mockDeps({
      execResults: [
        { exitCode: 0, stdout: 'feat/x\n' },
        { exitCode: 0, stdout: 'bb00ff\n' },
        { exitCode: 0, stdout: ' M a.ts\n' },
      ],
    });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.git).toEqual({ branch: 'feat/x', sha: 'bb00ff', dirty: true });
    expect(body.value).toBe('feat/x@bb00ff*');
  });

  it('non-git / dead resolve → empty git slot (fail soft, still 200)', async () => {
    vi.resetModules();
    mockDeps({ resolved: { ok: false, response: Response.json({}, { status: 403 }) } });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.git).toEqual({});
  });

  it('probe exec error → empty git slot (fail soft)', async () => {
    vi.resetModules();
    mockDeps({
      resolved: {
        ok: true,
        value: {
          sandboxId: 'sbx_a',
          client: {
            exec: vi.fn(async () => {
              throw new Error('sandbox unavailable');
            }),
          },
        },
      },
    });
    const { GET } = await import('./route');
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.git).toEqual({});
  });

  it('rate-limited: a second request inside the window returns rate_limited:true with cached value', async () => {
    vi.resetModules();
    // Track exec calls to prove no re-exec when rate-limited.
    let execCalls = 0;
    vi.doMock('../../../../lib/di', () => ({
      createProdServices: () => ({
        harnessSessionsRedis: {
          resolveTenantIdForUser: vi.fn(async () => ({
            ok: true,
            value: 'tenant-1',
          })),
        },
        resolveSandbox: {
          resolveAgentSandbox: vi.fn(async () => ({
            ok: true,
            value: {
              sandboxId: 'sbx_a',
              client: {
                exec: vi.fn(async () => {
                  execCalls += 1;
                  return { exitCode: 0, stdout: `main\n${execCalls}\n` };
                }),
              },
            },
          })),
        },
      }),
      createScriptConnection: vi.fn(),
    }));
    vi.doMock('../../../../lib/tenancy/harnessSessionsRedis', () => ({
      resolveSessionStore: vi.fn(async () => ({
        ok: true,
        value: {
          readEnvelope: vi.fn(async () => ({ meta: { activeSandboxId: 'sbx_a' } })),
          upsertEnvelope: vi.fn(async () => ({ status: 'stored' as const })),
        },
      })),
      sessionKeyFor: vi.fn(),
    }));
    vi.doMock('../../../../lib/tenancy/session', () => ({
      requireSessionUser: vi.fn(async () => ({ ok: true, user: { id: 'u1' } })),
    }));

    const { GET } = await import('./route');
    await GET(req()); // first → exec (git runs)
    const second = await GET(req()); // inside window → cached, no exec
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.rate_limited).toBe(true);
    expect(execCalls).toBe(3); // git probe = 3 execs, all on first request
  });
});
