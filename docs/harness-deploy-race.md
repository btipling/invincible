# Harness deploy race (Wasm artifact vs Vercel)

## Problem

On one `git push` to `main` that touches `native/harness/**`:

1. **Vercel Git** starts a production build immediately  
2. **`build-harness.yml`** starts on `invincible-do-1` in parallel  
3. Vercel `npm run prebuild` downloads Actions artifact `harness-wasm`  
4. If (1) finishes **before** (2) uploads the artifact, prod ships the **previous** Wasm  

Symptom we hit: Asteronica theme in git, but prod canvas still light Adwaita + old UI strings.

**Harder failure (PR #216 / #205):** merge changed `native/harness/**` but **no** `build-harness` run was ever created for that SHA. Wait-for-SHA grace treated “no run” as “paths skipped” and shipped **latest** (pre-feature) Wasm. Next.js deploy looked green; bare autolink never appeared on Production.

## Permanent fix

### 1. Wait-for-commit in `scripts/fetch-harness-artifact.mjs` (primary)

On Vercel (`VERCEL=1`):

| Step | Behavior |
|------|----------|
| Read | `VERCEL_GIT_COMMIT_SHA` |
| Poll | `build-harness.yml` runs for that `head_sha` |
| Grace | If **no** run appears within ~90s → inspect commit file list |
| No run + harness paths | **Fail the Vercel build** — do not ship stale Wasm (`native/harness/**`, `native/ZIG_VERSION`, or `build-harness.yml`) |
| No run + other paths | Commit did not need a harness rebuild → use **latest `main` artifact** (never a PR head) |
| Wait | If a run exists → wait until `success` (up to ~12m) |
| Fetch | Artifact from **that run**, not “whatever is latest” mid-race |
| Fail | If harness CI fails for this SHA → **fail the Vercel build** (no silent stale ship) |

Local/default: `HARNESS_WAIT_MS=0` → latest **main-branch** artifact immediately.

### PR builds must not ship

`build-harness` still **compiles + `zig build test-rich`** on same-repo contributor PRs (merge gate) and uploads **`harness-wasm-pr-<n>`** so the Zig/Wasm build is a downloadable CI artifact. It does **not** upload the production name `harness-wasm` unless `github.ref == refs/heads/main` (push to main or `workflow_dispatch --ref main`).

`scripts/fetch-harness-artifact.mjs` `latest` also ignores any `harness-wasm` whose `workflow_run.head_branch !== main`. A host-only `main` deploy that falls back to latest cannot pick up an unmerged PR head.

**Incident:** a same-repo harness PR uploaded `harness-wasm`; the next Production Git deploy did not touch `native/harness/**`, so fetch fell back to latest and served that PR’s Wasm. `workflow_dispatch` on main rebuilt a good artifact, but `VERCEL_DEPLOY_HOOK_URL` was empty so Vercel never redeployed — Production stayed on the poisoned build. Recovery is a Production Git deploy of `main` (this doc + fetch filter) after a main artifact exists.

Path match helpers: `isHarnessBuildPath` / `commitTouchesHarnessBuild` / `isShippableHarnessArtifact` in `scripts/harnessRepo.mjs` (unit-tested; keep aligned with workflow path filters **and** the main-only upload `if:`).

If Production fails closed with “no build-harness run … touches harness build paths”, recover with **`workflow_dispatch`** on `build-harness` for `main` (artifact upload then pings the deploy hook). When the DO runner is offline, dispatch with **`runner=ubuntu-latest`** (Zig freestanding build works on GitHub-hosted).

### 2. Deploy hook after upload (secondary)

`.github/workflows/build-harness.yml` posts `VERCEL_DEPLOY_HOOK_URL` **after** artifact upload.

**Status: secret may be empty.** `build-harness` then WARNs and skips the hook (exit 0) — a `workflow_dispatch` on main uploads a good artifact but **does not** create a Vercel deployment. Recover with a Production Git deploy of `main` so `fetch-harness` can bind a main-branch artifact. If a log prints `VERCEL_DEPLOY_HOOK_URL` empty, that is a secrets-access regression on origin — investigate in Actions secrets; do not re-explain setup to the user by default.

### 3. Merge discipline for harness PRs

Do **not** treat a harness feature as Production-done until:

1. `build-harness` is **green for the merge SHA** (or a later `main` SHA that includes it), and  
2. Operator smoke on `/harness` for the product repro (not only `zig build test-rich`).

Skipping L4 / “CI not yet observed” is a merge blocker for `native/harness/**` changes, not a residual note.

## Related

- Option B shipping: no Wasm binaries in git  
- [`docs/harness-limits.md`](harness-limits.md)  
- Workflow: `.github/workflows/build-harness.yml`  
- IDs: [`docs/project-ids.md`](project-ids.md)

## Redeploy after harness-only CI

`build-harness` uploads `harness-wasm` and may POST `VERCEL_DEPLOY_HOOK_URL`.
If that Actions secret is **empty**, the hook step exits 0 with a WARN and **no**
new Vercel deployment is created (Git-linked deploys still fire only on `main` pushes).

**Recovery:** set `VERCEL_DEPLOY_HOOK_URL` in repo Actions secrets, or push/redeploy
Production so `fetch-harness` can bind the artifact for the current `main` SHA.

