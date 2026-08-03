# Harness deploy race (Wasm artifact vs Vercel)

## Problem

On one `git push` to `main` that touches `native/harness/**`:

1. **Vercel Git** starts a production build immediately  
2. **`build-harness.yml`** starts on `invincible-do-1` in parallel  
3. Vercel `npm run prebuild` downloads Actions artifact `harness-wasm`  
4. If (1) finishes **before** (2) uploads the artifact, prod ships the **previous** Wasm  

Symptom we hit: Asteronica theme in git, but prod canvas still light Adwaita + old UI strings.

## Permanent fix

### 1. Wait-for-commit in `scripts/fetch-harness-artifact.mjs` (primary)

On Vercel (`VERCEL=1`):

| Step | Behavior |
|------|----------|
| Read | `VERCEL_GIT_COMMIT_SHA` |
| Poll | `build-harness.yml` runs for that `head_sha` |
| Grace | If **no** run appears within ~90s → commit did not trigger harness CI → use **latest** artifact |
| Wait | If a run exists → wait until `success` (up to ~12m) |
| Fetch | Artifact from **that run**, not “whatever is latest” mid-race |
| Fail | If harness CI fails for this SHA → **fail the Vercel build** (no silent stale ship) |

Local/default: `HARNESS_WAIT_MS=0` → latest artifact immediately.

### 2. Deploy hook after upload (secondary)

`.github/workflows/build-harness.yml` posts `VERCEL_DEPLOY_HOOK_URL` **after** artifact upload.

- Optional secret; if unset, wait-for-SHA still protects Git deploys  
- Recommended: set hook so a second deploy always follows harness CI  

## Operator checklist

1. Vercel env: `HARNESS_ARTIFACT_TOKEN` (Actions: Read)  
2. GitHub secret (recommended): `VERCEL_DEPLOY_HOOK_URL`  
3. Do **not** set `HARNESS_SKIP_FETCH=1` on Production  

## Related

- Option B shipping: no Wasm binaries in git  
- [`docs/harness-limits.md`](harness-limits.md)  
- Workflow: `.github/workflows/build-harness.yml`  
