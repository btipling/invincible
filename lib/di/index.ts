/**
 * Composition root (phase 1 — parent #438 / phase #440; extended phase 2 — #439).
 *
 * This is the **only** production construction point for the tenancy DB
 * factories and, from phase 2, the sandbox client / Vercel HTTP-FS runner /
 * Redis session-store / gateway-env seams. Modules never open/close a
 * connection or construct an external client themselves; they receive
 * factories / providers via `deps` and resolve through `withConnection`.
 *
 * Design choices (phase 1):
 * - `connect` returns a fresh connection per call (mirrors the previous
 *   per-call open/close behavior; safe for serverless request scopes and
 *   scripts). The provider owns the lifecycle; `withConnection` closes it.
 * - `createScriptConnection()` exposes a closeable `{ db, close }` slice so
 *   scripts (seed / backfill) teardown at their wiring site without calling
 *   `createDbConnection()` directly.
 *
 * Phase 2 (#439) additions:
 * - `serverSecrets` — Gateway key + sandbox token resolved from env once here
 *   (the only place these `process.env` I/O reads live for prod callers).
 * - `createHttpRunner / createByoSandboxClient / createVercelFsSandboxClient /
 *   createSessionStore` — request-scoped factories so `app/api/agent/route.ts`,
 *   `lib/agent/runAgent.ts`, `lib/tenancy/resolveSandbox.ts` and the session
 *   seam construct through the root, not a low-level factory with implicit
 *   defaults.
 * - `resolveSandbox` is bound with the real BYO / Vercel-FS client factories.
 * - the Redis session-store factory is registered for the server paths.
 */
import { createDbConnection } from '../../db';
import { type TenancyConnection } from './withConnection';
import { createTenantKeys } from '../tenancy/tenantKeys';
import { createAuthenticate } from '../tenancy/authenticate';
import { createAdminContext } from '../tenancy/adminContext';
import { createHarnessSessions } from '../tenancy/harnessSessions';
import { createIdentity, IdentityError } from '../tenancy/identity';
import { createFirstRun } from '../tenancy/firstRun';
import { createListTenantMembers } from '../tenancy/listTenantMembers';
import { createManageSandbox } from '../tenancy/manageSandbox';
import { createProviderSecrets } from '../tenancy/providerSecrets';
import { createResolveInference } from '../tenancy/resolveInference';
import { createResolveInferenceForRequest } from '../tenancy/resolveInferenceForRequest';
import { createResolveSandbox } from '../tenancy/resolveSandbox';
import { createRotateSandboxToken } from '../tenancy/rotateSandboxToken';
import { createRotateTenantDek } from '../tenancy/rotateTenantDek';
import { createSoleMembership } from '../tenancy/soleMembership';
import { createUserGithubToken } from '../tenancy/userGithubToken';
import { createUserMcpServers } from '../tenancy/userMcpServers';
import { createUserPreferredSandbox } from '../tenancy/userPreferredSandbox';
import { createUserSandboxInstance } from '../tenancy/userSandboxInstance';
import { createHarnessSessionsRedis } from '../tenancy/harnessSessionsRedis';
import { registerSessionStoreFactoryForServer } from '../tenancy/harnessSessionsRedis';
import { createScimHandlers } from '../tenancy/scimHandlers';
import { createSandboxClient, type SandboxClient } from '../sandbox/client';
import { createVercelSandboxClient } from '../sandbox/vercelClient';
import {
  createVercelSandboxHttpRunner,
  type VercelSandboxHttpRunnerOptions,
} from '../agent/vercelSandboxHttpRunner';
import type { HttpFetchRunner } from '../agent/httpFetchTypes';
import {
  RedisSessionStore,
  type RedisSessionStoreOptions,
} from '../sessions/redisSessionStore';

/**
 * Server-only secrets resolved once at the root (never read from `process.env`
 * inside module bodies). Gateway key + DO sandbox token are scrubbed from
 * model-facing and client-facing strings by the agent route.
 */
export type ServerSecrets = {
  gatewayKey?: string;
  sandboxToken?: string;
};

export function resolveServerSecrets(
  env: Record<string, string | undefined> = process.env,
): ServerSecrets {
  return {
    gatewayKey: env.AI_GATEWAY_API_KEY?.trim() || undefined,
    sandboxToken: env.SANDBOX_TOKEN?.trim() || undefined,
  };
}

/**
 * One-time deprecation hint for the pre-switch env names, emitted here (the single
 * place the Redis env is read). The legacy REST credentials (`SESSION_REDIS_URL/TOKEN`,
 * `UPSTASH_REDIS_REST_URL/_TOKEN`) cannot drive the RESP client, so we do NOT fall back
 * to them functionally (a `https://` REST URL is protocol-incompatible and would
 * hang/fail): we just flag the rename so an operator whose deploy suddenly 503s doesn't
 * mis-diagnose it as "Redis broken".
 */
let legacyRedisEnvWarned = false;
function warnLegacyRedisEnv(env: Record<string, string | undefined>): void {
  const legacy = [
    env.SESSION_REDIS_URL,
    env.SESSION_REDIS_TOKEN,
    env.UPSTASH_REDIS_REST_URL,
    env.UPSTASH_REDIS_REST_TOKEN,
  ].some((v) => typeof v === 'string' && v.length > 0);
  if (!legacy || legacyRedisEnvWarned) return;
  legacyRedisEnvWarned = true;
  // Never log the values — they may embed credentials.
  console.warn(
    '[redis-session-store] Detected legacy SESSION_REDIS_* / UPSTASH_REDIS_REST_* env vars. ' +
      "These were replaced by a single REDIS_URL (RESP wire URL, e.g. redis://default:<secret>@host:port or rediss://). " +
      'Multi-session will 503 SESSION_STORE_UNAVAILABLE until you set REDIS_URL.',
  );
}

