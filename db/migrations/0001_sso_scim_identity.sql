ALTER TABLE "users" ADD COLUMN "provision_source" text DEFAULT 'credentials' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "scim_external_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_scim_external_id_unique" UNIQUE("scim_external_id");
