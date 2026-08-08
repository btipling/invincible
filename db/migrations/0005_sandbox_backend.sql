-- Phase 1 per-tenant sandbox backend (#281 / parent #280).
-- backend: byo (default) | vercel (app-validated). image: optional Vercel image ref.
-- base_url + token_ciphertext become nullable so vercel rows need no BYO creds.
ALTER TABLE "sandboxes" ADD COLUMN "backend" text DEFAULT 'byo' NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "sandboxes" ALTER COLUMN "base_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sandboxes" ALTER COLUMN "token_ciphertext" DROP NOT NULL;
