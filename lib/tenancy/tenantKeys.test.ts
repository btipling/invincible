import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../db/schema';
import { sandboxes, tenants } from '../../db/schema';
import {
  CredentialsError,
  CURRENT_KEK_VERSION,
  decryptSecret,
  encryptSecret,
} from './credentials';
import {
  backfillTenantDeks,
  decryptSandboxToken,
  decryptSandboxTokenCutover,
  decryptTenantSecret,
  encryptTenantSecret,
  ensureTenantDek,
  generateTenantDek,
  loadTenantDek,
  resolveTokenDecryptMode,
  unwrapTenantDek,
  wrapTenantDek,
} from './tenantKeys';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../db/migrations');

/**
 * Apply each migration file as a single multi-statement exec (still in file
 * order) rather than one round-trip per `--> statement-breakpoint` chunk.
 * PGlite `exec` runs several semicolon-separated statements; the breakpoint
 * markers are a drizzle artifact and safe to drop.
 */
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
  ]) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8')
      .split('--> statement-breakpoint')
      .join('')
      .trim();
    if (sql) {
      await client.exec(sql);
    }
  }
}

/**
 * One in-memory PGlite for the whole file, booted once (previously one per
 * describe). Both describes share it and isolate via their own delete-and-reseed
 * beforeEach — PGlite's single-connection mutex deadlocks when a raw
 * SAVEPOINT/transaction straddles drizzle calls against the shared `db`.
 */
let client!: PGlite;
let db!: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = new PGlite();
  await applyMigrations(client);
  db = drizzle(client, { schema });
});

afterAll(async () => {
  await client?.close();
});

function testAmk(fill = 7): Buffer {
  return Buffer.alloc(32, fill);
}

describe('wrapTenantDek / unwrapTenantDek', () => {
  const amk = testAmk();

  it('round-trips DEK', () => {
    const dek = generateTenantDek();
    expect(dek.length).toBe(32);
    const wrapped = wrapTenantDek(dek, amk);
    expect(wrapped.startsWith('v1:')).toBe(true);
    const out = unwrapTenantDek(wrapped, amk);
    expect(out.equals(dek)).toBe(true);
  });

  it('fails with wrong AMK', () => {
    const dek = generateTenantDek();
    const wrapped = wrapTenantDek(dek, amk);
    expect(() => unwrapTenantDek(wrapped, testAmk(9))).toThrow(CredentialsError);
  });

  it('rejects non-32-byte DEK on wrap', () => {
    expect(() => wrapTenantDek(Buffer.alloc(16), amk)).toThrow(/32 bytes/);
  });

  it('rejects wrong length plaintext after unwrap', () => {
    // encrypt a short base64 payload with AMK as if it were a DEK wrap
    const short = Buffer.alloc(8, 1).toString('base64');
    const fake = encryptSecret(short, amk);
    expect(() => unwrapTenantDek(fake, amk)).toThrow(/32 bytes/);
  });
});

