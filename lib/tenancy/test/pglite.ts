import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll } from 'vitest';

import * as schema from '../../../db/schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '../../../db/migrations');

export type TenancyTestDb = {
  client: PGlite;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

/**
 * Boot one PGlite engine per test file and replay **all** tenancy migrations in
 * order, batched as **one `exec` per `.sql` file** (drizzle's
 * `--> statement-breakpoint` markers are a round-trip artifact and are dropped;
 * PGlite `exec` runs multiple semicolon-separated statements).
 *
 * Isolation guarantee (locked in plan #432): each test file owns its own engine.
 * Files keep their existing `beforeEach` DELETE isolation — never share one
 * process-wide engine, and **never** introduce raw `SAVEPOINT`/`db.transaction`
 * straddling the shared `db` (PGlite is single-connection).
 *
 * Migrations are discovered dynamically (`readdirSync` → `.sql`, sorted), so
 * adding a migration can never silently be missed by a test boot.
 */
export async function createTenancyTestDb(): Promise<TenancyTestDb> {
  const client = new PGlite();
  for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8')
      .split('--> statement-breakpoint')
      .join('')
      .trim();
    if (sql) {
      await client.exec(sql);
    }
  }
  const db = drizzle(client, { schema });
  afterAll(async () => {
    await client.close();
  });
  return { client, db };
}
