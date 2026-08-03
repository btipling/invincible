# Invincible — public project pointers

Public-facing IDs and URLs. **No host IPs, droplet IDs, or cloud account GUIDs** (those stay in private operator notes).

| | |
|--|--|
| **GitHub** | https://github.com/btipling/invincible (`main`) |
| **Production** | https://invincible-dun-ten.vercel.app |
| **Harness** | https://invincible-dun-ten.vercel.app/harness |
| **Vercel project** | `invincible` (Git-linked to this repo) |

## Env / secrets (names only — never values in git)

| Name | Where | Notes |
|------|--------|--------|
| `AI_GATEWAY_API_KEY` | Vercel Production + Preview | Server-side only |
| `DEFAULT_MODEL` | Vercel (optional) | default `xai/grok-4.1-fast-non-reasoning` |
| `HARNESS_ARTIFACT_TOKEN` | Vercel | Actions: Read — prebuild downloads `harness-wasm` |
| `VERCEL_DEPLOY_HOOK_URL` | GitHub Actions secret | `build-harness` may ping after artifact upload |

Agents: secrets are already configured for the maintainer deployment — do not nag unless a log proves a regression. See [`AGENTS.md`](../AGENTS.md).

Wasm race: [`harness-deploy-race.md`](harness-deploy-race.md).

## Build runner (abstract)

| Field | Public value |
|-------|----------------|
| GHA runner name | `invincible-do-1` |
| Labels | `self-hosted`, `invincible`, `zig` |
| Zig pin | **0.16.0** (`native/ZIG_VERSION`) |
| Workflows | `build-harness`, `build-wasm`, `build-dvui-spike`, `runner-smoke` |
| Host details | **Private** — not in this repo ([SECURITY.md](../SECURITY.md)) |

Ops abstract guide: [`runner.md`](runner.md).

## Git integration

Production branch: `main` → Vercel.
