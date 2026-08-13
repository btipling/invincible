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
 * SSO/SCIM identity columns: parent #64 / phase #75.
 */

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  settings: jsonb('settings').notNull().default({}),
  /**
   * AMK-wrapped tenant DEK (`encryptSecret` format: v1:iv:ct:tag).
   * Null until ensureTenantDek / backfill; never log plaintext DEK.
   */
  dekCiphertext: text('dek_ciphertext'),
  /** Tenant DEK version; written into sandboxes.token_kek_version after DEK encrypt. */
  dekVersion: integer('dek_version').notNull().default(1),
  /** AMK version that wraps dek_ciphertext (env KEK generation). */
  amkVersion: integer('amk_version').notNull().default(1),
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
  /** OIDC subject: normalizeIdpSubject(issuer, sub) */
  idpSubject: text('idp_subject').unique(),
  /**
   * How the user was provisioned. Hybrid model (#64): credentials | oidc | scim | manual.
   * Default credentials for back-compat / seed break-glass.
   */
  provisionSource: text('provision_source').notNull().default('credentials'),
  /** IdP SCIM externalId; SCIM resource id remains users.id */
  scimExternalId: text('scim_external_id').unique(),
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
    /**
     * Per-sandbox backend (#281 / parent #280): byo | vercel.
     * App validates enum; no DB CHECK in v1.
     */
    backend: text('backend').notNull().default('byo'),
    /**
     * Vercel Sandbox image ref when backend=vercel (VMI or VCR).
     * Null when byo or when product default should apply at resolve time.
     */
    image: text('image'),
    /** Required for backend=byo; null for backend=vercel. */
    baseUrl: text('base_url'),
    /** DEK ciphertext of BYO token; null for backend=vercel. Never log. */
    tokenCiphertext: text('token_ciphertext'),
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


export const providerSecrets = pgTable(
  'provider_secrets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Closed enum in lib/gateway/byokProviders (Gateway catalog slugs). */
    provider: text('provider').notNull(),
    /** DEK-only ciphertext of JSON credentials — never log. */
    credentialCiphertext: text('credential_ciphertext').notNull(),
    /** Tenant dek_version at write time. */
    credentialKekVersion: integer('credential_kek_version').notNull().default(1),
    /** active | disabled */
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('provider_secrets_tenant_name_unique').on(t.tenantId, t.name),
    index('provider_secrets_tenant_id_idx').on(t.tenantId),
  ],
);

