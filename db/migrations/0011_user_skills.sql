-- Per-user agent skills (parent #331 / phase 1 #498).
-- Body is plaintext non-secret user content (playbook/AGENTS-style doc); no DEK.
-- Slug charset enforced app-side: ^[a-z][a-z0-9_-]{0,63}$ (hyphen allowed so
-- kebab-case skills like `create-plan` store and match the phase-3 slash parser).
CREATE TABLE "user_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"slug" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_skills" ADD CONSTRAINT "user_skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_skills_tenant_user_slug_unique" ON "user_skills" USING btree ("tenant_id","user_id","slug");
--> statement-breakpoint
CREATE INDEX "user_skills_user_id_idx" ON "user_skills" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "user_skills_tenant_id_idx" ON "user_skills" USING btree ("tenant_id");
