# Invincible project skills

Repo skills for [btipling/invincible](https://github.com/btipling/invincible).
These are **project** skills (under `.grok/skills/`), not generic app-builder skills.

## Hard gate

```bash
command -v gh >/dev/null && gh auth status
```

If that fails → **refuse** all GitHub work. Do not use GitHub MCP tools.

## Zero-search rule

**Do not** `find` / web-search for these. Load via `gh`:

```bash
gh repo clone btipling/invincible /tmp/invincible -- --depth 1
# then read .grok/skills/<name>/SKILL.md and references/*

# Or single file:
gh api "repos/btipling/invincible/contents/.grok/skills/<name>/SKILL.md?ref=main" \
  --jq .content | base64 -d
```

## Skills

| Skill | Directory | Purpose |
|-------|-----------|---------|
| **create-plan** | `create-plan/` | Author feature plans as **GitHub issues** (parent + optional phase issues); **cloud ops + living docs** required |
| **plan-review** | `plan-review/` | Review plan issues: correctness, perf, architecture, tests, layers, **cloud ops**, **living docs**, parent; default **edit issue body** via `gh` |
| **adversarial-review** | `adversarial-review/` | Hostile **PR** review (break scenarios, security, feature-divide, runner/CI); default **comment on PR** via `gh` |
| **cleanup-sandbox** | `cleanup-sandbox/` | Post-session hygiene: checkout + pull latest `main`, delete leftover local branches / agent scratch; **refuses** to discard current uncommitted work without explicit operator consent |
| **implement-plan** | `implement-plan/` | Code a reviewed plan into a **non-merged PR** + tests: canonical test/build workflow (`npm run typecheck`, `node run-tests.mjs`), in-sandbox exec rules (10-min timeout, transport drops, no orphaned runs), layer ownership, code standards that survive review |

## Cloud-native ops (create-plan + plan-review)

There is **no personal laptop product shell**. Production mutates (migrate, seed,
backfill, re-encrypt, coordinated env cutover) must plan a **GitHub Actions
`workflow_dispatch` primary path** (new or extend). Scripts/`npm run` are what
the job runs — not the only operator story.

**Reject:** “document npm run X” with no GHA while Production still needs the op.

## Living docs (create-plan + plan-review)

Durable guides: `docs/*`, `AGENTS.md`, `README.md`, `SECURITY.md`, `.env.example`.
Always consider AGENTS + README. Product docs must be **timeless** for newcomers —
**not** phase numbers, GitHub issue archaeology, or plan handoff checklists
(those stay in **issues** only).

## create-plan

User: “use the create-plan skill to add feature X”

1. Read `AGENTS.md` + `docs/feature-divide.md`  
2. Draft plan in the skill format (layers, architecture, tests, **cloud ops**, **docs**)  
3. `gh issue create` parent; optional phase issues with `Parent: #N`  
4. Do not implement until plan-review / user says go  

## plan-review

User: “load plan-review and review issue #N”

See [`plan-review/LOAD.md`](plan-review/LOAD.md):

1. Ensure `gh` works (refuse if not)  
2. Clone or `gh api` skill files from `main`  
3. `gh issue view N`  
4. Review (incl. cloud ops + living docs); default `mode=fix` → full body update via `gh issue edit`  

## implement-plan

User: “implement issue #N” / “implement the plan” (after plan-review go)

See [`implement-plan/LOAD.md`](implement-plan/LOAD.md):

1. `gh` gate + read `AGENTS.md`
2. Read the plan issue fully; ground in live code on the branch
3. Implement in the plan's locked layers; add tests for non-trivial logic
4. Verify: `npm run typecheck` → `node run-tests.mjs` (10-min timeout) → build gate
5. Commit (author `btipling`), push, `gh pr create` (base `main`, `Closes/Refs #N`)
6. **Do NOT merge** — stop at merge-ready; suggest `adversarial-review` next

## adversarial-review

User: “adversarial-review PR #N” / “red-team this PR”

See [`adversarial-review/LOAD.md`](adversarial-review/LOAD.md):

1. `gh` gate + read `AGENTS.md`  
2. Load skill + PR diff  
3. Attack lenses (secrets, runner, feature-divide, bridge, deploy race, tests…)  
4. Self-refute findings; verdict BLOCK / CONCERNS / PASS WITH NOTES  
5. Default `mode=comment` → `gh pr review` / `gh pr comment`  
6. Does **not** implement fixes unless asked  

## cleanup-sandbox

User: “clean up the sandbox” / “reset this checkout” / “remove stray branches”

See [`cleanup-sandbox/LOAD.md`](cleanup-sandbox/LOAD.md):

1. `gh`/`git` gate; read `AGENTS.md`  
2. Stage A hygiene: `fetch --prune origin`, checkout `main`, `pull --ff-only`, `gc --auto`  
3. Inventory leftovers (local branches, unpushed commits, uncommitted/untracked files)  
4. Delete only obvious **agent artifacts** (`.tmp-plan-*`, logs, swaps)  
5. Current uncommitted work / unpushed branch → **stop and ask** (default `ask`); only discard on explicit operator instruction  
6. Never push, never delete remote branches, never force-reset without consent  

## Push / GitHub doctrine

- **Always `gh` + local `git` for code.** Never `github___*` MCP tools.  
- **Plans live in issues** (create-plan / plan-review), not as a required `docs/*-plan.md`.  
- Commit author for code: `btipling <btipling@users.noreply.github.com>`.  
- One commit per unit of work when implementing later.  
- “Local” = agent/CI checkout — not a human’s personal machine.  

See root [`AGENTS.md`](../../AGENTS.md) → **Project agent skills**, **Operator & agent model**, and **Reusable product**.
