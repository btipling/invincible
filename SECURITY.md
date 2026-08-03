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

Zig builds run on a **self-hosted** GitHub Actions runner (`labels: invincible, zig`).

To reduce abuse risk when this repository is **public**:

1. **No `pull_request` triggers** on self-hosted workflows — only `push` to `main` (path-filtered) and `workflow_dispatch`.
2. Jobs include `if:` guards: `github.repository == 'btipling/invincible'` and not a pull_request event.
3. **Do not** add `pull_request` / `pull_request_target` to those workflows without a deliberate design review.
4. Prefer GitHub setting: require approval for first-time contributors’ workflows; keep fork PR workflows off the self-hosted pool.
5. Host inventory (IPs, droplet IDs) is **not** published in this repo — keep private notes offline.

Maintainers: still harden the VM (SSH keys, firewall, unattended upgrades) using private runbooks; public docs stay abstract.

## Production app

Inference is server-side only (`POST /api/chat`). Report client-side key exposure immediately.
