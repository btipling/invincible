# Skills

Skills are **per-user, server-stored playbooks** (AGENTS.md-style instruction
docs) that an agent can be given for a turn — the "how to do X" companion to
[personas](personas.md) (identity). They are created and edited in
**Settings → Skills**, stored in the per-user `user_skills` table, and later
attached per-turn with a slash command (`/skill-name`) or fetched by the agent
itself with its skill-search tool. Skills are **non-secret plaintext user
content** (no DEK) and are scoped to exactly one user + tenant.

## Creating and editing a skill

Open **Settings → Skills** (from the Settings sidebar, or `/settings/skills`).

- **Create:** give the skill a **name**, an optional one-line **description**,
  and the **body** (the actual playbook text, ≤ 16 KiB). A slug is derived
  automatically from the name — you never type or edit a slug.
- **Edit name & description:** renaming a skill edits only its name and
  description. **The slug never changes on rename**, so the `/<slug>` attach
  command stays stable across renames.
- **Edit body:** replace the playbook text. Body is required and ≤ 16 KiB.
- **Delete:** removes the skill. Any currently-attached session stops
  resolving it on subsequent turns.

### Slug derivation

A slug is auto-derived from the display name (`create-pull-request` → a
lowercase, underscore-normalized, letter-prefixed form such as
`create_pull_request`). On a collision a numeric suffix is appended
(`create_pull_request_2`, `_3`, …) until a unique slug is found.

Valid slugs match `^[a-z][a-z0-9_-]{0,63}$` (lowercase start; digits, and
underscores or hyphens allowed; ≤ 64 chars). This same charset is what the
slash-command parser accepts, so a stored slug always resolves when typed as
`/<slug>`.

## Guidance

- **Body:** write it like a mini-AGENTS.md — concrete instructions, boundaries,
  and the workflow the agent should follow when this skill is attached.
  Keep one skill focused on one job.
- **Description:** one short line a user (or the agent's search tool) can scan;
  it is shown in discovery lists but never the body.
- **Size & budget:** each body is capped at 16 KiB. Since a skill's body is
  injected into the session's system context only when attached, keep the body
  tight; attaching many skills at once grows the token budget as the sum of
  their bodies.
