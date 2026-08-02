# public/harness — build-time only

**Do not commit** `harness.wasm` / `web.js` (multi‑MB binaries).

They are installed by:

```bash
npm run fetch-harness   # also runs as prebuild on Vercel
```

which downloads the latest GitHub Actions artifact **`harness-wasm`**
(built on `invincible-do-1` via `build-harness.yml`).

## Vercel env

| Name | Required | Scope |
|------|----------|--------|
| `HARNESS_ARTIFACT_TOKEN` | **yes** (prod/preview) | Fine-grained PAT: **Actions: Read** on `btipling/invincible` |

Optional: `HARNESS_ARTIFACT_ID` to pin an artifact.

## Local

```bash
# with GH auth / token:
npm run fetch-harness

# or after zig build:
./native/harness/build.sh   # writes native/dist/harness — fetch script will copy it if no token
```
