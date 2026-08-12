/**
 * Composition root (phase 1 — parent #438 / phase #440).
 *
 * This is the **only** production construction point for the tenancy DB
 * factories. Modules never open/close a connection themselves; they receive a
 * `connect` provider (or a live `db`) and resolve through `withConnection`.
 *
 * Design choices:
 * - `connect` returns a fresh connection per call (mirrors the previous
 *   per-call open/close behavior; safe for serverless request scopes and
 *   scripts). The provider owns the lifecycle; `withConnection` closes it.
 * - `createScriptConnection()` exposes a closeable `{ db, close }` slice so
 *   scripts (seed / backfill) teardown at their wiring site without calling
 *   `createDbConnection()` directly.
 */
import { createDbConnection } from '../../db';
import { type TenancyConnection } from './withConnection';
import { createTenantKeys } from '../tenancy/tenantKeys';
import { createAuthenticate } from '../tenancy/authenticate';
import { createAdminContext } from '../tenancy/adminContext';
import { createHarnessSessions } from '../tenancy/harnessSessions';
import { createIdentity, IdentityError } from '../tenancy/identity';
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
import { createScimHandlers } from '../tenancy/scimHandlers';

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
 * provider. Callers import from here instead of reaching into a low-level
 * factory with an implicit connection.
 *
 * `overrides.connect` is a test seam only: tests inject a fast in-memory
 * connection. Production callers never pass it (defaults to a real DB open).
 */
export function createProdServices(overrides: {
  connect?: () => Promise<TenancyConnection>;
} = {}) {
  const connect = overrides.connect ?? (async () => createScriptConnection());
  const identity = createIdentity({ connect });
  const soleMembership = createSoleMembership({ connect });
  return {
    tenantKeys: createTenantKeys({ connect }),
    authenticate: createAuthenticate({ connect }),
    adminContext: createAdminContext({ connect }),
    harnessSessions: createHarnessSessions({ connect }),
    identity,
    listTenantMembers: createListTenantMembers({ connect }),
    manageSandbox: createManageSandbox({ connect }),
    providerSecrets: createProviderSecrets({ connect }),
    resolveInference: createResolveInference({ connect }),
    resolveInferenceForRequest: createResolveInferenceForRequest({ connect }),
    resolveSandbox: createResolveSandbox({ connect }),
    rotateSandboxToken: createRotateSandboxToken({ connect }),
    rotateTenantDek: createRotateTenantDek({ connect }),
    soleMembership,
    userGithubToken: createUserGithubToken({ connect }),
    userMcpServers: createUserMcpServers({ connect }),
    userPreferredSandbox: createUserPreferredSandbox({ connect }),
    userSandboxInstance: createUserSandboxInstance({ connect }),
    harnessSessionsRedis: createHarnessSessionsRedis({ loadSoleMembership: soleMembership.loadSoleMembership }),
    scim: createScimHandlers({ ...identity, IdentityError }),
  };
}
