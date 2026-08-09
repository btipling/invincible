---
name: cleanup-sandbox
description: >
  Clean up a bare agent/CI sandbox checkout of Invincible so it matches a fresh
  clone of main. Checks out and pulls latest main, deletes leftover local branch
  and working-tree artifacts, and prunes/refreshes remotes. Safe by default:
  never deletes uncommitted work-in-progress unless the operator explicitly says
  to discard it. Asks instead of guessing on anything ambiguous. Requires gh/git.
  Use when the user says "clean up the sandbox", "reset this checkout", "remove
  stray branches/artifacts", "get back to a clean main", or after a session left
  the workspace dirty. Does not push. Never GitHub MCP.
metadata:
  short-description: "Reset a sandbox checkout back to a clean main"
  version: "1.0"
  project: invincible
---

# cleanup-sandbox — reset a checkout to clean main (Invincible)

Reset the current working checkout back to a **clean, up-to-date `main`** while
being **destructive only with explicit operator consent**.

**Default repo:** `btipling/invincible`  
**Related:** `create-plan` / `plan-review` / `adversarial-review` (active work);
this skill is the **post-session hygiene** pass — when work is done, landed, or
abandoned, restore the workspace so the next run (agent session or CI) starts
clean.

**Stance:** the sandbox is shared/fleeting agent infra, not a human workbench,
but it may still hold **current, unpushed work**. That work belongs to the
operator, so the skill **refuses by default** and only deletes uncommitted
changes on an **explicit, unambiguous instruction to discard**. Agent artifacts
that are obviously ours (`*.<tmp>`, plan-body stubs, build scratch) are cleaned
without asking.

Inspired by common repo-hygiene practice (fresh clone discipline, no branch
accumulation, no phantom untracked files) — specialized for this project’s
cloud-agent/CI checkout model and its "merge-ready, not merged" workflow.

---

## 0. Hard gates

```bash
command -v gh >/dev/null || { echo "gh missing — refuse"; exit 1; }
gh auth status || { echo "gh not auth — refuse"; exit 1; }
```

If `gh` fails → **stop**. Never GitHub MCP (`github___*`).

**Also gate on a clean tree before destructive steps** (see §1). Two-stage:
*nondestructive hygiene* always; *destructive cleanup* only when the tree is
clean **or** the operator explicitly said to discard current work.

---

## 1. Safety model (the core contract)

Three buckets, three rules:

| Bucket | What counts | Default |
|--------|-------------|---------|
| **Good left-overs** (keep) | Committed local branches *with* unpushed commits; tags; remote branches | Never delete. Only inform the operator. |
| **Current uncommitted work** | Modified/deleted-tracked files, staged changes, untracked **source** files (e.g. `src/*.zig`, `AGENTS.md`) | **REFUSE to delete** unless the operator says "discard / delete my current work / wipe uncommitted changes" — an unambiguous instruction. A generic "clean the sandbox" is **not** that instruction. |
| **Agent artifacts** (safe to delete) | Untracked files that are obviously session/scratch junk: `*.tmp`, `.tmp-plan-*`, `*.log`, editor swaps, build scratch under `/tmp` or a defined scratch dir, temp plan/body stubs written by us. | **Delete without asking.** |

**Rule of thumb:** if you can't confidently tell whether an untracked file is a
real source file or agent scratch → **ask the operator** rather than guess.
Deleting someone's unpushed work is the worst failure this skill can make; an
extra question is the cheapest fix.

```text
clean-no-uncommitted   → hygiene + clean up, no consent needed
clean-with-uncommitted → STOP, list them, ask:
                          "discard/drop the uncommitted X (not committed/pushed)?
                           or keep them?"
clean-with-unpushed-branch → report it, never delete the commits (they may be
                          saved only locally); let operator rebase/push first.
```

---

## 2. Scaffold is safe

- Missing `main`/`origin` → fetch/remap, do **not** invent branches.
- Unrelated repo / wrong path → refuse.
- Remote not reachable → refuse to touch local branches (would orphan our
  remap); report and stop.

---

## 3. Invocation

