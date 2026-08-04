-- Phase 1 tenant BYOK provider secrets (#103 / parent #102).
-- Ciphertext is always under tenant DEK (no AMK dual-read).
CREATE TABLE "provider_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"credential_ciphertext" text NOT NULL,
	"credential_kek_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_secrets_tenant_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "provider_secret_models" (
	"secret_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	CONSTRAINT "provider_secret_models_secret_id_model_id_pk" PRIMARY KEY("secret_id","model_id")
);
--> statement-breakpoint
CREATE TABLE "provider_secret_grants" (
	"secret_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"can_use" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_secret_grants_secret_id_user_id_pk" PRIMARY KEY("secret_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "provider_secrets" ADD CONSTRAINT "provider_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_secret_models" ADD CONSTRAINT "provider_secret_models_secret_id_provider_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."provider_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_secret_grants" ADD CONSTRAINT "provider_secret_grants_secret_id_provider_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."provider_secrets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_secret_grants" ADD CONSTRAINT "provider_secret_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_secrets_tenant_id_idx" ON "provider_secrets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "provider_secret_grants_user_id_idx" ON "provider_secret_grants" USING btree ("user_id");
