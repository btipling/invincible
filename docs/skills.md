# Skills

Skills are **per-user, server-stored playbooks** (AGENTS.md-style instruction
docs) — the "how to do X" companion to [personas](personas.md) (identity).
They are created and edited in **Settings → Skills** and stored in the per-user
`user_skills` table. Skills are **non-secret plaintext user content** (no DEK)
and are scoped to exactly one user + tenant.

The session catalog is **sticky ∪ always-on**. On Production `/harness`
(durable turns via `POST /api/turns`) the durable model step re-resolves
sticky / always-on skills only (`command: none`) — it does **not** parse
slash commands. Typing `/skill-name` in the harness composer does **not**
attach a skill or join the catalog there. Slash-command `/skill-name` /
`/unskill slug` attach still lives on the legacy `/api/agent` path
(tests/JSON); Production `runHarnessTurn` posts `/api/turns` and never
calls `parseSkillCommand`. Toggle a skill **always-on** in Settings to
have it auto-join every session's catalog. The agent can also **search /
read your own skills directly** with the server-side `find_skill` and
`fetch_skill` tools, **or manage your skills** (create / read / update /
delete) through the `meta_skill_*` authoring tools
(see [Agent skill-search tools](#agent-skill-search-tools-find_skill--fetch_skill)
and [Agent skill-authoring tools](#agent-skill-authoring-tools-meta_skill_)).

**Bodies are not injected.** The session's system context carries a bounded
**catalog** — one line per attached/always-on skill (`<slug> — Name:
description`) — not the playbook bodies. The agent reads a skill's full body on
demand with the `fetch_skill` tool whenever it needs it, and discovers other
skills with `find_skill`. This keeps the per-turn inject small (a few KiB
instead of up to hundreds of KiB of bodies) and keeps the stable system prefix
stable across turns (a mid-session skill body edit no longer rewrites the
block).

## Creating and editing a skill

Open **Settings → Skills** (from the Settings sidebar, or `/settings/skills`).

- **Create:** give the skill a **name**, an optional one-line **description**,
  and the **body** (the actual playbook text, ≤ 4 MiB). A slug is derived
  automatically from the name — you never type or edit a slug.
- **Edit name & description:** renaming a skill edits only its name and
  description. **The slug never changes on rename**, so the `/<slug>`
  identifier stays stable across renames.
- **Edit body:** replace the playbook text. Body is required and ≤ 4 MiB.
- **Delete:** removes the skill from your account (cascade-deletes its version
  history).
- **Version history:** every body edit creates a new version row. The Settings
  skill card includes a **Version history** section where you can **View body**
  (see any past version's full raw body text — displayed inline, not a computed
  diff), **Copy body** (copy a version's text to the clipboard, handy before a
  last-slot Restore), and **Restore** (roll the current body back to that
  version). Rollback creates a fresh version row so it is itself versioned.
  Each skill can hold up to 100 versions.

### Version history & rollback

Each time you save a body edit (Create or Edit body), the **previous** body is
preserved as a version row in the append-only `user_skill_versions` table. The
version timeline is visible inside each skill card in Settings → Skills:

1. Click **Show** on the "Version history" header to load the timeline.
2. The timeline lists versions newest-first (the current body is labeled
   **now**).
3. Click **View body** on a version to see its full body inline (raw text, not
   a computed diff). Use **Copy body** to copy that version's text to the
   clipboard, especially before a last-slot Restore.
4. Click **Restore** on a past version to roll the skill body back. This copies
   the version's body into the live `body` field **and** inserts a new version
   row — rollback is itself versioned and counts against the 100-version cap.
5. Deleting a skill cascade-deletes its entire version history (FK `ON DELETE
   CASCADE`).
6. When a skill hits the 100-version cap, further body edits **and** further
   rollbacks are rejected (`invalid_body` with a hint). **Rolling back does not
   free a slot** — it copies a past body and inserts a *new* version row, so it
   counts against the cap just like an edit. To keep editing past the cap, you
   must either **delete the skill** (which cascade-deletes its version history)
   or **raise `SKILL_VERSION_MAX`** (a deliberate ops decision — done in code,
   then `db-migrate` is not needed since it is not a schema change).

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

**Production `/harness` (durable turns):** `runHarnessTurn` posts `/api/turns`
and never calls `parseSkillCommand`. The durable model step does **not** parse
slash commands (`command: none`); it re-resolves sticky / always-on slugs
only. Typing `/skill-name` in the composer does **not** attach a skill or
populate the catalog. Toggle a skill **always-on** in Settings to auto-join
every session; sticky slugs already on `meta.attachedSkills` (from a prior
`/api/agent` attach) still re-resolve.

**`/api/agent` (legacy tests/JSON):** type a slash command in the prompt:

- **`/skill-name`** — attach the skill. `/create-plan please scaffold` attaches
  `create-plan` **and** sends the remaining prose (`please scaffold`) to the
  model. The skill joins the session's catalog (see above) and **stays
  attached** for the rest of the session; the agent reads the body on demand
  via `fetch_skill` when it needs the playbook.
- **`/unskill skill-name`** — detach. The whole line is a command (no model
  turn); the skill drops from the catalog on the next turn.

Attachment is **session-sticky**: the server remembers which skill slugs are
attached in the session's `meta.attachedSkills` (a JSON array string, dedupe,
≤ 32 slugs) and re-resolves their summaries from the store on every turn in
that session. Because skills are **staff of work** (not a locked identity like a
persona snapshot), editing a skill's description applies from the **next
turn** — a body edit never rewrites the catalog line for that slug. A skill
that is deleted while attached silently drops from the catalog. **New session /
Clear** mints a fresh session, so attachments reset there.

The sticky set is carried on BOTH seams so nothing can wipe it: the server
persists it via the phase-0 **envelope** (`readEnvelope` / `upsertEnvelope`,
same `harness:envelope:*` key the host writes, `updatedAt` left untouched), and
the host folds the same set onto its `SessionSnapshot.attachedSlugs`, so a host
record PUT rewrites `meta.attachedSkills` verbatim instead of silently dropping
it (an omitted reserved key is never treated as *clear*; an explicit empty set
means detach-all — the two are distinct).

### Always-on skills

A skill can be toggled **"always on"** in Settings → Skills (the always-on
toggle on each skill row). An always-on skill **auto-attaches to every new
session**, regardless of the chosen persona. The always-on set is:

- **User-global** — the same set applies to every session for that user.
- **Re-resolved from the DB every turn** — a description edit applies from
  the next turn's catalog; a body edit applies on the next `fetch_skill`
  (not auto standing orders). A delete silently drops the skill from the
  catalog (same as sticky).
- **Not persisted in `meta.attachedSkills`** — always-on slugs are never
  session state; they are the user's global toggle.
- **Capped at 8 skills** (`USER_ALWAYS_ON_SKILLS_MAX`).
- **Cannot be detached by `/unskill`** — always-on means always-on. Toggle
  it off in Settings to stop auto-attaching.

An always-on skill appears in the same per-turn catalog inject as every other
attached skill (see above). If you need a skill everywhere by default, flip the
always-on toggle. If you want persona-specific recommendations instead, see
[personas.md](personas.md) — recommended skills.

### What the UI shows

The transcript attach row is **name-only**: a compact `Skill attached:
<slug>` canvas row (message kind 7, display-only). That kind-7 row and the
system-prompt catalog are summaries only (slug + name + description) — the
skill **body is not painted on the attach row** and is **not** injected into
the system prompt. The model reads the body on demand via `fetch_skill`;
that body reaches the client/Wasm only as a tool result (`tool_result`
preview → `tool_run` row), never as the kind-7 attach display.

## Agent skill-search tools (`find_skill` / `fetch_skill`)

The agent gets two read-only tools, assembled server-side on Production
durable turns (`POST /api/turns` → in-step `assembleDurableToolWorld` →
`buildToolWorld` from `lib/agent/skillTools.ts`). The legacy `/api/agent`
tests/JSON path assembles the same tools:

- **`find_skill`** — search your skills by a substring (case-insensitive) across
  their **slug, name, and description**. Returns only summaries (no bodies), up
  to `SKILL_FIND_RESULT_MAX` (20) results. An omitted or empty query lists your
  skills (bounded). Use it to catch a typo or a reference before fetching a body.
- **`fetch_skill`** — read the **full body** of one of your own skills **by
  slug**. Unknown slugs or another user's/tenant's skill return `not_found`
  with no partial body (skills are user-scoped — an existence leak is
  impossible). The **model-returned body is capped** at
  `SKILL_FETCH_MAX_RETURN_BYTES` (256 KiB): a longer body is returned truncated
  with a prose marker (`…[truncated to N bytes; full body is M bytes — edit in
  Settings]`), never silently dropped. The untruncated stored body stays
  editable in Settings; the truncated slice still reaches the client/Wasm as a
  `tool_result` preview painted on a `tool_run` row (same as other tool reads).

Both tools are **bound to the caller's identity**: they operate on the
route-resolved user only, and no identity a model passes is ever used
(confused-deputy guard). They are pure **reads** of your own skills — the agent
does not create, edit, or delete a skill through these two tools. A
`fetch_skill` body reaches the client/Wasm only as a tool result (`tool_result`
preview → `tool_run` row); it is not injected into the system prompt and is
not painted on the kind-7 attach row. Authoring (create / edit / delete) happens
either in Settings or through the separate `meta_skill_*` authoring tools below.

## Agent skill-authoring tools (`meta_skill_*`)

`meta_skill_*` is the **authoring** counterpart to the read-only search tools
above. It is a first-party tool family assembled on Production durable turns
(`POST /api/turns` → `assembleDurableToolWorld` / `buildToolWorld` from
`lib/agent/metaTools.ts`), always available, and operates only on the signed-in
caller's own skills (same grants as Settings, confused-deputy bound to the
route user). The legacy `/api/agent` tests/JSON path assembles the same family.
Tools and their semantics:

- **`meta_skill_list`** — list your skills (summaries: id, slug, name,
  description — never body), bounded.
- **`meta_skill_read`** — read the **full body** of one of your skills **by
  slug**, capped at `SKILL_FETCH_MAX_RETURN_BYTES` (256 KiB) with an explicit
  truncation marker when larger (mirrors `fetch_skill`). Unknown or foreign
  slug → `not_found`, no partial.
- **`meta_skill_create`** — create a skill (`name`, optional `slug`, `body`,
  optional `description`). When `slug` is omitted it is **derived in the tool
  layer** before the store is called. Body is validated against the store's
  4 MiB cap on **write** (over-cap is rejected, never truncated); duplicate slug
  → error.
- **`meta_skill_update_summary`** — update a skill's `name` (+ optional
  `description`) by **id**. Slug stays immutable.
