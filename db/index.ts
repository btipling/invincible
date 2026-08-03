import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type DbClient = ReturnType<typeof postgres>;
export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Server-only Postgres client. Prefer a **pooled** DATABASE_URL on Vercel
 * (Neon pooler / PgBouncer).
 *
 * Caller **must** `await client.end()` when finished (see seed script).
 * Do not use from long-lived request handlers without a shared pool strategy.
 */
export function createDbConnection(connectionString?: string): {
  db: Db;
  client: DbClient;
} {
  const url = (connectionString ?? process.env.DATABASE_URL)?.trim();
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  // prepare: false is required for many poolers (Neon, PgBouncer transaction mode)
  const client = postgres(url, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });
  return { db, client };
}

export * from './schema';
