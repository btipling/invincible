/**
 * Connect-only proof for the composition root (phase 1 — #440).
 *
 * The Major concern from the #442 adversarial review: factories wired with
 * `createProdServices({ connect })` must be able to complete *nested* calls
 * that internally resolve `loadSoleMembership` (e.g. user github token / MCP /
 * preferred-sandbox / sandbox-instance). Those nested lookups used to forward
 * only `{ db: deps.db }`, which is undefined on the connect-only prod path —
 * dropping `connect` and turning every membership lookup into a firm
 * `unavailable`. These tests exercise that path end-to-end (real PGlite under
 * the injected `connect`, no bare `db` handle at any call site) and would fail
 * on the pre-fix `{ db: deps.db }` forwarding.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProdServices } from './index';
import * as schema from '../../db/schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../db/migrations');

async function applyMigrations(client: PGlite) {
  for (const name of [
    '0000_tenancy_phase1.sql',
    '0001_sso_scim_identity.sql',
    '0002_tenant_deks.sql',
    '0003_provider_secrets.sql',
    '0004_user_mcp_servers.sql',
    '0005_sandbox_backend.sql',
    '0006_user_github_tokens.sql',
    '0007_user_preferred_sandbox.sql',
    '0008_user_sandbox_instances.sql',
  ]) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    for (const stmt of sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await client.exec(stmt);
    }
  }
}

const AMK = Buffer.alloc(32, 42);

describe('createProdServices connect-only (no injected db)', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let tenantId: string;
  let adminUserId: string;
  let memberUserId: string;
  let sandboxId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await db.delete(schema.userPreferredSandbox);
    await db.delete(schema.userGithubTokens);
    await db.delete(schema.sandboxGrants);
    await db.delete(schema.sandboxes);
    await db.delete(schema.userSandboxInstances);
    await db.delete(schema.tenantMembers);
    await db.delete(schema.users);
    await db.delete(schema.tenants);

    const [tenant] = await db
      .insert(schema.tenants)
      .values({ slug: 'acme', name: 'Acme' })
      .returning({ id: schema.tenants.id });
    tenantId = tenant.id;

    const [admin] = await db
      .insert(schema.users)
      .values({ email: 'admin@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    adminUserId = admin.id;

    const [member] = await db
      .insert(schema.users)
      .values({ email: 'member@example.com', status: 'active' })
      .returning({ id: schema.users.id });
    memberUserId = member.id;

    await db.insert(schema.tenantMembers).values([
      { tenantId, userId: adminUserId, role: 'owner' },
      { tenantId, userId: memberUserId, role: 'member' },
    ]);

    const [sb] = await db
      .insert(schema.sandboxes)
      .values({
        tenantId,
        name: 'Workspace',
        slug: 'workspace',
        backend: 'vercel',
        status: 'active',
      })
      .returning({ id: schema.sandboxes.id });
    sandboxId = sb.id;

    await db.insert(schema.sandboxGrants).values({
      sandboxId,
      userId: memberUserId,
      canRead: true,
      canWrite: true,
    });
  });

  /**
   * Wire the whole production root to a per-call `connect` provider. No `db`
   * handle is ever forwarded at a call site; every DB access (including nested
   * `loadSoleMembership` exclusive to this path) must resolve through `connect`.
   */
  const services = () =>
    createProdServices({
      connect: async () => ({ db: db as never, close: async () => {} }),
    });

  it('soleMembership resolves through connect alone', async () => {
    const res = await services().soleMembership.loadSoleMembership(memberUserId);
    expect(res).toEqual({ ok: true, tenantId, role: 'member' });
  });

  it('listUserSandboxChoices completes nested membership via connect', async () => {
    const res = await services().userPreferredSandbox.listUserSandboxChoices(
      memberUserId,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    // membership resolved (not 'unavailable') and the grant surfaced as usable.
    expect(res.value.options.map((o) => o.sandboxId)).toContain(sandboxId);
    expect(res.value.options.find((o) => o.sandboxId === sandboxId)?.usable).toBe(
      true,
    );
  });

  it('setUserGithubToken completes nested membership + DEK via connect', async () => {
    const res = await services().userGithubToken.setUserGithubToken(
      adminUserId,
      'ghp_connect_only_proof',
      { amk: AMK },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    const status = await services().userGithubToken.getUserGithubTokenStatus(
      adminUserId,
      { amk: AMK },
    );
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(status.error);
    expect(status.value.configured).toBe(true);
  });
});
