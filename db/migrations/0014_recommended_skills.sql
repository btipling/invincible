-- plan #720 phase 3: "Recommended for this persona" — persona→skill suggestions.
-- JSON array of slugs (max 16). Discovery-only; never auto-attach.
ALTER TABLE "user_personas" ADD COLUMN "recommended_skill_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL;