| Arg | Default | Notes |
|-----|---------|-------|
| **target branch** | `main` | Name to check out / reset to. |
| **remote** | `origin` | Fetch source. |
| **consent** | `ask` (default) | `discard` = operator said drop current uncommitted work; `keep` = leave uncommitted changes and only do hygienic steps that don't touch them. |
| owner / repo | `btipling` / `invincible` | Override if named. |

The **default `ask`** means: do the safe hygiene first, then **stop and ask**
before any step touching current uncommitted work or unpushed refs.

---

## 4. Workflow (two-stage)

### Stage A — Hygiene (always safe, run first)

```bash
cd <sandbox>                  # a bare agent/CI checkout, not a laptop
git fetch --prune origin      # drop stale remote-tracking refs; prune deleted-upstream
git checkout main             # error out rather than carry a dirty working tree
git pull --ff-only origin main  # catch up; never create merge commits
git gc --auto --prune=now     # compact; harmless
```

**Then inventory leftovers (inform only, do not touch refs):**

```bash
git branch                     # local branches besides main
git branch -r                  # remote-tracking branches (pruned already)
git tag                        # do NOT delete tags
```

Report any non-`main` local branch. If it has **unpushed commits** (`git log
origin/main..<branch>`), surface that to the operator — those commits are only
saved on this checkout.

### Stage B — Cleanup (destructive; gated on §1)

1. **Delete leftover local branches** — for branches that are **fully merged / synchronized** with `main` (nothing unpushed to them) and clean:
   ```bash
   git branch -d <name>   # -d refuses if the branch has unpushed/merged-only commits
   ```
   For a branch with **unpushed commits** → do not `-D`. Report to the operator
   and stop unless they say to drop it.

2. **Uncommitted working-tree files**
   - List them: `git status --porcelain`.
   - **Agent artifacts** (see §1 bucket 3) → delete directly.
   - Anything unclear → **ask first**, do not silently `git reset --hard` or
     `git clean -fdx`. A `git clean -fdx` is only allowed under explicit
     "discard" consent.

3. **Untracked agent scratch in repo** (e.g. `.tmp-plan-*`, `*.log`,
   editor swap files) → delete; these are ours by construction.

4. **Final verify:** `git status --porcelain` empty; on `main`, up to date.

---

## 5. Refusing mid-work

If `git status --porcelain` shows tracked changes, staged changes, or untracked
**source** files, you are **not** at a clean tree. Your job changes to **report,
not destroy**:

```text
- Branch: main (clean) vs <branch>
- Uncommitted: <list> (X modified, Y untracked)
- Unpushed local branch: <branch> (<n> commits ahead of origin/main)
```

Then ask **exactly one** question unless the operator already pre-consented:
"Discard these uncommitted changes / delete this unpushed branch, or keep them?"
Do not proceed until there is an explicit answer. That is the default ask-mode
behavior and it is the whole point of the skill.

---

## 6. What this skill is not

| Not this | Use instead / why |
|----------|-------------------|
| Destruction of current work by default | Refuses; asks (this skill) |
| Deleting remote branches | Never — only local hygiene; remote refs stay authoritative |
| Cleaning a human laptop's world | This is a **shared, disposable agent/CI** checkout — laptop-global hygiene is out of scope and too destructive |
| A build/artifact purge | Only touches git working tree + obvious scratch, not build caches/config unless they're clearly ours |
| Pushing / force-pushing | Never pushes. Leaves everything to the operator / a later turn. |
| Replacing "restart a fresh clone" | If the tree is badly diverged, a fresh `git clone` is often cleaner — say so instead of force-resetting |

---

## 7. Minimal checklist

```text
[ ] gh/git available; auth OK; never GitHub MCP
[ ] Nondestructive Stage A done (fetch --prune, checkout main, ff-only pull, gc --auto)
[ ] Inventory printed: branches, unpushed commits, uncommitted/untracked files
[ ] No current uncommitted work destroyed without explicit "discard" consent
[ ] No unpushed local branch deleted without explicit consent
[ ] Agent-scratch artifacts (`.tmp-plan-*`, logs, swaps) removed
[ ] Final `git status --porcelain` is clean; on up-to-date main
[ ] Operator asked (default ask-mode) for anything ambiguous
```
