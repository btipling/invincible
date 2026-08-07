import type { JSONValue } from 'ai';
import {
  gatewayConfigured,
  mapByokResolveFailure,
  mapInferenceError,
  missingGatewayKeyError,
  parseChatBody,
} from '../../../lib/chatServer';
import {
  SANDBOX_NOT_CONFIGURED_ERROR,
  sandboxConfigured,
} from '../../../lib/sandbox/config';
import { runAgent } from '../../../lib/agent/runAgent';
import { tenancyEnabled } from '../../../lib/tenancy/enabled';
import { requireSessionUser } from '../../../lib/tenancy/session';
import { resolveAgentSandbox } from '../../../lib/tenancy/resolveSandbox';
import { resolveByokForRequest } from '../../../lib/tenancy/resolveInferenceForRequest';
import { redactSecrets } from '../../../lib/agent/redact';
import { buildUserMcpTools } from '../../../lib/mcp/client';
import { resolveBuiltinHttpConfig } from '../../../lib/agent/builtinHttpConfig';
import { createHttpFetchTools } from '../../../lib/agent/httpFetchTools';
import { createVercelSandboxHttpRunner } from '../../../lib/agent/vercelSandboxHttpRunner';
import type { HttpFetchRunner } from '../../../lib/agent/httpFetchTypes';

export const runtime = 'nodejs';
export const maxDuration = 60;

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'ResponseAborted';
}

/**
 * Multi-step agent with sandbox tools (+ builtin HTTP + per-user MCP when enabled).
 *
 * POST { prompt: string, modelId?: string }
 * → { text, toolTrace? } | { error }
 *
 * Tenancy on: DB-resolved sandbox + grants + request-scoped BYOK + user MCP tools.
 * Tenancy off: env SANDBOX_* + env model (no BYOK, no MCP).
 * Builtin HTTP: BUILTIN_HTTP_FETCH=sandbox enables http_get without requiring DO workspace.
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

  const tenancyOn = tenancyEnabled();
  const builtinHttp = resolveBuiltinHttpConfig();
  const envSandboxOk = sandboxConfigured();

  // Tenancy off: require DO sandbox OR builtin HTTP — never false 503 when http-only.
  if (!tenancyOn && !envSandboxOk && !builtinHttp.enabled) {
    return Response.json({ error: SANDBOX_NOT_CONFIGURED_ERROR }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: 'Invalid JSON body. Expected { prompt: string }.' },
      { status: 400 },
    );
  }

  const parsed = parseChatBody(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }

  let redactList: string[] = [];
  let mcpClose: (() => Promise<void>) | undefined;
  let httpRunner: HttpFetchRunner | undefined;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extraTools: Record<string, any> = {};
    let runParams: Parameters<typeof runAgent>[0] = {
      prompt: parsed.prompt,
      signal: req.signal,
    };

    if (tenancyOn) {
      const userId = sessionGate.user?.id;
      if (!userId) {
        const { AUTH_REQUIRED_ERROR } = await import('../../../lib/tenancy/errors');
        return Response.json({ error: AUTH_REQUIRED_ERROR }, { status: 401 });
      }

      const byok = await resolveByokForRequest(userId, parsed.modelId);
      if (!byok.ok) {
        const { status, error } = mapByokResolveFailure(byok.reason);
        return Response.json({ error }, { status });
      }
      redactList = byok.secretsToRedact;

      const resolved = await resolveAgentSandbox(userId);

      if (!resolved.ok) {
        if (!builtinHttp.enabled) {
          // Preserve hard 403 when no FS grant and no builtin HTTP path.
          return resolved.response;
        }
        // Soft-continue: http ± MCP only (no FS tools).
        runParams = {
          ...runParams,
          skipSandboxTools: true,
          secrets: [...byok.secretsToRedact],
        };
      } else {
        redactList = [...redactList, ...resolved.value.secrets];
        runParams = {
          ...runParams,
          sandboxClient: resolved.value.client,
          permissions: resolved.value.permissions,
          secrets: [
            ...resolved.value.secrets,
            ...byok.secretsToRedact,
          ],
        };
      }

      const mcp = await buildUserMcpTools(userId, { signal: req.signal });
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
    } else if (!envSandboxOk) {
      // Tenancy off + no DO sandbox: http-only (gate already required builtin on).
      runParams = {
        ...runParams,
        skipSandboxTools: true,
      };
    }

    if (builtinHttp.enabled) {
      httpRunner = createVercelSandboxHttpRunner({
        sandboxTimeoutMs: builtinHttp.sandboxTimeoutMs,
      });
      const httpTools = createHttpFetchTools({
        runner: httpRunner,
        secrets: runParams.secrets,
        signal: req.signal,
        maxBytes: builtinHttp.maxBytes,
        timeoutMs: builtinHttp.timeoutMs,
      });
      extraTools = { ...extraTools, ...httpTools };
    }

    runParams = { ...runParams, extraTools };

    const { text, toolTrace } = await runAgent(runParams);

    if (!text) {
      return Response.json({ error: 'Empty model response.' }, { status: 502 });
    }

    return Response.json({
      text,
      ...(toolTrace.length > 0 ? { toolTrace } : {}),
    });
  } catch (err) {
    if (isAbortError(err)) {
      return Response.json({ error: 'Request cancelled.' }, { status: 499 });
    }
    const { status, error } = mapInferenceError(err);
    const safe =
      redactList.length > 0 ? redactSecrets(error, redactList) : error;
    return Response.json({ error: safe }, { status });
  } finally {
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
}
