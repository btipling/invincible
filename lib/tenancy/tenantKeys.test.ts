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
  decryptSecret,
  encryptSecret,
} from './credentials';
import {
  backfillTenantDeks,
  decryptTenantSecret,
  encryptTenantSecret,
  ensureTenantDek,
  generateTenantDek,
  loadTenantDek,
  unwrapTenantDek,
  wrapTenantDek,
} from './tenantKeys';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../db/migrations');

async function applyMigrations(client: PGlite) {
  for (const name of [
    '0000_tenancy_phase1.sql',
    '0001_sso_scim_identity.sql',
    '0002_tenant_deks.sql',
  ]) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await client.exec(stmt);
    }
  }
}

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
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const amk = testAmk(5);

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client.close();
  });

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
      .select({ ct: tenants.dekCiphertext })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    expect(row[0]?.ct).toBeTruthy();
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
      })
      .from(tenants)
      .where(eq(tenants.id, id))
      .limit(1);
    expect(tenantRow[0]?.ct).toBeTruthy();
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
    expect(() => decryptSecret(sb[0]!.ct, amk)).toThrow(CredentialsError);
    expect(decryptSecret(sb[0]!.ct, dek)).toBe(legacyToken);
    expect(sb[0]!.ver).toBe(tenantRow[0]!.ver);

    const second = await backfillTenantDeks({ db: db as never, amk });
    expect(second.tenantsUpdated).toBe(0);
    expect(second.sandboxesReencrypted).toBe(0);
  });
});
