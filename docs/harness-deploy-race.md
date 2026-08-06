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
| No run + other paths | Commit did not need a harness rebuild → use **latest** artifact |
| Wait | If a run exists → wait until `success` (up to ~12m) |
| Fetch | Artifact from **that run**, not “whatever is latest” mid-race |
| Fail | If harness CI fails for this SHA → **fail the Vercel build** (no silent stale ship) |

Local/default: `HARNESS_WAIT_MS=0` → latest artifact immediately.

Path match helpers: `isHarnessBuildPath` / `commitTouchesHarnessBuild` in `scripts/harnessRepo.mjs` (unit-tested; keep aligned with workflow path filters).

If Production fails closed with “no build-harness run … touches harness build paths”, recover with **`workflow_dispatch`** on `build-harness` for `main` (artifact upload then pings the deploy hook). When the DO runner is offline, dispatch with **`runner=ubuntu-latest`** (Zig freestanding build works on GitHub-hosted).

### 2. Deploy hook after upload (secondary)

`.github/workflows/build-harness.yml` posts `VERCEL_DEPLOY_HOOK_URL` **after** artifact upload.

**Status: already configured** (GitHub secret). Agents must not prompt the user to add or “wire” this hook. See [`AGENTS.md`](../AGENTS.md).

If a workflow log prints `VERCEL_DEPLOY_HOOK_URL not set`, that is a regression — investigate secrets access, do not re-explain setup to the user by default.

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
