-- Per-user preferred sandbox among multiple grants (#user settings picker).
CREATE TABLE "user_preferred_sandbox" (
"user_id" uuid PRIMARY KEY NOT NULL,
"tenant_id" uuid NOT NULL,
"sandbox_id" uuid NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_preferred_sandbox" ADD CONSTRAINT "user_preferred_sandbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferred_sandbox" ADD CONSTRAINT "user_preferred_sandbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferred_sandbox" ADD CONSTRAINT "user_preferred_sandbox_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_preferred_sandbox_tenant_id_idx" ON "user_preferred_sandbox" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "user_preferred_sandbox_sandbox_id_idx" ON "user_preferred_sandbox" USING btree ("sandbox_id");
