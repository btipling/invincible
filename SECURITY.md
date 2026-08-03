# Security

## Reporting

If you find a vulnerability in Invincible, please open a **private** security advisory on GitHub (or email the maintainer) rather than a public issue with exploit details.

## Secrets

| Never commit | Where it lives |
|--------------|----------------|
| `AI_GATEWAY_API_KEY` | Vercel project env only |
| `HARNESS_ARTIFACT_TOKEN` | Vercel (Actions: Read PAT for artifact download) |
| `VERCEL_DEPLOY_HOOK_URL` | GitHub Actions secrets |
| Runner registration tokens, DO API tokens | Operator machines only |

Session blobs and Wasm must never contain API keys.

## Self-hosted runner (public repo policy)

Zig builds run on a **self-hosted** GitHub Actions runner (default labels: `self-hosted`, `invincible`, `zig`).

To reduce abuse risk when this repository is **public**:

1. **No `pull_request` / `pull_request_target` triggers** on self-hosted workflows — only `push` to `main` (path-filtered) and `workflow_dispatch`.
2. Jobs include `if:` guards:
   - **Opt-in:** `vars.SELF_HOSTED_BUILDS == 'true'` (repository **Actions variable**, not a secret), **or**
   - **Origin grandfather:** `github.repository == 'btipling/invincible'` (maintainer continuity if the variable is unset)
   - and only `workflow_dispatch` or `push` to `main` (not merely “ref is main”).
3. **Clones / forks** must set `SELF_HOSTED_BUILDS=true` after attaching their own runner. Without that variable, self-hosted jobs **skip** (safe default).
4. Optional: `vars.RUNNER_LABELS` as a JSON array (e.g. `["self-hosted","invincible","zig"]`). If unset, workflows use that default list via `fromJSON`.
5. **Do not** add `pull_request` / `pull_request_target` to those workflows without a deliberate design review.
6. Prefer GitHub setting: require approval for first-time contributors’ workflows; keep fork PR workflows off the self-hosted pool.
7. Host inventory (IPs, droplet IDs) is **not** published in this repo — keep private notes offline.

| Setting | Kind | Purpose |
|---------|------|---------|
| `SELF_HOSTED_BUILDS` | Actions **variable** (`true`) | Enable self-hosted jobs on **this** repository |
| `RUNNER_LABELS` | Actions **variable** (JSON array) | Optional `runs-on` labels override |
| `VERCEL_DEPLOY_HOOK_URL` | Actions **secret** | Post-artifact redeploy (origin) |

Maintainers: still harden the VM (SSH keys, firewall, unattended upgrades) using private runbooks; public docs stay abstract.

## Production app

Inference is server-side only (`POST /api/chat`). Report client-side key exposure immediately.
