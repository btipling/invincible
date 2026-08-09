-- Phase 1 per-user GitHub PAT (#292 / parent #291).
-- Ciphertext is DEK-only; null when cleared / unset. Never store plaintext.
CREATE TABLE "user_github_tokens" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"token_ciphertext" text,
	"token_kek_version" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_github_tokens" ADD CONSTRAINT "user_github_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_github_tokens" ADD CONSTRAINT "user_github_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_github_tokens_tenant_id_idx" ON "user_github_tokens" USING btree ("tenant_id");
