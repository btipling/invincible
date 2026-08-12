import type { JSONValue } from 'ai';
import {
  gatewayConfigured,
  mapByokResolveFailure,
  mapInferenceError,
  missingGatewayKeyError,
} from '../../../lib/chatServer';
import { parseAgentBody } from '../../../lib/agent/agentBody';
import type { SandboxClient } from '../../../lib/sandbox/client';
import { runAgent, runAgentStream } from '../../../lib/agent/runAgent';
import {
  AGENT_STREAM_CONTENT_TYPE,
  encodeSseData,
  wantsAgentStream,
  type AgentStreamEvent,
} from '../../../lib/agent/agentStream';
import { createProdServices } from '../../../lib/di';
import { requireSessionUser } from '../../../lib/tenancy/session';
import { redactSecrets } from '../../../lib/agent/redact';
import { buildUserMcpTools } from '../../../lib/mcp/client';
import { resolveBuiltinHttpConfig } from '../../../lib/agent/builtinHttpConfig';
import { createHttpFetchTools } from '../../../lib/agent/httpFetchTools';
import type { HttpFetchRunner } from '../../../lib/agent/httpFetchTypes';

export const runtime = 'nodejs';
// Vercel Pro/Enterprise Fluid extended max is 1800s (30m). 3600s is not offered.
export const maxDuration = 1800;

/** Phase-1 DI: services wired at the composition root (module never constructs). */
const services = createProdServices();

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'ResponseAborted';
}

/**
 * Release runners: hop-B http sandbox, MCP sessions, and FS SandboxClient.
 * Attach FS/HTTP close = extendTimeout + drop handle (never stop).
 * Called from JSON finally, stream start finally, and stream cancel.
 */
async function closeRunners(
  httpRunner: HttpFetchRunner | undefined,
  mcpClose: (() => Promise<void>) | undefined,
  sandboxClient?: SandboxClient | undefined,
): Promise<void> {
  if (sandboxClient?.close) {
    try {
      await sandboxClient.close();
    } catch {
      // ignore sandbox client close errors
    }
  }
  if (httpRunner) {
    try {
      await httpRunner.close();
    } catch {
      // ignore http runner close errors
    }
  }
  if (mcpClose) {
    try {
      await mcpClose();
    } catch {
      // ignore MCP close errors
    }
  }
}

/**
 * Multi-step agent with sandbox tools (+ builtin HTTP + per-user MCP when enabled).
 *
 * POST { prompt: string, modelId?: string, cwd?: string }
 * → JSON { text, toolTrace?, cwd? } | { error }
 * Omitted cwd → SANDBOX_DEFAULT_CWD if valid, else ".".
 * → or SSE (Accept: text/event-stream) agent events (docs/agent-stream.md)
 *
 * Always multi-tenant on: session user required, DB-resolved sandbox + grants +
 * request-scoped BYOK + user MCP tools. Builtin HTTP: BUILTIN_HTTP_FETCH=sandbox +
 * Settings HTTP instance attach; never create on the hot path.
 */
