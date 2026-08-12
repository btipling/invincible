/**
 * Precomputed bcrypt fixture hash for use in tenancy DB test setup.
 *
 * Generating a real cost-12 bcrypt hash in `beforeAll`/setup is the per-file
 * setup tax that buffs the full `vitest run` (see #431 / plan #432).
 * These constants let setup run **zero** real `bcrypt.hash` calls while the
 * code under test (`verifyPassword` / `authenticateCredentials`) still performs
 * the **real** `bcrypt.compare` against the fixture.
 *
 * `FIXTURE_PASSWORD_HASH` is a valid cost-12 bcrypt hash of `FIXTURE_LOGIN`,
 * generated once at implementation time with the repo's `bcryptjs` (cost 12)
 * and committed literally.
 */
export const FIXTURE_LOGIN = 'correct-horse-battery';

export const FIXTURE_PASSWORD_HASH =
  '$2a$12$1RDM1hktOhUAPq7gd1crTeu9t7FcDuI/nitQmv5MJ.ygKUma2HU76';
