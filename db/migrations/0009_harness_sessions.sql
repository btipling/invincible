-- Phase 1 cloud multi-device harness session (#243 / parent #242).
-- One row per user; snapshot_id is opaque client SessionSnapshot.id (not uuid).
CREATE TABLE "harness_sessions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"snapshot_id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_sessions" ADD CONSTRAINT "harness_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
