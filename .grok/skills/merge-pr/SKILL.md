---
name: merge-pr
description: >
  Merge a PR into main for Invincible with a mandatory full test gate. Use when
  the user says "merge the PR", "merge PR #N", or asks to merge/close after
  review is green. Requires the full suite (vitest run, no --changed shortcut,
  no wrapper) to be green before merging — per AGENTS.md, tests run directly
  with vitest and the correctness gate for a merge is the FULL vitest run, not
  the fast changed-only gate. Also requires gh. Never GitHub MCP.
metadata:
  short-description: "Merge a reviewed, fully-tested PR with required full vitest gate"
  version: "1.0"
  project: invincible
---

# merge-pr — merge a reviewed, fully-tested PR (Invincible)

Merge an **open, reviewed PR** into `main` **only after a full suite is proven
green** directly with vitest. This skill is the final act after
`implement-plan` → `adversarial-review` (and optionally plan-review) have run.

**Default repo:** `btipling/invincible`
**Related:** `implement-plan` (open non-merged PR) → `adversarial-review`
(hostile review) → **this skill** (merge). `cleanup-sandbox` is the post-merge
hygiene pass. `plan-review` gates the plan issue (not the code PR).

**Stance:** merging is the extension of a reviewed plan into `main`. It is
**irreversible in practice** (fast-forward/merge commit becomes history), so the
bar is: the PR's code changes are **tested green by the FULL suite**, run
**directly with vitest**, with a **passing `typecheck`**, and any issues the PR
claims to close are verified. A merge gap here ships breakage to everyone; the
extra cost of one full `vitest run` before that is cheap insurance. The
correctness gate for a merge is the **full** run — `vitest run --changed` is the
_fast_ PR-iteration signal only and is **never** sufficient to authorize a merge.

Inspired by common "review then merge with CI green" practice — specialized for
this project's no-wrapper vitest rule (`AGENTS.md`), its merge-commit convention
(no squash), and its agent/CI-only operator model.

---

## 0. Hard gates

```bash
command -v gh >/dev/null || { echo "gh missing — refuse"; exit 1; }
gh auth status || { echo "gh not auth — refuse"; exit 1; }
```

If `gh` fails → **stop**. Never GitHub MCP (`github___*`).

Merge commits under this repo's convention are authored by the PR authors
(hard-constrained `btipling`), **not** rewritten by the merger. Do **not**
`git config` a different identity to merge; merging via `gh pr merge` does not
touch authorship.

Before merging anything:

1. Read root **`AGENTS.md`** — especially the **PR merge convention** section
   (merge type, when to merge, CI-before-merge, issue close-out, after-merge).
2. Read **`SECURITY.md`** if the PR touches workflows, secrets, runner, or API.
3. Load this skill (zero-search via `gh` / clone).

---

## 1. Invocation

### Input

| Arg | Meaning | Examples |
|-----|---------|----------|
| **pr** | PR number or URL (required) | `36`, `https://github.com/btipling/invincible/pull/36` |

Optional:

| Arg | Default | Notes |
|-----|---------|--------|
| owner / repo | `btipling` / `invincible` | Override if named |
| runFullSuite | **`true`** | **Require full `vitest run`** before merge. `false` only on explicit, informed operator request (not recommended; never silently). |
| mode | **`merge`** | `merge` = run gates then `gh pr merge --merge`. `dry_run` = run the gates, report, do **not** merge. `close` = run gates, then close linked issue(s) + delete branch but do not merge. |

---

## 2. The mandatory test gate — full suite, directly with vitest, no wrapper

**This is the heart of the skill.** Per `AGENTS.md`: "Tests are run directly
with vitest — no script wrappers allowed" and "the full `vitest run` … is the
actual correctness gate." Do **not** skip, wrap, or substitute it.

### The gate

```bash
npm run typecheck                                   # tsc --noEmit, exit 0
node_modules/vitest/vitest.mjs run                  # FULL suite, must be failed=0
```

- Run vitest through the **local binary** (never `npx`), foreground, with an
  explicit `timeoutMs ≈ 600000` (10 min) so a long run is not killed mid-flight
  by the default 5-min tool timeout.
- **Verdict is the exit code + per-file failure count.** `vitest run` exits
  non-zero when any test fails. Read the live per-file output; `exit 0` AND
  `failed=0`. Never claim green from a summarized line or a wrapper.
- **`--changed` is a fast gate, not a merge gate.** `vitest run --changed`
  (= `npm run test:changed`) runs only changed files + static dependents and
  can **silently miss** breakage in non-imported data (fixtures, snapshots,
  config, migration SQL) or broad lib changes. It is acceptable for *iteration*;
  it is **never** an acceptable substitute for the full run before a merge.
- On a slow/strong box the full suite takes ~5 min (few hundred files, ~2000+
  tests, parallel workers). Pay it. A merge without it is a skill failure.

---

