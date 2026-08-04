-- Phase 1 per-tenant DEK columns (#93 / parent #92).
-- dek_ciphertext: AMK-wrapped tenant DEK (encryptSecret format). Nullable until ensure/backfill.
ALTER TABLE "tenants" ADD COLUMN "dek_ciphertext" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "dek_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "amk_version" integer DEFAULT 1 NOT NULL;