- **`meta_skill_update_body`** — replace a skill's `body` by **id**. Over-cap
  rejected (never truncated on write).
- **`meta_skill_str_replace`** — patch a skill's `body` by **id** with a
  **literal exact-text** replacement (`old_string` → `new_string`, optional
  `replace_all`). Its purpose is **output-token-safe editing of a body larger
  than the model's output budget**: instead of re-emitting the whole body, the
  agent sends only a fragment. Semantics (all fail-closed, no partial write):
  - exactly **one** non-overlapping literal match of `old_string` in the full
    stored body → replaced; `replace_all:true` → every non-overlapping
    occurrence; **0 matches** → error; **`>1` without `replace_all:true`** →
    error (the model must disambiguate or opt into replace-all).
  - **empty `old_string`** → error.
  - each `old_string` / `new_string` fragment is capped at
    `META_SKILL_FRAGMENT_MAX_BYTES` (64 KiB), so the tool cannot be used to
    rewrite a whole body in one call; the **resulting full body** size is
    computed from the match count **before** the replacement is materialized
    and is rejected when empty or over the store's 4 MiB `SKILL_BODY_MAX_BYTES`
    write cap (never truncated, never allocated past the cap).
  - replacement is built **literally** (`split`/`join` + slice, never
    `String.prototype.replace`), so `$` templates (`$&`, `$1`, `$\'`, `` $\` ``),
    backslashes, and regex metacharacters in **either** string are treated
    **verbatim** — safe for Markdown/code skill bodies (this mirrors the proven
    sandbox `str_replace`, which fixed exactly this regression).
  - result is a **one-liner** (occurrence count, no body echo); the patch is
    resolved against the **full stored body** regardless of the read truncation
    cap. Use it to fix a section of a large skill instead of
    `meta_skill_update_body` when re-emitting the whole body is impractical.
- **`meta_skill_delete`** — delete a skill by **id**.

Because a skill is updated/deleted **by id** while read resolves **by slug**,
call `meta_skill_list` first to obtain the `id`/`slug` you need. Authoring runs
**as the signed-in user** with immediate effect (no separate confirm surface),
consistent with Settings' own mutating actions. Skill bodies are non-secret user
content: they are returned to the model **only** on an explicit `*_read`. A
read body reaches the client/Wasm only as a tool result (`tool_result` preview
→ `tool_run` row), never as the kind-7 attach display or the catalog inject.
These are write tools — they are distinct from the
read-only `find_skill` / `fetch_skill`, which stay unchanged.

## Guidance

- **Body:** write it like a mini-AGENTS.md — concrete instructions, boundaries,
  and the workflow the agent should follow when this skill is used. Keep one
  skill focused on one job.
- **Description:** one short line a user can scan; it is shown in discovery
  lists but never the body.
- **Size & token budget — store cap vs catalog inject:** a body is stored up to
  the 4 MiB `SKILL_BODY_MAX_BYTES` cap, but what is **injected into the model's
  system context every turn** is a bounded **catalog** of one line per
  attached/always-on skill (slug + name + description), not the bodies.
  Name/description whitespace is flattened so each skill is exactly one line.
  The catalog is safety-railed by the unchanged **256 KiB**
  `HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES` inject ceiling: a maxed CJK
  name+description library of 32 sticky + 8 always-on can exceed that ceiling,
  so lines pack by remaining budget (occupancy 1 may use the full 256 KiB; the
  32+8 count caps are the row ceiling, not a per-line tax) — every resolvable
  slug still appears (no stored-but-never-listed skip). No cap was raised or
  lowered. Because no body is injected at attach
  time, an attach is no longer size-rejected: an over-256 KiB skill can attach
  and be catalog-listed, and its body is only ever returned by `fetch_skill` /
  `meta_skill_read` truncated to the 256 KiB `SKILL_FETCH_MAX_RETURN_BYTES`
  model-return cap. Keep bodies tight anyway — the store cap and the fetch cap
  both still apply.
