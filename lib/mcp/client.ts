/**
 * MCP HTTP client for per-user remote servers (phase 2 / #118).
 * Server-only — never import from client components.
 */
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import {
  loadEnabledUserMcpSecrets,
  setUserMcpServerLastError,
  type UserMcpSecretRow,
  type UserMcpServerResult,
} from '../tenancy/userMcpServers';
import { redactSecrets } from '../agent/redact';
import {
  MAX_MCP_TOOLS,
  MCP_CONNECT_TIMEOUT_MS,
} from './limits';
import { mcpToolKey } from './toolNames';
import { assertSafeMcpUrl } from './urlPolicy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type McpToolMap = Record<string, any>;

export type CreateMcpClientFn = typeof createMCPClient;

export type BuildUserMcpToolsResult = {
  tools: McpToolMap;
  secretsToRedact: string[];
  close: () => Promise<void>;
  connectedSlugs: string[];
  skipped: Array<{ slug: string; reason: string }>;
};

export type BuildUserMcpToolsOptions = {
  signal?: AbortSignal;
  createClient?: CreateMcpClientFn;
  loadSecrets?: (
    userId: string,
  ) => Promise<UserMcpServerResult<UserMcpSecretRow[]>>;
  setLastError?: (
    userId: string,
    id: string,
    lastError: string | null,
  ) => Promise<UserMcpServerResult<{ id: string }>>;
  connectTimeoutMs?: number;
  maxTools?: number;
};

function safeErrorMessage(err: unknown, secrets: string[]): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'error');
  const redacted = redactSecrets(raw, secrets);
  // Drop likely secret substrings if still long hex/token-like leftovers.
  return redacted.replace(/\s+/g, ' ').trim().slice(0, 200) || 'connect failed';
}

function buildHeaders(row: UserMcpSecretRow): Record<string, string> | undefined {
  if (row.apiKey && row.authHeaderName) {
    return { [row.authHeaderName]: row.apiKey };
  }
  return undefined;
}

/**
 * Wrap MCP tool execute: soft-fail like sandbox tools; redact secrets in errors.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapMcpTool(tool: any, toolKey: string, secrets: string[]): any {
  const original = tool?.execute;
  if (typeof original !== 'function') {
    return tool;
  }
  return {
    ...tool,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: async (input: any, options: any) => {
      try {
        return await original.call(tool, input, options);
      } catch (err) {
        const msg = safeErrorMessage(err, secrets);
        return `ERROR ${toolKey}: ${msg}`;
      }
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`MCP connect timed out after ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
  });
  const onAbort = () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    // reject via timeout race by aborting outer — recreate
  };
  // Use AbortSignal.timeout composition when available + caller signal
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    void onAbort;
  }
}

type ConnectOneResult =
  | {
      ok: true;
      slug: string;
      client: MCPClient;
      tools: McpToolMap;
      secrets: string[];
    }
  | { ok: false; slug: string; id: string; reason: string };

async function connectOneServer(
  row: UserMcpSecretRow,
  opts: {
    createClient: CreateMcpClientFn;
    signal?: AbortSignal;
    connectTimeoutMs: number;
  },
): Promise<ConnectOneResult> {
  const secrets = row.apiKey ? [row.apiKey] : [];
  try {
    const urlCheck = await assertSafeMcpUrl(row.url);
    if (!urlCheck.ok) {
      return {
        ok: false,
        slug: row.slug,
        id: row.id,
        reason: urlCheck.error,
      };
    }

    const headers = buildHeaders(row);
    const createPromise = opts.createClient({
      transport: {
        type: 'http',
        url: urlCheck.href,
        ...(headers ? { headers } : {}),
        redirect: 'error',
      },
      initializationOptions: {
        timeout: opts.connectTimeoutMs,
        signal: opts.signal,
      },
    });

    const client = await withTimeout(
      createPromise,
      opts.connectTimeoutMs,
      opts.signal,
    );

    const rawTools = await withTimeout(
      client.tools(),
      opts.connectTimeoutMs,
      opts.signal,
    );

    const tools: McpToolMap = {};
    for (const [remoteName, tool] of Object.entries(rawTools ?? {})) {
      const key = mcpToolKey(row.slug, remoteName);
      if (!key) continue;
      tools[key] = wrapMcpTool(tool, key, secrets);
    }

    return { ok: true, slug: row.slug, client, tools, secrets };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        ok: false,
        slug: row.slug,
        id: row.id,
        reason: 'aborted',
      };
    }
    return {
      ok: false,
      slug: row.slug,
      id: row.id,
      reason: safeErrorMessage(err, secrets),
    };
  }
}

/**
 * Load enabled MCP servers for user, connect in parallel, return tool map.
 * Always call `close()` when the agent turn finishes (try/finally).
 */
