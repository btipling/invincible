/**
 * Shared tenancy test engine (phase 3 — parent #438).
 *
 * One in-memory PGlite for the whole tenancy suite, booted once and shared
 * **across** test files via the tenancy-scoped vitest `projects` entry in
 * `vitest.config.ts` (`pool: 'forks'`, `forks.singleFork: true`,
 * `isolate: false`). Without that config, Vitest loads each file in an
 * isolated worker and a module-level singleton here is fresh per file — the
 * "19 cold WASM Postgres boots → 1" payoff would silently not happen.
 *
 * This is the **only** file in the repo allowed to call `new PGlite(` (see
 * `scripts/di-gate.mjs`). Tests never boot their own engine; they call
 * `getSharedDb()` and reset via `resetTenantTables()` (or, for the documented
 * rotateTenantDek DROP-TABLE carve-out, `createIsolatedTestDb()`).
 *
 * All migrations (0000–0015) are applied once so every table exists regardless
 * of which tenancy module a given test file exercises.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../../db/schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../../db/migrations');

const MIGRATIONS = [
  '0000_tenancy_phase1.sql',
  '0001_sso_scim_identity.sql',
  '0002_tenant_deks.sql',
  '0003_provider_secrets.sql',
  '0004_user_mcp_servers.sql',
  '0005_sandbox_backend.sql',
  '0006_user_github_tokens.sql',
  '0007_user_preferred_sandbox.sql',
  '0008_user_sandbox_instances.sql',
  '0009_harness_sessions.sql',
  '0010_user_personas.sql',
  '0011_user_skills.sql',
  '0012_user_skill_versions.sql',
  '0013_always_on_skills.sql',
  '0014_recommended_skills.sql',
  '0015_user_persona_versions.sql',
];

/**
 * Apply each migration file as a single multi-statement exec (still in file
 * order). PGlite `exec` runs several semicolon-separated statements; the
 * `--> statement-breakpoint` markers are a drizzle artifact and safe to drop.
 */
async function applyMigrations(client: PGlite): Promise<void> {
  for (const name of MIGRATIONS) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8')
      .split('--> statement-breakpoint')
      .join('')
      .trim();
    if (sql) {
      await client.exec(sql);
    }
  }
}

export type SharedEngine = {
  /** Drizzle handle over the shared PGlite (cast to `never` where Db differs). */
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** Underlying PGlite; used by the rare test that runs a raw information_schema query. */
  client: PGlite;
};

let enginePromise: Promise<SharedEngine> | undefined;

async function getSharedEngineInternal(): Promise<SharedEngine> {
  const client = new PGlite();
  await applyMigrations(client);
  return {
    db: drizzle(client, { schema }) as unknown as ReturnType<
      typeof drizzle<typeof schema>
    >,
    client,
  };
}

/** Boot (once) and return the shared tenancy engine. */
export function getSharedEngine(): Promise<SharedEngine> {
  if (!enginePromise) {
    enginePromise = getSharedEngineInternal();
  }
  return enginePromise;
}

/** Convenience accessor for the shared drizzle db. */
export async function getSharedDb(): Promise<SharedEngine['db']> {
  return (await getSharedEngine()).db;
}

/** Convenience accessor for the shared PGlite client. */
export async function getSharedClient(): Promise<PGlite> {
  return (await getSharedEngine()).client;
}

/**
 * Clear every tenancy table in FK order (children before parents) so no
 * cross-file bleed is possible on the single shared engine. The order covers
 * all tables from migrations 0000–0015.
 */
export const RESET_TABLES = [
  schema.harnessSessions,
  schema.userPersonaVersions,
  schema.userPersonas,
  schema.userSkillVersions,
  schema.userSkills,
  schema.userSandboxInstances,
  schema.userPreferredSandbox,
  schema.userGithubTokens,
  schema.userMcpServers,
  schema.providerSecretGrants,
  schema.providerSecretModels,
  schema.providerSecrets,
  schema.sandboxGrants,
  schema.sandboxes,
  schema.tenantMembers,
  schema.users,
  schema.tenants,
] as const;

export async function resetTenantTables(): Promise<void> {
  const { db } = await getSharedEngine();
  for (const table of RESET_TABLES) {
    await db.delete(table);
  }
}

/**
 * Carve-out factory for the documented mutate-happy test
 * (`rotateTenantDek.test.ts`'s second describe, which DROPs the
 * `user_github_tokens` table to simulate deploy-before-migrate). Such a DROP
 * cannot happen on the shared engine (it would break every later file that
 * uses that table), so this boots an **isolated** engine whose schema the
 * caller may mutate freely. The caller must `close()` it in `afterAll`.
 */
export async function createIsolatedTestDb(): Promise<{
  db: ReturnType<typeof drizzle<typeof schema>>;
  client: PGlite;
  close: () => Promise<void>;
}> {
  const client = new PGlite();
  await applyMigrations(client);
  return {
    db: drizzle(client, { schema }),
    client,
    close: () => client.close(),
  };
}
