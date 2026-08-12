# implement-plan — load card (zero search)

When the user says “implement” / “implement issue #N” / “implement the plan” /
“code the plan” after a plan-review go:

## Hard gate

```bash
command -v gh >/dev/null && gh auth status
```

If that fails → **refuse**. Do not use GitHub MCP.

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

0. **Start clean: run `cleanup-sandbox` first** if the workspace is left over
   from a prior session (stray branch, unpushed commits, untracked scratch).
   Do **not** implement on top of a dirty tree.
1. Confirm `AGENTS.md` was read this session.
2. Read the plan fully (headers: Status, Layers, Cloud ops path, Living docs, DoD).
3. Ground claims in **live code** on the branch you code against (usually `main`).
   Do not invent APIs; mark unverified symbols.
4. Implement in the plan's locked layers; add tests for every non-trivial piece.
5. Verify: `npm run typecheck` → `node run-tests.mjs` (10-min timeout) → build
   gate when applicable. See SKILL.md §2 for the in-sandbox rules.
6. Commit (author `btipling`), push, `gh pr create` (base `main`; `Fixes #N` /
   `Closes #N` for the plan issue, `Refs #N` for parents).
7. **Do NOT merge.** Stop at merge-ready; suggest `adversarial-review` next.
