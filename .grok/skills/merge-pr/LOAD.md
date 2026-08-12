# merge-pr — load card (zero search)

When the user says "merge the PR" / "merge PR #N" / "go ahead and merge" / "merge
and close what it resolves" after review is green:

## Hard gate

```bash
command -v gh >/dev/null && gh auth status
```

Refuse if that fails. Never GitHub MCP.

## FIRST — `AGENTS.md` (mandatory, esp. PR merge convention)

```bash
gh api "repos/btipling/invincible/contents/AGENTS.md?ref=main" --jq .content | base64 -d
# read the "PR merge convention (optional)" section: merge commit, CI-before-merge,
# issue close-out, after-merge steps.
# operator model = cloud agent / CI only (no personal laptop shell).
```

## Load skill

```bash
gh repo clone btipling/invincible /tmp/invincible -- --depth 1
# .grok/skills/merge-pr/SKILL.md
# or per-file:
gh api "repos/btipling/invincible/contents/.grok/skills/merge-pr/SKILL.md?ref=main" \
  --jq .content | base64 -d
```

## Inspect the PR + checkout

```bash
gh pr view <N> --repo btipling/invincible \
  --json number,title,state,baseRefName,headRefName,mergeable,url,author
gh pr diff <N> --repo btipling/invincible     # confirm scope before merging
git status --porcelain                        # clean tree? staged/untracked?
```

## Then (the mandatory gate)

1. `npm run typecheck` → exit 0
2. **Full suite, directly with vitest, no wrapper — this is required:**
   ```bash
   node_modules/vitest/vitest.mjs run        # timeoutMs ≈ 600000; exit 0 AND failed=0
   ```
   `vitest run --changed`/`npm run test:changed` is the **fast** PR-iteration
   signal only and is **NEVER** sufficient to authorize a merge.
3. Confirm PR is OPEN on `main`, MERGEABLE, adversarial review satisfied,
   required CI green.
   **Cold-boot gate (automatic refuse):** `gh pr diff` must not add `new PGlite(`
   outside the one shared test helper (`#431`). Two+ engines in one file, or a
   changed test still constructing PGlite after the helper exists → stop. Not
   waivable. Untouched legacy boots on `main` are `#431`, not this merge.
4. Merge with the repo's merge-commit convention:
   ```bash
   gh pr merge <N> --repo btipling/invincible --merge --delete-branch
   ```
5. Verify issue close-out (`Fixes/Closes` auto-closed; `Refs` parents left open).
6. After merge: `git checkout main && git pull --ff-only`; `git remote prune origin`;
   confirm head branch deleted; report merge SHA + fast-forward range.