describe('tenantKeys (pglite)', () => {
  const amk = testAmk(5);

  beforeEach(async () => {
    await client.exec('DELETE FROM sandboxes');
    await client.exec('DELETE FROM tenants');
  });

  async function insertTenant(slug: string) {
    const rows = await db
      .insert(tenants)
      .values({ slug, name: slug, settings: {} })
      .returning({ id: tenants.id });
    return rows[0]!.id;
  }

  it('ensureTenantDek creates once; second call same version and DEK', async () => {
    const id = await insertTenant('t-ensure');
    const first = await ensureTenantDek(id, { db: db as never, amk });
    expect(first.dek.length).toBe(32);
    expect(first.version).toBe(1);

    const second = await ensureTenantDek(id, { db: db as never, amk });
    expect(second.version).toBe(first.version);
    expect(second.dek.equals(first.dek)).toBe(true);

    const row = await db
      .select({
        ct: tenants.dekCiphertext,
        amkVer: tenants.amkVersion,
      })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    expect(row[0]?.ct).toBeTruthy();
    expect(row[0]?.amkVer).toBe(CURRENT_KEK_VERSION);
    expect(unwrapTenantDek(row[0]!.ct!, amk).equals(first.dek)).toBe(true);
  });

  it('loadTenantDek fails closed when missing', async () => {
    const id = await insertTenant('t-load-miss');
    await expect(loadTenantDek(id, { db: db as never, amk })).rejects.toThrow(
      /not provisioned/,
    );
  });

  it('encryptTenantSecret → decryptTenantSecret same tenant', async () => {
    const id = await insertTenant('t-enc');
    const { ciphertext, dekVersion } = await encryptTenantSecret(
      id,
      'sandbox-token-xyz',
      { db: db as never, amk },
    );
    expect(dekVersion).toBe(1);
    const plain = await decryptTenantSecret(id, ciphertext, {
      db: db as never,
      amk,
    });
    expect(plain).toBe('sandbox-token-xyz');
  });

  it('tenant B DEK cannot decrypt tenant A ciphertext', async () => {
    const a = await insertTenant('tenant-a');
    const b = await insertTenant('tenant-b');
    const { ciphertext } = await encryptTenantSecret(a, 'secret-a', {
      db: db as never,
      amk,
    });
    // ensure B has its own DEK
    await ensureTenantDek(b, { db: db as never, amk });
    await expect(
      decryptTenantSecret(b, ciphertext, { db: db as never, amk }),
    ).rejects.toThrow(CredentialsError);
  });

  it('backfill re-encrypts legacy AMK tokens and is idempotent', async () => {
    const id = await insertTenant('t-backfill');
    const legacyToken = 'legacy-sandbox-token';
    const legacyCt = encryptSecret(legacyToken, amk);

    await db.insert(sandboxes).values({
      tenantId: id,
      name: 'Default',
      slug: 'default',
      baseUrl: 'http://127.0.0.1:8787/',
      tokenCiphertext: legacyCt,
      tokenKekVersion: 1,
      status: 'active',
    });

    // tenant starts with null DEK
    const pre = await db
      .select({ ct: tenants.dekCiphertext })
      .from(tenants)
      .where(eq(tenants.id, id));
    expect(pre[0]?.ct).toBeNull();

    const first = await backfillTenantDeks({ db: db as never, amk });
    expect(first.tenantsUpdated).toBe(1);
    expect(first.sandboxesReencrypted).toBe(1);

    const tenantRow = await db
      .select({
        ct: tenants.dekCiphertext,
        ver: tenants.dekVersion,
        amkVer: tenants.amkVersion,
      })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    expect(tenantRow[0]?.ct).toBeTruthy();
    expect(tenantRow[0]?.amkVer).toBe(CURRENT_KEK_VERSION);
    const dek = unwrapTenantDek(tenantRow[0]!.ct!, amk);

    const sb = await db
      .select({
        ct: sandboxes.tokenCiphertext,
        ver: sandboxes.tokenKekVersion,
      })
      .from(sandboxes)
      .where(eq(sandboxes.tenantId, id))
      .limit(1);

    // no longer decryptable with AMK
    expect(() => decryptSecret(sb[0]!.ct!, amk)).toThrow(CredentialsError);
    expect(decryptSecret(sb[0]!.ct!, dek)).toBe(legacyToken);
    expect(sb[0]!.ver).toBe(tenantRow[0]!.ver);

    const second = await backfillTenantDeks({ db: db as never, amk });
    expect(second.tenantsUpdated).toBe(0);
    expect(second.sandboxesReencrypted).toBe(0);
  });

  it('backfill skips null/empty tokenCiphertext (vercel rows)', async () => {
    const id = await insertTenant('t-backfill-vercel');
    await db.insert(sandboxes).values([
      {
        tenantId: id,
        name: 'Vercel',
        slug: 'vercel',
        backend: 'vercel',
        image: 'vercel/sandbox/node:24',
        baseUrl: null,
        tokenCiphertext: null,
        tokenKekVersion: 1,
        status: 'active',
      },
      {
        tenantId: id,
        name: 'Legacy',
        slug: 'legacy',
        backend: 'byo',
        baseUrl: 'http://127.0.0.1:8787/',
        tokenCiphertext: encryptSecret('legacy-only', amk),
        tokenKekVersion: 1,
        status: 'active',
      },
    ]);

    const result = await backfillTenantDeks({ db: db as never, amk });
    expect(result.tenantsUpdated).toBe(1);
    // only the legacy BYO row counts as re-encrypted
    expect(result.sandboxesReencrypted).toBe(1);

    const rows = await db
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.tenantId, id));
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));
    expect(bySlug.vercel.tokenCiphertext).toBeNull();
    expect(bySlug.vercel.tokenKekVersion).toBe(1);

    const tenantRow = await db
      .select({ ct: tenants.dekCiphertext, ver: tenants.dekVersion })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    const dek = unwrapTenantDek(tenantRow[0]!.ct!, amk);
    expect(decryptSecret(bySlug.legacy.tokenCiphertext!, dek)).toBe(
      'legacy-only',
    );
    expect(bySlug.legacy.tokenKekVersion).toBe(tenantRow[0]!.ver);
  });

  it('backfill fails closed on corrupt sandbox token (no silent skip)', async () => {
    const id = await insertTenant('t-corrupt');
    await db.insert(sandboxes).values({
      tenantId: id,
      name: 'Default',
      slug: 'default',
      baseUrl: 'http://127.0.0.1:8787/',
      tokenCiphertext: 'v1:not:valid:ciphertext',
      tokenKekVersion: 1,
      status: 'active',
    });

    await expect(
      backfillTenantDeks({ db: db as never, amk }),
    ).rejects.toThrow(/AMK and tenant DEK/);
  });
});

