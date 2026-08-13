/**
 * First-run tenant boostrap (planet #459 / parent #473 phase 1 — issue #474).
 *
 * A tenant-less DB self-bootstraps in the browser: `/login` renders a sign-up
 * form that creates the first tenant + owner user + owner membership in one
 * transaction, then signs the owner in. This replaces the legacy fixed-tenant
 * bootstrap (a hard-coded `default` tenant), so a fresh fork with just
 * `db-migrate` needs no extra env and no laptop.
 *
 * Concurrency: first-run creation is serialized with a **transaction-scoped
 * advisory lock** (`pg_advisory_xact_lock`). A plain `SELECT … FOR UPDATE` on
 * a totally empty `tenants` table would not serialize (there is no pre-created
 * row to lock), so two concurrent sign-ups could both insert different slugs.
 * The advisory lock is held from before the in-tx re-count through commit, so
 * only the first survivor ever inserts; the loser fails `already_initialized`,
 * and `tenants.slug` UNIQUE is the final backstop.
 */
import { count, sql } from 'drizzle-orm';
import {
  tenantMembers,
  tenants,
  users,
  type Db,
} from '../../db';
import { withConnection, type TenancyConnection } from '../di/withConnection';
import { hashPassword, PASSWORD_MIN_LENGTH } from './password';

/**
 * Fixed transaction-scoped advisory lock key for first-run serialization.
 * Chosen to be distinctive; no other module in the repo uses advisory locks.
 */
export const FIRST_RUN_ADVISORY_LOCK_KEY = 12660730;

export type FirstRunDeps = {
  /** Injected DB (tests). When omitted, opens/closes a short-lived connection. */
  db?: Db;
  /** Injectable connect provider (module never constructs). */
  connect?: () => Promise<TenancyConnection>;
};

export type FirstRunInput = {
  tenantName: string;
  email: string;
  password: string;
};

export type FirstRunResult = {
  tenantId: string;
  userId: string;
  slug: string;
};

export class FirstRunError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_input' | 'already_initialized' | 'conflict' | 'db',
  ) {
    super(message);
    this.name = 'FirstRunError';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Mirrors `slugOk` in `lib/tenancy/manageSandbox.ts` (1–64 lower a-z0-9 + hyphens). */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Derive a tenant slug from the human tenant name (no fixed `default`).
 * Lowercases, strips punctuation/diacritics, collapses whitespace/_ into `-`.
 * Returns '' (→ invalid input) when nothing valid remains.
 */
export function slugifyTenantName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .replace(/[^a-z0-9\s_-]/g, '') // keep word chars, spaces, _ and -
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    if (typeof cur === 'object') {
      const o = cur as { code?: unknown; message?: unknown; cause?: unknown };
      if (o.code === '23505') return true;
      if (typeof o.message === 'string' && /unique|duplicate/i.test(o.message)) {
        return true;
      }
      cur = o.cause;
      continue;
    }
    if (typeof cur === 'string' && /unique|duplicate/i.test(cur)) return true;
    break;
  }
  return false;
}

/**
 * Whether the DB already has at least one tenant (== 0 → first-run).
 * Fail-open on connection errors is handled by the caller (login page defaults
 * to the existing login form); the boolean is always a well-formed DB read here.
 */
export async function hasAnyTenant(deps: FirstRunDeps = {}): Promise<boolean> {
  return withConnection(deps, async (db) => {
    const rows = await db.select({ n: count() }).from(tenants);
    return Number(rows[0]?.n ?? 0) > 0;
  });
}

/**
 * Create the first tenant + owner user + owner membership in ONE transaction
 * under a first-run advisory lock, re-checking the gate in-tx. Returns
 * `{ tenantId, userId, slug }`. No sandbox and no DEK are created at sign-up
 * (the owner provisions a sandbox later via `/admin/sandboxes`; the tenant DEK
 * is lazily ensured on the first sandbox token write by `ensureTenantDek`).
 *
 * Throws `FirstRunError`:
 * - `invalid_input` for empty/invalid tenant name, invalid email, or a password
 *   shorter than `PASSWORD_MIN_LENGTH` / containing whitespace;
 * - `already_initialized` when the DB already has a tenant (including a racer);
 * - `conflict` for a unique-violation backstop that somehow slipped through;
 * - `db` for any other persistence failure.
 */
export async function createFirstTenant(
  input: FirstRunInput,
  deps: FirstRunDeps = {},
): Promise<FirstRunResult> {
  const tenantName = (input?.tenantName ?? '').trim();
  const email = (input?.email ?? '').trim().toLowerCase();
  const password = input?.password ?? '';

  const slug = slugifyTenantName(tenantName);
  if (!tenantName) {
    throw new FirstRunError('Tenant name is required.', 'invalid_input');
  }
  if (!slug || slug.length > 64 || !SLUG_RE.test(slug)) {
    throw new FirstRunError(
      'Tenant name must be letters/numbers and produce a valid slug (hyphens allowed).',
      'invalid_input',
    );
  }
  if (!isValidEmail(email)) {
    throw new FirstRunError('A valid email address is required.', 'invalid_input');
  }
  if (
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN_LENGTH ||
    /\s/.test(password)
  ) {
    throw new FirstRunError(
      `Password must be at least ${PASSWORD_MIN_LENGTH} characters with no spaces.`,
      'invalid_input',
    );
  }

  const run = async (db: Db): Promise<FirstRunResult> => {
    return db.transaction(async (tx) => {
      // Serialize concurrent first-runs even on an empty table (no row to
      // `FOR UPDATE`). Held until commit; the loser blocks, then re-counts 1.
      await tx.execute(
        sql`select pg_advisory_xact_lock(${FIRST_RUN_ADVISORY_LOCK_KEY})`,
      );

      const existing = await tx.select({ id: tenants.id }).from(tenants).limit(1);
      if (existing[0]) {
        throw new FirstRunError(
          'This database already has a tenant; sign-up is closed.',
          'already_initialized',
        );
      }

      const passwordHash = await hashPassword(password);

      const [tenant] = await tx
        .insert(tenants)
        .values({ slug, name: tenantName })
        .returning();
      const [owner] = await tx
        .insert(users)
        .values({
          email,
          name: null,
          status: 'active',
          passwordHash,
          provisionSource: 'credentials',
        })
        .returning();
      await tx.insert(tenantMembers).values({
        tenantId: tenant.id,
        userId: owner.id,
        role: 'owner',
      });

      return { tenantId: tenant.id, userId: owner.id, slug };
    });
  };

  try {
    return await withConnection(deps, run);
  } catch (err) {
    if (err instanceof FirstRunError) throw err;
    if (isUniqueViolation(err)) {
      throw new FirstRunError(
        'Could not create the first tenant (conflict).',
        'conflict',
      );
    }
    throw new FirstRunError('Could not create the first tenant.', 'db');
  }
}

/** Factory (DI): binds a fixed deps closure for composition-root wiring. */
export function createFirstRun(deps: FirstRunDeps = {}) {
  return {
    hasAnyTenant: () => hasAnyTenant(deps),
    createFirstTenant: (input: FirstRunInput) => createFirstTenant(input, deps),
  };
}