export async function POST(req: Request): Promise<Response> {
  const sessionGate = await requireSessionUser();
  if (!sessionGate.ok) {
    return sessionGate.response;
  }

  if (!gatewayConfigured()) {
    const { status, error } = missingGatewayKeyError();
    return Response.json({ error }, { status });
  }

  const builtinHttp = resolveBuiltinHttpConfig();
  const stream = wantsAgentStream(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: 'Invalid JSON body. Expected { prompt: string }.' },
      { status: 400 },
    );
  }

  const parsed = parseAgentBody(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }

  // Server secrets resolved once at the root (phase-2 DI) — scrubbed from
  // model-facing and client-facing strings like the BYOK / PAT / MCP secrets.
  const serverSecrets = services.serverSecrets;

  let redactList: string[] = [];
  let mcpClose: (() => Promise<void>) | undefined;
  let httpRunner: HttpFetchRunner | undefined;
  let sandboxClient: SandboxClient | undefined;
  let runnersOwnedByStream = false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extraTools: Record<string, any> = {};
    // Accumulates request fields + resolved tool wiring; modelId is only known
    // after `resolveByokForRequest` returns, so it is added later (guarded below).
    type RunParamsAcc = Omit<Parameters<typeof runAgent>[0], 'modelId'> & {
      modelId?: string;
    };
    let runParams: RunParamsAcc = {
      prompt: parsed.prompt,
      signal: req.signal,
      initialCwd: parsed.cwd,
      serverSecrets,
    };
    /**
     * When resolve fails but we soft-path (softContinue or builtin HTTP),
     * keep the 403 body and return it only if no tools assemble later.
     */
    let deferredNoFsResponse: Response | undefined;

    const userId = sessionGate.user?.id;
    if (!userId) {
      const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
      return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
    }

    const byok = await services.resolveInferenceForRequest.resolveByokForRequest(
      userId,
      parsed.modelId,
    );
    if (!byok.ok) {
      const { status, error } = mapByokResolveFailure(byok.reason);
      return Response.json({ error }, { status });
    }
    redactList = [
      ...byok.secretsToRedact,
      serverSecrets.gatewayKey,
      serverSecrets.sandboxToken,
    ].filter(Boolean) as string[];

    // Per-user GitHub PAT → sandbox exec env (client options only; never tool schema).
    const gh = await services.userGithubToken.decryptUserGithubTokenForServer(
      userId,
    );
    const ghSecrets: string[] = [];
    let execEnv: Record<string, string> | undefined;
    if (gh.ok && gh.value) {
      ghSecrets.push(gh.value);
      execEnv = { GH_TOKEN: gh.value, GITHUB_TOKEN: gh.value };
    }
    redactList = [...redactList, ...ghSecrets];

    const resolved = await services.resolveSandbox.resolveAgentSandbox(userId, {
      ...(execEnv ? { execEnv } : {}),
    });

    // When resolve soft-continues (e.g. Workspace not running), keep the 403
    // body and only proceed if MCP and/or builtin HTTP supply tools later.
    if (!resolved.ok) {
      if (resolved.softContinue || builtinHttp.enabled) {
        // Soft path: no FS tools; MCP + builtin HTTP may still run.
        runParams = {
          ...runParams,
          skipSandboxTools: true,
          secrets: [...byok.secretsToRedact, ...ghSecrets],
        };
        deferredNoFsResponse = resolved.response;
      } else {
        // Hard 403: grant/membership/selection without alternate soft path.
        return resolved.response;
      }
    } else {
      sandboxClient = resolved.value.client;
      redactList = [...redactList, ...resolved.value.secrets];
      runParams = {
        ...runParams,
        sandboxClient: resolved.value.client,
        permissions: resolved.value.permissions,
        secrets: [
          ...resolved.value.secrets,
          ...byok.secretsToRedact,
          ...ghSecrets,
        ],
      };
    }

    const mcp = await buildUserMcpTools(userId, {
      signal: req.signal,
      loadSecrets: services.userMcpServers.loadEnabledUserMcpSecrets,
      setLastError: services.userMcpServers.setUserMcpServerLastError,
    });
    mcpClose = mcp.close;
    redactList = [...redactList, ...mcp.secretsToRedact];
    extraTools = { ...extraTools, ...mcp.tools };

    runParams = {
      ...runParams,
      modelId: byok.modelId,
      providerOptions: {
        gateway: {
          only: byok.only as JSONValue,
          byok: byok.byok as JSONValue,
        },
      },
      secrets: [
        ...(runParams.secrets ?? []),
        ...mcp.secretsToRedact,
      ],
    };

    if (builtinHttp.enabled) {
      let httpAttachName: string | undefined;

      // Settings HTTP/curl instance — omit tools when missing/stopped/error.
      const loaded = await services.userSandboxInstance.loadInstance(
        userId,
        'http',
      );
      if (
        loaded.ok &&
        loaded.value &&
        loaded.value.status === 'running' &&
        loaded.value.vercelName?.trim()
      ) {
        httpAttachName = loaded.value.vercelName.trim();
      }

      if (httpAttachName) {
        // Constructed via the composition root (phase-2 DI), request-scoped.
        httpRunner = services.createHttpRunner({ name: httpAttachName });
        const httpTools = createHttpFetchTools({
          runner: httpRunner,
          secrets: runParams.secrets,
          serverSecrets,
          signal: req.signal,
          maxBytes: builtinHttp.maxBytes,
          timeoutMs: builtinHttp.timeoutMs,
        });
        extraTools = { ...extraTools, ...httpTools };
      }
    }

    runParams = { ...runParams, extraTools };

    // Model id always resolved via BYOK above; guard so runAgent sees a required value.
    if (!runParams.modelId) {
      const { INFERENCE_MODEL_REQUIRED_ERROR } = await import(
        '../../../lib/tenancy/errors'
      );
      return Response.json(
        { error: INFERENCE_MODEL_REQUIRED_ERROR },
        { status: 400 },
      );
    }
    const finalRunParams: Parameters<typeof runAgent>[0] = {
      ...runParams,
      modelId: runParams.modelId,
    };

    // Soft path only when non-FS tools exist; else return resolve 403 body.
    if (
      deferredNoFsResponse &&
      !sandboxClient &&
      Object.keys(extraTools).length === 0
    ) {
      return deferredNoFsResponse;
    }

    if (stream) {
      runnersOwnedByStream = true;
      const encoder = new TextEncoder();
      const httpRef = httpRunner;
      const mcpRef = mcpClose;
      const sandboxRef = sandboxClient;
      const secretsForErr = redactList;

      const bodyStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let closed = false;
          const enqueue = (ev: AgentStreamEvent) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(encodeSseData(ev)));
            } catch {
              closed = true;
            }
          };
          try {
            await runAgentStream(finalRunParams, {
              onEvent: async (ev) => {
                enqueue(ev);
              },
            });
          } catch (err) {
            if (isAbortError(err)) {
              enqueue({ type: 'error', error: 'Request cancelled.', status: 499 });
            } else {
              const { error, status } = mapInferenceError(err);
              const safe =
                secretsForErr.length > 0
                  ? redactSecrets(error, secretsForErr)
                  : error;
              enqueue({
                type: 'error',
                error: safe,
                ...(status === 426 ? { status } : {}),
              });
            }
          } finally {
            await closeRunners(httpRef, mcpRef, sandboxRef);
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        },
        async cancel() {
          await closeRunners(httpRef, mcpRef, sandboxRef);
        },
      });

      return new Response(bodyStream, {
        status: 200,
        headers: {
          'Content-Type': AGENT_STREAM_CONTENT_TYPE,
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    const { text, toolTrace, cwd } = await runAgent(finalRunParams);

    if (!text) {
      return Response.json({ error: 'Empty model response.' }, { status: 502 });
    }

    return Response.json({
      text,
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
      ...(cwd != null ? { cwd } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) {
      return Response.json({ error: 'Request cancelled.' }, { status: 499 });
    }
    const { status, error, code } = mapInferenceError(err);
    const safe =
      redactList.length > 0 ? redactSecrets(error, redactList) : error;
    return Response.json(
      { error: safe, ...(code != null ? { code } : {}) },
      { status },
    );
  } finally {
    if (!runnersOwnedByStream) {
      await closeRunners(httpRunner, mcpClose, sandboxClient);
    }
  }
}
