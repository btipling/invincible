-- plan #720 phase 2: "Always on for me" — per-skill auto-attach toggle.
-- User-global; applies to every new session regardless of chosen persona.
ALTER TABLE "user_skills" ADD COLUMN "is_always_on" boolean DEFAULT false NOT NULL;
