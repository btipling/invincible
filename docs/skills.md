# Skills

Skills are **per-user, server-stored playbooks** (AGENTS.md-style instruction
docs) — the "how to do X" companion to [personas](personas.md) (identity).
They are created and edited in **Settings → Skills** and stored in the per-user
`user_skills` table. Skills are **non-secret plaintext user content** (no DEK)
and are scoped to exactly one user + tenant.

To use a skill in a session, **attach it with a slash command** — type
`/skill-name` in the harness composer. The server resolves the skill, injects
its body into the session's system context, and the transcript shows only a
`Skill attached: <slug>` row. The agent's skill-search tools
(`find_skill` / `fetch_skill`) land in a later phase.

## Creating and editing a skill

Open **Settings → Skills** (from the Settings sidebar, or `/settings/skills`).

- **Create:** give the skill a **name**, an optional one-line **description**,
  and the **body** (the actual playbook text, ≤ 4 MiB). A slug is derived
  automatically from the name — you never type or edit a slug.
- **Edit name & description:** renaming a skill edits only its name and
  description. **The slug never changes on rename**, so the `/<slug>`
  identifier stays stable across renames.
- **Edit body:** replace the playbook text. Body is required and ≤ 4 MiB.
- **Delete:** removes the skill from your account.

### Slug derivation

A slug is auto-derived from the display name (a lowercase,
underscore-normalized, letter-prefixed form such as `create_pull_request`). On
a collision a numeric suffix is appended (`create_pull_request_2`, `_3`, …)
until a unique slug is found.

Valid slugs match `^[a-z][a-z0-9_-]{0,127}$` (lowercase start; digits, and
underscores or hyphens allowed; ≤ 128 chars). The same charset is what the
slash-command attachment accepts, so a hyphenated slug like `/create-plan`
works.

## Using a skill in a session

Type a slash command in the harness composer:

- **`/skill-name`** — attach the skill. `/create-plan please scaffold` attaches
  `create-plan` **and** sends the remaining prose (`please scaffold`) to the
  model. The skill body is injected into the model's system context for this
  turn and **stays attached** for the rest of the session.
- **`/unskill skill-name`** — detach. The whole line is a command (no model
  turn); the skill stops being re-injected on the next turn.

Attachment is **session-sticky**: the server remembers which skill slugs are
attached in the session's `meta.attachedSkills` (a JSON array string, dedupe,
≤ 32 slugs) and re-resolves their bodies from the store on every turn in that
session. Because skills are **staff of work** (not a locked identity like a
persona snapshot), editing a skill's body takes effect from the **next turn** —
an already-attached session picks up the edited body rather than a frozen copy.
A skill that is deleted while attached silently stops being injected. **New
session / Clear** mints a fresh session, so attachments reset there.

The sticky set is carried on BOTH seams so nothing can wipe it: the server
persists it via the phase-0 **envelope** (`readEnvelope` / `upsertEnvelope`,
same `harness:envelope:*` key the host writes, `updatedAt` left untouched), and
the host folds the same set onto its `SessionSnapshot.attachedSlugs`, so a host
record PUT rewrites `meta.attachedSkills` verbatim instead of silently dropping
it (an omitted reserved key is never treated as *clear*; an explicit empty set
means detach-all — the two are distinct).

### What the UI shows

The transcript shows **only the skill name**: a compact `Skill attached:
<slug>` row in the canvas. The skill **body is never displayed in the canvas
and never sent to the client** — it exists only server-side in the model's
system context.

## Guidance

- **Body:** write it like a mini-AGENTS.md — concrete instructions, boundaries,
  and the workflow the agent should follow when this skill is used. Keep one
  skill focused on one job.
- **Description:** one short line a user can scan; it is shown in discovery
  lists but never the body.
- **Size & token budget — store cap vs inject cap:** a body is stored up to
  the 4 MiB `SKILL_BODY_MAX_BYTES` cap, but what is **injected into the model's
  system context every turn** is separately capped at a far smaller budget
  (`HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES`, 256 KiB total across all attached
  skills). A new attach whose body would exceed that inject budget is **rejected
  at attach** (`too_large` when the body alone is over, `budget` when the
  already-attached set leaves no headroom) and is **never counted as attached** —
  so a large stored skill can never sit "attached" while silently never being
  injected (the count cap alone is not a size cap). Keep bodies tight: only the
  attached **slugs** are stored in session `meta` (never bodies), and only the
  injectable subset of their bodies reaches the model each turn.
