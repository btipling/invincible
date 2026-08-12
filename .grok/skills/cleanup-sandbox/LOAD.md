# cleanup-sandbox — load card (zero search)

When the user says "clean up the sandbox" / "reset this checkout" / "remove
stray branches / artifacts" / "get back to a clean main":

## Hard gate

```bash
command -v gh >/dev/null && gh auth status
```

Refuse if that fails. Never GitHub MCP.

## FIRST — AGENTS.md (for checkout norms)

```bash
gh api "repos/btipling/invincible/contents/AGENTS.md?ref=main" --jq .content | base64 -d
```

## Load skill

```bash
gh repo clone btipling/invincible /tmp/invincible -- --depth 1
# .grok/skills/cleanup-sandbox/SKILL.md
```

## Inspect the checkout

```bash
git status --porcelain      # clean tree? uncommitted work? untracked files?
git branch                  # leftover local branches
git branch -r               # remote-tracking branches (prune during cleanup)
git log --oneline -1 main   # where HEAD is vs origin/main
```

## Then

1. Stage A hygiene: `fetch --prune`, checkout main, `pull --ff-only`, `gc --auto`
2. Inventory leftovers (branches, unpushed commits, uncommitted/untracked files)
3. Delete obvious agent artifacts (`.tmp-plan-*`, logs, swaps)
4. **Delete nested self-clones of this repo** (same-origin `ivc-*` / `.grok`
   reference clones with their own `.git` whose `origin` == sandbox origin)
   **without asking** — these double the vitest suite; see `SKILL.md` §1
5. For anything else (current uncommitted work / unpushed branch) → **stop and ask**
6. Never push; never delete remote branches; never force-reset without "discard" consent
