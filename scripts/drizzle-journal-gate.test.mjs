import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Locks the #735 direction that `drizzle-journal-gate.mjs` exists for: SQL on
// disk without a matching journal tag is a silent no-op for drizzle-kit
// migrate, so the gate must fail closed on it. Runs the real script as a
// subprocess against temp fixtures via the DRIZZLE_JOURNAL_MIGRATIONS_DIR
// override, so it exercises the CLI exit-code contract, not just a pure helper.

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'drizzle-journal-gate.mjs',
);

function makeFixture({ sqlTags = [], entries = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'dq-journal-gate-'));
  mkdirSync(join(dir, 'meta'), { recursive: true });
  for (const tag of sqlTags) writeFileSync(join(dir, `${tag}.sql`), 'SELECT 1;\n');
  writeFileSync(
    join(dir, 'meta/_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
  );
  return dir;
}

function runGate(migrationsDir) {
  return execFileSync(process.execPath, [scriptPath], {
    env: { ...process.env, DRIZZLE_JOURNAL_MIGRATIONS_DIR: migrationsDir },
    encoding: 'utf8',
  });
}

describe('drizzle-journal-gate fail-closed directions', () => {
  it('exits 0 when every SQL file has a journal tag (happy path)', () => {
    const dir = makeFixture({
      sqlTags: ['0001_x', '0002_y'],
      entries: [
        { idx: 0, tag: '0001_x' },
        { idx: 1, tag: '0002_y' },
      ],
    });
    try {
      const out = runGate(dir);
      expect(out).toMatch(/2 SQL files match _journal\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails (#735 direction): SQL file on disk missing from the journal', () => {
    const dir = makeFixture({
      sqlTags: ['0001_x', '0003_orphan'],
      entries: [{ idx: 0, tag: '0001_x' }],
    });
    let err = '';
    let code = 0;
    try {
      runGate(dir);
    } catch (e) {
      err = String(e?.stderr ?? e);
      code = e?.status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(code).toBe(1);
    expect(err).toContain('0003_orphan.sql is not in _journal.json');
  });

  it('fails: journal tag has no matching SQL file', () => {
    const dir = makeFixture({
      sqlTags: ['0001_x'],
      entries: [
        { idx: 0, tag: '0001_x' },
        { idx: 1, tag: '0002_ghost' },
      ],
    });
    let err = '';
    let code = 0;
    try {
      runGate(dir);
    } catch (e) {
      err = String(e?.stderr ?? e);
      code = e?.status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(code).toBe(1);
    expect(err).toContain('0002_ghost has no 0002_ghost.sql');
  });
});