export const providerSecretModels = pgTable(
  'provider_secret_models',
  {
    secretId: uuid('secret_id')
      .notNull()
      .references(() => providerSecrets.id, { onDelete: 'cascade' }),
    /** Gateway shape: provider/model */
    modelId: text('model_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.secretId, t.modelId] })],
);

export const providerSecretGrants = pgTable(
  'provider_secret_grants',
  {
    secretId: uuid('secret_id')
      .notNull()
      .references(() => providerSecrets.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    canUse: boolean('can_use').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.secretId, t.userId] }),
    index('provider_secret_grants_user_id_idx').on(t.userId),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type TenantMember = typeof tenantMembers.$inferSelect;
export type Sandbox = typeof sandboxes.$inferSelect;
export type SandboxGrant = typeof sandboxGrants.$inferSelect;
export type ProviderSecret = typeof providerSecrets.$inferSelect;
export type ProviderSecretModel = typeof providerSecretModels.$inferSelect;
export type ProviderSecretGrant = typeof providerSecretGrants.$inferSelect;

/**
 * Per-user remote MCP server configs (parent #116 / phase #117).
 * API-key header ciphertext is DEK-only (nullable when auth_mode=none).
 * Server-only — never expose ciphertext to client.
 */
export const userMcpServers = pgTable(
  'user_mcp_servers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Tool-prefix slug: ^[a-z][a-z0-9_]{0,31}$ */
    slug: text('slug').notNull(),
    url: text('url').notNull(),
    /** v1 always http (Streamable HTTP). */
    transport: text('transport').notNull().default('http'),
    /** Header name when auth_mode=api_key; null when none. */
    authHeaderName: text('auth_header_name'),
    /** DEK ciphertext of raw API key; null when auth_mode=none. Never log. */
    authHeaderValueCiphertext: text('auth_header_value_ciphertext'),
    /** Tenant dek_version at write; null when no ciphertext. */
    authHeaderKekVersion: integer('auth_header_kek_version'),
    /** api_key | none */
    authMode: text('auth_mode').notNull().default('none'),
    enabled: boolean('enabled').notNull().default(true),
    /** Last connect/test error (no secrets); null until phase 2+ writes. */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('user_mcp_servers_user_id_name_unique').on(t.userId, t.name),
    unique('user_mcp_servers_user_id_slug_unique').on(t.userId, t.slug),
    index('user_mcp_servers_user_id_idx').on(t.userId),
    index('user_mcp_servers_tenant_id_idx').on(t.tenantId),
  ],
);

export type UserMcpServer = typeof userMcpServers.$inferSelect;

/**
 * Per-user GitHub PAT (parent #291 / phase #292).
 * Token ciphertext is DEK-only (nullable when cleared). Server-only — never
 * expose ciphertext to client.
 */
export const userGithubTokens = pgTable(
  'user_github_tokens',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** DEK ciphertext of raw PAT; null when cleared / unset. Never log. */
    tokenCiphertext: text('token_ciphertext'),
    /** Tenant dek_version at write; null when no ciphertext. */
    tokenKekVersion: integer('token_kek_version'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('user_github_tokens_tenant_id_idx').on(t.tenantId)],
);

export type UserGithubToken = typeof userGithubTokens.$inferSelect;

/**
 * Per-user preferred sandbox when multiple grants exist.
 * Server-only preference; resolve uses it to pick among usable grants.
 */
export const userPreferredSandbox = pgTable(
  'user_preferred_sandbox',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id, { onDelete: 'cascade' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('user_preferred_sandbox_tenant_id_idx').on(t.tenantId),
    index('user_preferred_sandbox_sandbox_id_idx').on(t.sandboxId),
  ],
);

export type UserPreferredSandbox = typeof userPreferredSandbox.$inferSelect;


/**
 * Per-user durable Vercel Sandbox instances (parent #298 / phase 1 #299).
 * One workspace + one http slot per user. Server-only registry; agent never creates.
 */
export const userSandboxInstances = pgTable(
  'user_sandbox_instances',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** workspace | http — app-validated. */
    purpose: text('purpose').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /**
     * Catalog sandbox used at workspace Create; null for http.
     * SET NULL if catalog row deleted (image remains frozen on this row).
     */
    catalogSandboxId: uuid('catalog_sandbox_id').references(() => sandboxes.id, {
      onDelete: 'set null',
    }),
    /** Server-generated inv-{purpose}-{hash}; unique. Never client-supplied. */
    vercelName: text('vercel_name').notNull(),
    /** Image frozen at Create. */
    image: text('image').notNull(),
    /** running | stopped | error — app-validated. */
    status: text('status').notNull(),
    /** Last platform/reconcile error; no secrets. */
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.purpose] }),
    unique('user_sandbox_instances_vercel_name_unique').on(t.vercelName),
    index('user_sandbox_instances_tenant_id_idx').on(t.tenantId),
  ],
);

export type UserSandboxInstance = typeof userSandboxInstances.$inferSelect;
export type UserSandboxInstanceInsert = typeof userSandboxInstances.$inferInsert;

/**
 * Per-user agent personas (parent #485 / phase 1 #486).
 * Bodies are non-secret user content (AGENTS.md-style instruction docs) —
 * deliberately NOT DEK-encrypted (vs MCP headers / GitHub PATs which are real
 * secrets). Server-only; never ship payload to the client in summaries.
 */
export const userPersonas = pgTable(
  'user_personas',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Pretty slug for picker/keys — unique per (tenantId, userId). */
    slug: text('slug').notNull(),
    /** Plaintext non-secret persona body. */
    body: text('body').notNull(),
    /** App-side single-default per user; boolean column, not a separate table. */
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('user_personas_tenant_user_slug_unique').on(
      t.tenantId,
      t.userId,
      t.slug,
    ),
    index('user_personas_user_id_idx').on(t.userId),
    index('user_personas_tenant_id_idx').on(t.tenantId),
  ],
);

export type UserPersona = typeof userPersonas.$inferSelect;
export type UserPersonaInsert = typeof userPersonas.$inferInsert;

/**
 * Cloud multi-device harness session (parent #242 / phase #243).
 * One row per user. snapshot_id is opaque client SessionSnapshot.id (e.g. sess_…),
 * not a UUID — never uuid-validate client ids.
 * messages is SessionMessage[] JSON only (no secrets).
 */
export const harnessSessions = pgTable('harness_sessions', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Opaque client SessionSnapshot.id (e.g. sess_…); not a DB uuid. */
  snapshotId: text('snapshot_id').notNull(),
  /** Wall time of last accepted write; API exposes as epoch ms. */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  /** SessionMessage[] — id/role/text/at only. */
  messages: jsonb('messages').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type HarnessSession = typeof harnessSessions.$inferSelect;
