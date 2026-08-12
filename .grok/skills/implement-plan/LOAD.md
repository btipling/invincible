# implement-plan — load card (zero search)

When the user says “implement” / “implement issue #N” / “implement the plan” /
“code the plan”:

## Hard gate

```bash
command -v gh >/dev/null && gh auth status
```

If that fails → **refuse**. Do not use GitHub MCP.

**Status must be HANDOFF-READY. Otherwise this skill cannot run.**

```bash
gh issue view <N> --repo btipling/invincible --json title,body,state
```

If the plan header Status is not **`HANDOFF-READY`** (DRAFT, NEEDS REVISION,
BLOCKED, IN PROGRESS, COMPLETE, missing, or a stale header vs a NEEDS REVISION
review) → **stop**. Do not branch. Do not code. Do not open a PR. Tell them to
run `plan-review` until the issue is HANDOFF-READY. Not waivable.

## FIRST — `AGENTS.md` (mandatory)

```bash
gh api "repos/btipling/invincible/contents/AGENTS.md?ref=main" --jq .content | base64 -d
# also when UI/agent loop: docs/feature-divide.md
# note: Operator & agent model = cloud only (no personal laptop shell)
```

## Do NOT

Search the filesystem, web, or GitHub code for the skill.
Do **not** call `github___*` tools.

## DO — load the skill + the plan via `gh` (owner=`btipling`, repo=`invincible`)

```bash
gh repo clone btipling/invincible /tmp/invincible -- --depth 1
# read:
#   .grok/skills/implement-plan/SKILL.md
#   AGENTS.md, docs/feature-divide.md (when UI/bridge/agent)

# Or per-file:
gh api "repos/btipling/invincible/contents/.grok/skills/implement-plan/SKILL.md?ref=main" \
  --jq .content | base64 -d
```

### Plan issue

```bash
gh issue view <N> --repo btipling/invincible --json number,title,body,url,state
```

## Then

0. **Update main + start clean.** First, a merged GitHub PR does **not** update
   your local `main` — run `git fetch origin`, `git checkout main`,
   `git pull --ff-only origin main`, and check `git log --oneline -1 main`
   against the merged SHA before reading any code. Then, if the workspace is
   left over from a prior session (stray branch, unpushed commits, untracked
   scratch), also run `cleanup-sandbox`. Do **not** implement on top of a dirty
   or stale tree.
1. Confirm `AGENTS.md` was read this session.
2. Read the plan fully. **If Status ≠ HANDOFF-READY, STOP** (see hard gate).
   Do not implement DRAFT / NEEDS REVISION / BLOCKED plans via this skill.
3. Ground claims in **live code** on the branch you code against (usually `main`).
   Do not invent APIs; mark unverified symbols.
4. Implement in the plan's locked layers; add tests for every non-trivial piece.
5. Verify: `npm run typecheck` → full `vitest run` (10-min timeout, or
   `vitest run --changed` for a fast changed-only gate) → build gate when
   applicable. See SKILL.md §2 for the in-sandbox rules.
6. Commit (author `btipling`), push, `gh pr create` (base `main`; `Fixes #N` /
   `Closes #N` for the plan issue, `Refs #N` for parents).
7. **Do NOT merge.** Stop at merge-ready; suggest `adversarial-review` next.
