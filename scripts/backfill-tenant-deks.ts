/**
 * Operator CLI: backfill tenant DEKs + re-encrypt sandbox tokens under DEKs.
 *
 * Primary operator path: GitHub Actions workflow `db-tenancy-backfill-deks`
 * (workflow_dispatch, confirm=backfill). This script is what the job runs.
 * Cloud agent may invoke the same entrypoint; personal-laptop npm is not the
 * official Production path.
 *
 * PRODUCTION GATE:
 * Do **not** run against a database while the live app can only decrypt sandbox
 * tokens with AMK. Re-encrypting under tenant DEKs breaks resolve/login/tools
 * until dual-read (default) or DEK-only app is live.
 *
 * Hard refuse without ALLOW_TENANT_DEK_BACKFILL=1.
 * Safe on: PGlite tests, throwaway DBs, or Production **after** dual-read is live.
 *
 * Env: DATABASE_URL, CREDENTIALS_ENCRYPTION_KEY (AMK dual-store identity),
 *      ALLOW_TENANT_DEK_BACKFILL=1
 * Prints counts JSON only — never logs secrets.
 */
import { createScriptConnection } from '../lib/di';
import { createTenantKeys } from '../lib/tenancy/tenantKeys';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  if (!process.env.CREDENTIALS_ENCRYPTION_KEY?.trim()) {
    console.error('CREDENTIALS_ENCRYPTION_KEY is required');
    process.exit(1);
  }
  if (process.env.ALLOW_TENANT_DEK_BACKFILL !== '1') {
    console.error(
      'Refusing: set ALLOW_TENANT_DEK_BACKFILL=1 only after dual-read ' +
        '(or DEK-only app) is live. Early Production backfill bricks AMK-only resolve. ' +
        'Prefer GHA db-tenancy-backfill-deks (confirm=backfill).',
    );
    process.exit(1);
  }

  const conn = createScriptConnection();
  try {
    const result = await createTenantKeys({ db: conn.db }).backfillTenantDeks();
    console.log(
      JSON.stringify({
        tenantsUpdated: result.tenantsUpdated,
        sandboxesReencrypted: result.sandboxesReencrypted,
      }),
    );
  } finally {
    await conn.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'backfill failed');
  process.exit(1);
});