describe('decryptSandboxTokenCutover / mode', () => {
  const amk = testAmk(11);

  beforeEach(async () => {
    await client.exec('DELETE FROM sandboxes');
    await client.exec('DELETE FROM tenants');
  });

  async function insertTenant(slug: string) {
    const rows = await db
      .insert(tenants)
      .values({ slug, name: slug, settings: {} })
      .returning({ id: tenants.id });
    return rows[0]!.id;
  }

  it('dual-read: AMK legacy when DEK missing', async () => {
    const id = await insertTenant('t-legacy');
    const legacy = encryptSecret('legacy-token', amk);
    const plain = await decryptSandboxTokenCutover(id, legacy, {
      db: db as never,
      amk,
    });
    expect(plain).toBe('legacy-token');
  });

  it('dual-read: prefers DEK when provisioned', async () => {
    const id = await insertTenant('t-pref');
    const { ciphertext } = await encryptTenantSecret(id, 'dek-token', {
      db: db as never,
      amk,
    });
    const plain = await decryptSandboxTokenCutover(id, ciphertext, {
      db: db as never,
      amk,
    });
    expect(plain).toBe('dek-token');
    // still dual-read works for leftover AMK ciphertext after DEK exists
    const leftover = encryptSecret('still-amk', amk);
    expect(
      await decryptSandboxTokenCutover(id, leftover, { db: db as never, amk }),
    ).toBe('still-amk');
  });

  it('dek-only: rejects AMK-only ciphertext', async () => {
    const id = await insertTenant('t-strict');
    await ensureTenantDek(id, { db: db as never, amk });
    const legacy = encryptSecret('legacy-only', amk);
    await expect(
      decryptSandboxToken(id, legacy, {
        db: db as never,
        amk,
        mode: 'dek-only',
      }),
    ).rejects.toThrow(CredentialsError);
  });

  it('resolveTokenDecryptMode defaults to dual', () => {
    expect(resolveTokenDecryptMode({})).toBe('dual');
    expect(resolveTokenDecryptMode({ TENANT_TOKEN_DECRYPT_MODE: 'weird' })).toBe(
      'dual',
    );
    expect(
      resolveTokenDecryptMode({ TENANT_TOKEN_DECRYPT_MODE: 'dek-only' }),
    ).toBe('dek-only');
  });
});
