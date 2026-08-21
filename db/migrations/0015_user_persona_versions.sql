-- Per-user persona version history (parent #534 / plan #726).
-- Append-only: each write to user_personas.body inserts a version row.
-- Rollback copies an old version's body into user_personas.body + inserts a NEW
-- version row (rollback itself IS versioned). FK cascades on persona delete.
CREATE TABLE "user_persona_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL REFERENCES "user_personas"("id") ON DELETE CASCADE,
	"body" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_persona_versions_persona_id_idx" ON "user_persona_versions" USING btree ("persona_id");