function resolveRedisUrl(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const url = env.REDIS_URL?.trim() || undefined;
  if (!url) warnLegacyRedisEnv(env);
  return url;
}

function resolveRedisTtlMs(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.SESSION_REDIS_TTL_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Shape `resolveSandbox` needs to build a BYO sandbox client at the root. */
export type RootByoSandboxClientFactory = (opts: {
  baseUrl: string;
  token: string;
  execEnv?: Record<string, string>;
}) => SandboxClient;

/** Shape `resolveSandbox` needs to build a Vercel-FS sandbox client at the root. */
export type RootVercelFsClientFactory = (opts: {
  name: string;
  image?: string | null;
  execEnv?: Record<string, string>;
}) => SandboxClient;

/**
 * Open a real Postgres connection and return a closeable slice.
 * This is the script-safe path (seed / backfill): the caller owns `close()`.
 */
export function createScriptConnection(): TenancyConnection {
  const { db, client } = createDbConnection();
  return {
    db,
    close: () => client.end({ timeout: 5 }),
  };
}

/**
 * The production wiring: every tenancy factory bound to a per-call `connect`
 * provider, plus the phase-2 sandbox/http/sessions/env slices. Callers import
 * from here instead of reaching into a low-level factory with an implicit
 * connection.
 *
 * `overrides.connect` is a test seam only: tests inject a fast in-memory
 * connection. Production callers never pass it (defaults to a real DB open).
 */
export function createProdServices(overrides: {
  connect?: () => Promise<TenancyConnection>;
} = {}) {
  const connect = overrides.connect ?? (async () => createScriptConnection());
  const identity = createIdentity({ connect });
  const firstRun = createFirstRun({ connect });
  const soleMembership = createSoleMembership({ connect });
  const serverSecrets = resolveServerSecrets();

  const byoSandboxClientFactory: RootByoSandboxClientFactory = (opts) =>
    createSandboxClient(opts);
  const vercelFsClientFactory: RootVercelFsClientFactory = (opts) =>
    createVercelSandboxClient(opts);

  // Server session-store paths construct the Redis store at the root (the
  // harnessSessionsRedis seam consumes the registered factory). The registered
  // factory is the same root `createSessionStore` exposed below (NOT a bare
  // `new RedisSessionStore()`), so the live prod path receives the env-resolved
  // `url`/`ttlMs` from the root; the store body never reads `process.env`
  // (adversarial L1 + nit L8 follow-up).
  registerSessionStoreFactoryForServer(createSessionStore);

  return {
    tenantKeys: createTenantKeys({ connect }),
    authenticate: createAuthenticate({ connect }),
    adminContext: createAdminContext({ connect }),
    harnessSessions: createHarnessSessions({ connect }),
    identity,
    firstRun,
    listTenantMembers: createListTenantMembers({ connect }),
    manageSandbox: createManageSandbox({ connect }),
    providerSecrets: createProviderSecrets({ connect }),
    resolveInference: createResolveInference({ connect }),
    resolveInferenceForRequest: createResolveInferenceForRequest({ connect }),
    resolveSandbox: createResolveSandbox({
      connect,
      createByoClient: byoSandboxClientFactory,
      createVercelClient: vercelFsClientFactory,
    }),
    rotateSandboxToken: createRotateSandboxToken({ connect }),
    rotateTenantDek: createRotateTenantDek({ connect }),
    soleMembership,
    userGithubToken: createUserGithubToken({ connect }),
    userMcpServers: createUserMcpServers({ connect }),
    userPreferredSandbox: createUserPreferredSandbox({ connect }),
    userSandboxInstance: createUserSandboxInstance({ connect }),
    harnessSessionsRedis: createHarnessSessionsRedis({
      loadSoleMembership: soleMembership.loadSoleMembership,
    }),
    scim: createScimHandlers({ ...identity, IdentityError }),
    /** Server secrets resolved once here (route adds them to redaction). */
    serverSecrets,
    /**
     * Request-scoped handlers, constructed at the root so callers never reach
     * into a low-level factory with implicit defaults.
     */
    createHttpRunner: (opts: VercelSandboxHttpRunnerOptions): HttpFetchRunner =>
      createVercelSandboxHttpRunner(opts),
    createByoSandboxClient: byoSandboxClientFactory,
    createVercelFsSandboxClient: vercelFsClientFactory,
    /** Root factory for the Redis session store, also registered as the server seam. */
    createSessionStore,
  };
}

/**
 * Root factory for the Redis session store. Resolves `url`/`ttlMs` from the env
 * once at the root (`REDIS_URL` / `SESSION_REDIS_TTL_MS`) and passes them to
 * `RedisSessionStore` explicitly. The store itself no longer reads `process.env`
 * (adversarial nit L8 follow-up) — the root is the single owner of the Redis env
 * reads and the legacy-env deprecation warning. `client` is the injectable test seam.
 */
function createSessionStore(
  opts: Omit<RedisSessionStoreOptions, 'url' | 'ttlMs'> & {
    url?: string;
    ttlMs?: number;
  } = {},
): RedisSessionStore {
  return new RedisSessionStore({
    client: opts.client,
    url: opts.url ?? resolveRedisUrl(),
    ttlMs: opts.ttlMs ?? resolveRedisTtlMs(),
  });
}
