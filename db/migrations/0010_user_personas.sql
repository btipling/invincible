-- Per-user agent personas (parent #485 / phase 1 #486).
-- Body is plaintext non-secret user content (AGENTS.md-style doc); no DEK.
CREATE TABLE "user_personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"body" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_personas" ADD CONSTRAINT "user_personas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_personas" ADD CONSTRAINT "user_personas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "user_personas_tenant_user_slug_unique" ON "user_personas" USING btree ("tenant_id","user_id","slug");
--> statement-breakpoint
CREATE INDEX "user_personas_user_id_idx" ON "user_personas" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "user_personas_tenant_id_idx" ON "user_personas" USING btree ("tenant_id");
