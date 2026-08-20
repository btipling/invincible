-- Per-user skill version history (parent #331 / plan #711 phase 1).
-- Append-only: each write to user_skills.body inserts a version row.
-- Rollback copies an old version's body into user_skills.body + inserts a NEW
-- version row (rollback itself IS versioned). FK cascades on skill delete.
CREATE TABLE "user_skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL REFERENCES "user_skills"("id") ON DELETE CASCADE,
	"body" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_skill_versions_skill_id_idx" ON "user_skill_versions" USING btree ("skill_id");
