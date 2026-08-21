#!/usr/bin/env node
/**
 * drizzle-journal-gate — fail closed if `db/migrations/*.sql` is not listed in
 * `meta/_journal.json` (or a journal tag has no matching SQL file).
 *
 * `drizzle-kit migrate` applies **journal tags only**. SQL on disk without a
 * journal entry is a silent no-op (Production #735: 0012–0014 existed, migrate
 * reported success, Settings SELECT is_always_on failed closed as unavailable).
 *
 * Run from `npm test`, `npm run db:migrate`, and GHA db-migrate / DEK-backfill
 * before `drizzle-kit migrate`.
 *
 * `DRIZZLE_JOURNAL_MIGRATIONS_DIR` (optional) overrides the migrations dir so
 * the gate can be exercised against a fixture (used by the vitest tempdir
 * spawn tests); it defaults to the repo `db/migrations`. The override is honored
 * **only when `VITEST` is set** so a leftover export can never desync the gate
 * from `drizzle-kit migrate` (which always uses `drizzle.config.ts` `out`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir =
  process.env.VITEST && process.env.DRIZZLE_JOURNAL_MIGRATIONS_DIR
    ? process.env.DRIZZLE_JOURNAL_MIGRATIONS_DIR
    : join(root, 'db/migrations');
const journalPath = join(migrationsDir, 'meta/_journal.json');

const sqlFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const sqlTags = sqlFiles.map((f) => f.slice(0, -'.sql'.length));

let journal;
try {
  journal = JSON.parse(readFileSync(journalPath, 'utf8'));
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`drizzle-journal-gate: cannot read ${journalPath}: ${msg}`);
  process.exit(1);
}

if (!Array.isArray(journal?.entries)) {
  console.error('drizzle-journal-gate: _journal.json has no entries[]');
  process.exit(1);
}

const journalTags = journal.entries.map((e) => e.tag);
const errors = [];

for (const tag of sqlTags) {
  if (!journalTags.includes(tag)) {
    errors.push(
      `${tag}.sql is not in _journal.json — drizzle-kit migrate will skip it`,
    );
  }
}

const seen = new Set();
for (let i = 0; i < journal.entries.length; i++) {
  const e = journal.entries[i];
  if (typeof e?.tag !== 'string' || e.tag.length === 0) {
    errors.push(`journal entries[${i}] missing tag`);
    continue;
  }
  if (e.idx !== i) {
    errors.push(
      `journal tag ${e.tag}: idx ${e.idx} at position ${i} (expected sequential 0..n-1)`,
    );
  }
  if (!sqlTags.includes(e.tag)) {
    errors.push(`journal tag ${e.tag} has no ${e.tag}.sql`);
  }
  if (seen.has(e.tag)) {
    errors.push(`duplicate journal tag ${e.tag}`);
  }
  seen.add(e.tag);
}

if (errors.length > 0) {
  console.error('drizzle-journal-gate FAILED:');
  for (const line of errors) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(
  `drizzle-journal-gate: ${sqlTags.length} SQL files match _journal.json.`,
);
