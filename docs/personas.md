# Agent personas

A **persona** is a personal, signed-in-user-scoped instruction document (`AGENTS.md`
style): a few paragraphs telling the agent your standing preferences — stack,
code style, constraints, habits. Personas are per-user and never shared across
accounts.

Every session you start can bind **one** persona. When it does, the agent begins
with that persona's standing orders injected into its system context, and the
same locked text is reused for the rest of the session (and on other devices).

## Creating and managing personas

- Open **Settings → Personas**.
- **Create**: give a name and the instruction text (an `AGENTS.md`-style body).
- **Rename / Edit**: update the name or body at any time.
- **Set default**: mark the persona you want picked automatically when you start a
  new session without explicitly choosing one. Only one persona can be the
  default at a time.
- **Clear default**: remove the default so new sessions start with **None**.
- **Delete**: removes the persona. Sessions already running keep their snapshot
  (see below).

A persona body is **not a secret**. Store API keys, tokens, or credentials in the
proper secrets surface (per-user MCP servers, GitHub PAT, or sandbox env) — never
inside a persona. Personas are plaintext user content.

### The agent can manage your personas too (`meta_persona_*`)

In addition to the Settings UI above, the agent itself can **list, read, create,
update, and delete your own personas** through the first-party `meta_persona_*`
authoring tools on `/api/agent` (`lib/agent/metaTools.ts`, always available,
bound to the signed-in caller). The surface: `meta_persona_list` (summaries, no
body), `meta_persona_read` (body by id), `meta_persona_create` (name + body,
optional slug — derived in the tool layer when omitted, optional `isDefault`),
`meta_persona_update_name`, `meta_persona_update_body`,
`meta_persona_set_default`, `meta_persona_clear_default`, `meta_persona_delete`.
Authoring runs as the signed-in user with immediate effect (no separate confirm),
consistent with Settings. Persona bodies are non-secret user content: they are
returned to the model only on an explicit `*_read` and never reach the
client/Wasm. The snapshot policy above is unaffected — authoring your personas
does not rewrite a running session's locked snapshot.

## How a new session uses a persona

Starting a **New session**:

1. The harness picks the persona you choose, or your **default** persona, or
   **None** if you have no default.
2. On the **first agent turn**, the server resolves the persona body server-side
   and injects it as a labelled **Persona standing orders** block into the agent
   system prompt.
3. The server locks a **snapshot** of that text into the session. Every later
   turn (and every reload or device switch) replays the **same snapshot**.

## Snapshot policy

- A persona is injected **once per session**, at the first agent turn.
- Editing a persona **never rewrites a running session** — an in-flight session
  keeps the snapshot it started with. Your edits apply to the *next* new session.
- Continue keeps the same session id, history, and persona (no re-injection).
- Reloading or opening the session on another device reuses the locked snapshot,
  so the agent's behavior is stable across devices.

This is deliberate: a mid-session persona edit should not silently change what a
long-running session is doing.

## Privacy / trust boundary

- The **picker** only ever receives persona *summaries* (`name`, `slug`,
  `isDefault`, `updatedAt`) — never the body.
- The **body is resolved server-side** by id; it never reaches the browser's
  client bundle or the Wasm harness.
- No secrets live in personas, and nothing secret is added to the client or the
  harness Wasm.
