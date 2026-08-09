-- Phase 1 per-user durable Vercel Sandbox instances (#299 / parent #298).
-- PK (user_id, purpose): one workspace + one http per user. vercel_name server-generated.
CREATE TABLE "user_sandbox_instances" (
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"catalog_sandbox_id" uuid,
	"vercel_name" text NOT NULL,
	"image" text NOT NULL,
	"status" text NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sandbox_instances_user_id_purpose_pk" PRIMARY KEY("user_id","purpose"),
	CONSTRAINT "user_sandbox_instances_vercel_name_unique" UNIQUE("vercel_name")
);
--> statement-breakpoint
ALTER TABLE "user_sandbox_instances" ADD CONSTRAINT "user_sandbox_instances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sandbox_instances" ADD CONSTRAINT "user_sandbox_instances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sandbox_instances" ADD CONSTRAINT "user_sandbox_instances_catalog_sandbox_id_sandboxes_id_fk" FOREIGN KEY ("catalog_sandbox_id") REFERENCES "public"."sandboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_sandbox_instances_tenant_id_idx" ON "user_sandbox_instances" USING btree ("tenant_id");
