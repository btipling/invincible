CREATE TABLE "sandbox_grants" (
	"sandbox_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"can_read" boolean DEFAULT false NOT NULL,
	"can_write" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_grants_sandbox_id_user_id_pk" PRIMARY KEY("sandbox_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "sandboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"base_url" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_kek_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandboxes_tenant_slug_unique" UNIQUE("tenant_id","slug")
);
--> statement-breakpoint
CREATE TABLE "tenant_members" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_members_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"image" text,
	"email_verified" timestamp with time zone,
	"password_hash" text,
	"idp_subject" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_idp_subject_unique" UNIQUE("idp_subject")
);
--> statement-breakpoint
ALTER TABLE "sandbox_grants" ADD CONSTRAINT "sandbox_grants_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_grants" ADD CONSTRAINT "sandbox_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD CONSTRAINT "sandboxes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sandbox_grants_user_id_idx" ON "sandbox_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sandboxes_tenant_id_idx" ON "sandboxes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_members_user_id_idx" ON "tenant_members" USING btree ("user_id");