## 3. Pre-merge checklist (verify all before the merge commit)

1. **PR exists, is open, and targets `main`:**
   ```bash
   gh pr view <N> --json number,title,state,baseRefName,headRefName,mergeable,url,author,files,additions,deletions
   ```
   - `state == "OPEN"`, `baseRefName == "main"`, `mergeable == "MERGEABLE"`.
   - If `mergeable == "CONFLICTING"` → **stop**; do not merge into a conflicted base.
2. **No uncommitted/unexpected work in the local checkout** (`git status
   --porcelain`), unless it's untracked scratch we created deliberately and it's
   not staged. Do not merge while the working tree has unrelated tracked changes.
3. **Adversarial review is satisfied** (PASS / PASS WITH NOTES, or the blocking
   CONCERNS were fixed and re-reviewed). If a BLOCK/CONCERNS review is still
   outstanding and the PR head hasn't changed to address it → **stop and ask**.
4. **Full suite is green** (from §2): `typecheck` exit 0 AND full `vitest run`
   exit 0 / failed=0. Record the actual file/pass/fail counts.
5. **CI checks (if the repo enforces them)**: wait for required checks
   (`test` / `typecheck` / `build` / `build-harness`) to complete **green**;
   do not merge on `pending`/`failed` unless you explicitly call out the only
   outstanding ones as unrequired/infrastructure.
6. **Vercel deploy (if it's the merged branch's deploy)**: if a deployment for
   the head is failing, call it out; don't silently merge into a red deploy.

---

## 4. Merging

Merge type for this repo is the **merge commit** (no squash, no linearize) —
see `AGENTS.md` "PR merge convention":

```bash
gh pr merge <N> --repo btipling/invincible --merge --delete-branch
```

- `--merge` creates a real merge commit, preserving each PR's conventional
  commits and authorship.
- `--delete-branch` removes the merged head branch from the remote.

**Issue close-out:** if the PR body carries `Fixes #N` / `Closes #N`, the merge
auto-closes those issues. After merge, verify (`gh issue view N`) that the issue
is closed. Close them as **completed**; reference the merge SHA. Do **not** close
issues the PR only `Refs` (parent/prerequisite) — those stay open.

---

## 5. After merge

```bash
gh pr view <N> --repo btipling/invincible --json state,mergedAt,mergeCommit  # confirm MERGED
# in the local checkout:
git checkout main && git pull --ff-only origin main
git remote prune origin                 # drop stale remote-tracking refs
git branch --list                      # confirm no leftover local feature branch
```

- Confirm the remote head branch is gone (`git ls-remote --heads origin
  '<name>'`).
- Leave the workspace on a clean, up-to-date `main`.
- Report: PR number, merge SHA, base `main` fast-forward range, issues auto-closed.

---

## 6. Refusing / stopping mid-merge

Stop and ask before merging when any of the following hold:

- `gh` auth failed (hard gate).
- PR is not open / not targeting `main` / conflicting.
- **Full `vitest run` is not green** (any failure, non-zero exit, or a wrapper
  used). Do not merge on `--changed` alone.
- `typecheck` failed.
- A BLOCK/CONCERNS adversarial review is outstanding on the current head.
- There is uncommitted tracked work in the local checkout that isn't ours.
- The merge target isn't `main` (a PR into a feature branch is out of scope for
  this skill unless the operator names that branch explicitly).

---

## 7. What this skill is not

| Not this | Use instead / why |
|----------|-------------------|
| A plan quality gate | `plan-review` |
| A code-quality/review gate | `adversarial-review` (run it first) |
| Squash/linearize merging | This repo convention = merge commit (`--merge`); no squash |
| Merging without a full test run | Skill failure — the full `vitest run` is mandatory |
| Fast-gate (`--changed`) merge | The correctness gate is the full suite |
| Authoring/fixing code | separate implement turn; merging doesn't edit the PR |
| Post-merge hygiene of the whole sandbox | `cleanup-sandbox` (after this) |

---

## 8. Minimal checklist

```text
[ ] gh auth OK; never GitHub MCP
[ ] AGENTS.md PR merge convention read (feature-divide/SECURITY when relevant)
[ ] PR <N> is OPEN, base=main, MERGEABLE (not CONFLICTING)
[ ] Working tree clean (only deliberate untracked scratch is untouched)
[ ] Adversarial review satisfied (PASS/PASS WITH NOTES or CONCERNS resolved)
[ ] `npm run typecheck` exit 0
[ ] FULL `node_modules/vitest/vitest.mjs run` exit 0 / failed=0
    (direct vitest, no wrapper; --changed is NOT sufficient)
[ ] Required CI checks green (no merge on pending/failed)
[ ] Merged with `gh pr merge --merge --delete-branch`
[ ] Issues with Closes/Fixes keyword verified closed; Refs parents left open
[ ] Local main synced; remote head branch deleted; stale refs pruned
```
