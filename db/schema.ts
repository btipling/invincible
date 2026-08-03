import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Phase 1 tenancy schema (parent #54 / phase #55).
 * Auth.js adapter tables (accounts/sessions/verification_tokens): not used (JWT + Credentials).
 */

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  status: text('status').notNull().default('active'),
  image: text('image'),
  emailVerified: timestamp('email_verified', { withTimezone: true }),
  /** bcrypt cost 12; nullable until credentials set */
  passwordHash: text('password_hash'),
  /** SSO/SCIM later */
  idpSubject: text('idp_subject').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tenantMembers = pgTable(
  'tenant_members',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index('tenant_members_user_id_idx').on(t.userId),
  ],
);

export const sandboxes = pgTable(
  'sandboxes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    baseUrl: text('base_url').notNull(),
    tokenCiphertext: text('token_ciphertext').notNull(),
    tokenKekVersion: integer('token_kek_version').notNull().default(1),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sandboxes_tenant_slug_unique').on(t.tenantId, t.slug),
    index('sandboxes_tenant_id_idx').on(t.tenantId),
  ],
);

export const sandboxGrants = pgTable(
  'sandbox_grants',
  {
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canRead: boolean('can_read').notNull().default(false),
    canWrite: boolean('can_write').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sandboxId, t.userId] }),
    index('sandbox_grants_user_id_idx').on(t.userId),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type TenantMember = typeof tenantMembers.$inferSelect;
export type Sandbox = typeof sandboxes.$inferSelect;
export type SandboxGrant = typeof sandboxGrants.$inferSelect;
