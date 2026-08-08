# Invincible dogfood sandbox image

Toolchain image for **agent workspace** sandboxes (Vercel Sandbox backend), not
the Zig **build-harness** CI runner.

| This image | Not this |
|------------|----------|
| Ephemeral FS tools (`list_dir` / `read_file` / `exec` …) on a Vercel microVM | Production `harness.wasm` artifact (`build-harness` on self-hosted zig labels) |
| Preinstall Node 22, Zig (from `native/ZIG_VERSION`), `gh`, `rg` | Next.js runtime or baked app source |
| Pushed to **Vercel Container Registry** by GHA | Host env `SANDBOX_BACKEND` (does not exist) |

## Contents

| Tool | Version source |
|------|----------------|
| Ubuntu | 24.04 (amd64) |
| Node.js / npm | **22** (Dockerfile `NODE_VERSION` ARG, major matches GHA) |
| Zig | **`native/ZIG_VERSION`** at image build time |
| `gh` | GitHub CLI (distro channel) |
| `rg` | ripgrep 14.1.1 |
| Basics | git, curl, ca-certificates, build-essential, python3 |

**WORKDIR:** `/workspace`. Image is toolchain-only — **do not** expect the
Invincible monorepo inside the image. Agents clone or write files via tools.

Vercel Sandbox **`Sandbox.create({ image })` does not run** Docker
`ENTRYPOINT`/`CMD`.

## Build & push (official: GitHub Actions)

Primary path: repository Actions → **`dev-image-build`**.

| Input | Meaning |
|-------|---------|
| `confirm` | Must equal **`push`** to build+push (misclick guard) |
| `dry_run` | If true: validate secrets/vars only; no build/push |

Required configuration (**names only** — set in GitHub UI / `gh secret set` from a
cloud agent; never commit values):

| Name | Kind | Role |
|------|------|------|
| `VERCEL_TOKEN` | Actions **secret** | Docker login password to `vcr.vercel.com` |
| `VERCEL_TEAM_ID` | Actions **variable** (or secret) | Docker login **username** |
| `VCR_IMAGE_PREFIX` | Actions **variable** | `vcr.vercel.com/<team-slug>/<project-slug>` (no trailing slash) |

Image repository name is fixed: **`invincible-dev`**.

Tags pushed:

- `${VCR_IMAGE_PREFIX}/invincible-dev:latest`
- `${VCR_IMAGE_PREFIX}/invincible-dev:sha-<shortsha>`

Platform: **`linux/amd64` only** (Sandbox requirement). After push, wait until
VCR status is **Ready** before relying on the image in agent turns.

Optional: path-filtered `push` to **`main`** for `dev/**` and the workflow file
(same guards). **No** `pull_request` trigger.

Laptop `docker build` / `docker push` is **not** the official origin path.

## Point a tenancy sandbox at the image

When tenancy is on (phases 1–4 product path):

1. Admin → **Sandboxes** (`/admin/sandboxes`).
2. Create or edit a row: **backend = vercel**.
3. **Image** = full ref, for example:

   `vcr.vercel.com/<team-slug>/<project-slug>/invincible-dev:latest`

   Short forms such as `<team-slug>/<project-slug>/invincible-dev:latest` also
   pass Invincible’s image shape validation; prefer the full `vcr.vercel.com/…`
   prefix for origin notes. Do not invent slugs in git — use your project’s
   values.

4. Ensure the acting user has a usable grant (create flow grants the actor).
5. Smoke via harness agent tools: `node -v`, `zig version`, `gh --version`,
   `rg --version`.

Null/blank image still means product default `vercel/sandbox/universal:latest`
— set the dogfood ref explicitly to use this image.

## BYO / forks

Copy this directory and workflow; set **your** `VERCEL_TOKEN`, `VERCEL_TEAM_ID`,
and `VCR_IMAGE_PREFIX`. App runtime never builds images.

## Local smoke (optional, non-official)

```bash
# From repo root (agent/CI workspace with Docker)
docker buildx build --platform linux/amd64 -f dev/Dockerfile -t invincible-dev:local --load .
docker run --rm --platform linux/amd64 invincible-dev:local node -v
docker run --rm --platform linux/amd64 invincible-dev:local zig version
docker run --rm --platform linux/amd64 invincible-dev:local gh --version
docker run --rm --platform linux/amd64 invincible-dev:local rg --version
```

## Related docs

- [docs/sandbox.md](../docs/sandbox.md) — backends, image model, dogfood
- [docs/bring-your-own.md](../docs/bring-your-own.md) — BYO Vercel + VCR pattern
- [docs/runner.md](../docs/runner.md) — self-hosted Zig **build-harness** (not this image)
- [SECURITY.md](../SECURITY.md) — secret names / no tokens in images
