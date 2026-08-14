# Skills

Skills are **per-user, server-stored playbooks** (AGENTS.md-style instruction
docs) — the "how to do X" companion to [personas](personas.md) (identity).
They are created and edited in **Settings → Skills** and stored in the per-user
`user_skills` table. Skills are **non-secret plaintext user content** (no DEK)
and are scoped to exactly one user + tenant.

> **Forward note (not yet shipped):** slash-command attachment
> (`/skill-name`) and the agent's skill-search tools land in a later phase.
> Today only **authoring** is available — create, edit, and delete from
> Settings → Skills.

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

Valid slugs match `^[a-z][a-z0-9_-]{0,127}# Skills

Skills are **per-user, server-stored playbooks** (AGENTS.md-style instruction
docs) — the "how to do X" companion to [personas](personas.md) (identity).
They are created and edited in **Settings → Skills** and stored in the per-user
`user_skills` table. Skills are **non-secret plaintext user content** (no DEK)
and are scoped to exactly one user + tenant.

> **Forward note (not yet shipped):** slash-command attachment
> (`/skill-name`) and the agent's skill-search tools land in a later phase.
> Today only **authoring** is available — create, edit, and delete from
> Settings → Skills.

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

 (lowercase start; digits, and
underscores or hyphens allowed; ≤ 128 chars).

## Guidance

- **Body:** write it like a mini-AGENTS.md — concrete instructions, boundaries,
  and the workflow the agent should follow when this skill is used. Keep one
  skill focused on one job.
- **Description:** one short line a user can scan; it is shown in discovery
  lists but never the body.
- **Size & budget:** each body is capped at 4 MiB. Keep the body tight; a
  skill's body becomes part of the session's context budget only once attached
  in a later phase, and each additional attachment adds its body's size to that
  budget.
