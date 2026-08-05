-- Phase 1 per-user MCP servers (#117 / parent #116).
-- Ciphertext is DEK-only and nullable when auth_mode=none (no API key).
CREATE TABLE "user_mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"url" text NOT NULL,
	"transport" text DEFAULT 'http' NOT NULL,
	"auth_header_name" text,
	"auth_header_value_ciphertext" text,
	"auth_header_kek_version" integer,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_mcp_servers_user_id_name_unique" UNIQUE("user_id","name"),
	CONSTRAINT "user_mcp_servers_user_id_slug_unique" UNIQUE("user_id","slug")
);
--> statement-breakpoint
ALTER TABLE "user_mcp_servers" ADD CONSTRAINT "user_mcp_servers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mcp_servers" ADD CONSTRAINT "user_mcp_servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_mcp_servers_user_id_idx" ON "user_mcp_servers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_mcp_servers_tenant_id_idx" ON "user_mcp_servers" USING btree ("tenant_id");