export async function buildUserMcpTools(
  userId: string,
  opts: BuildUserMcpToolsOptions = {},
): Promise<BuildUserMcpToolsResult> {
  const createClient = opts.createClient ?? createMCPClient;
  const loadSecrets = opts.loadSecrets ?? loadEnabledUserMcpSecrets;
  const setLastError = opts.setLastError ?? setUserMcpServerLastError;
  const connectTimeoutMs = opts.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  const maxTools = opts.maxTools ?? MAX_MCP_TOOLS;

  const empty = (): BuildUserMcpToolsResult => ({
    tools: {},
    secretsToRedact: [],
    close: async () => {},
    connectedSlugs: [],
    skipped: [],
  });

  const loaded = await loadSecrets(userId);
  if (!loaded.ok || loaded.value.length === 0) {
    return empty();
  }

  const settled = await Promise.allSettled(
    loaded.value.map((row) =>
      connectOneServer(row, {
        createClient,
        signal: opts.signal,
        connectTimeoutMs,
      }),
    ),
  );

  const clients: MCPClient[] = [];
  const tools: McpToolMap = {};
  const secretsToRedact: string[] = [];
  const connectedSlugs: string[] = [];
  const skipped: Array<{ slug: string; reason: string }> = [];

  // Preserve row order for first-wins collision + deterministic cap.
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const row = loaded.value[i];
    if (s.status === 'rejected') {
      const reason = safeErrorMessage(s.reason, row.apiKey ? [row.apiKey] : []);
      skipped.push({ slug: row.slug, reason });
      void setLastError(userId, row.id, reason).catch(() => {});
      continue;
    }
    const result = s.value;
    if (!result.ok) {
      skipped.push({ slug: result.slug, reason: result.reason });
      void setLastError(userId, result.id, result.reason).catch(() => {});
      continue;
    }

    clients.push(result.client);
    connectedSlugs.push(result.slug);
    for (const sec of result.secrets) {
      if (sec && !secretsToRedact.includes(sec)) secretsToRedact.push(sec);
    }

    // Clear last_error on success (best-effort).
    void setLastError(userId, row.id, null).catch(() => {});

    const keys = Object.keys(result.tools).sort();
    for (const key of keys) {
      if (Object.keys(tools).length >= maxTools) break;
      if (key in tools) continue; // first wins
      tools[key] = result.tools[key];
    }
  }

  // Cap may leave tools from later servers unused — still close clients.
  const close = async () => {
    await Promise.all(
      clients.map(async (c) => {
        try {
          await c.close();
        } catch {
          // ignore close errors
        }
      }),
    );
  };

  return { tools, secretsToRedact, close, connectedSlugs, skipped };
}

export type ProbeUserMcpServerInput = {
  url: string;
  authHeaderName?: string | null;
  apiKey?: string | null;
  signal?: AbortSignal;
  createClient?: CreateMcpClientFn;
  connectTimeoutMs?: number;
};

/**
 * Connect + list remote tool names (unprefixed). For Settings Test (#119).
 */
export async function probeUserMcpServer(
  input: ProbeUserMcpServerInput,
): Promise<{ ok: true; toolNames: string[] } | { ok: false; error: string }> {
  const createClient = input.createClient ?? createMCPClient;
  const connectTimeoutMs = input.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  const secrets = input.apiKey ? [input.apiKey] : [];

  const urlCheck = await assertSafeMcpUrl(input.url);
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error };
  }

  let client: MCPClient | undefined;
  try {
    const headers =
      input.apiKey && input.authHeaderName
        ? { [input.authHeaderName]: input.apiKey }
        : undefined;

    client = await withTimeout(
      createClient({
        transport: {
          type: 'http',
          url: urlCheck.href,
          ...(headers ? { headers } : {}),
          redirect: 'error',
        },
        initializationOptions: {
          timeout: connectTimeoutMs,
          signal: input.signal,
        },
      }),
      connectTimeoutMs,
      input.signal,
    );

    const listed = await withTimeout(
      client.listTools(),
      connectTimeoutMs,
      input.signal,
    );
    const toolNames = (listed.tools ?? [])
      .map((t) => t.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);

    return { ok: true, toolNames };
  } catch (err) {
    return { ok: false, error: safeErrorMessage(err, secrets) };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  }
}
