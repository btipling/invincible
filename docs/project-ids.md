# Invincible — public project pointers

**Clone / BYO setup:** [`bring-your-own.md`](bring-your-own.md).  
The table below is the **maintainer reference deployment** only — not required for third-party success.

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
| `HARNESS_ARTIFACT_TOKEN` | Vercel | Actions: Read — prebuild downloads `harness-wasm` |
| `VERCEL_DEPLOY_HOOK_URL` | GitHub Actions secret | `build-harness` may ping after artifact upload |
| `SANDBOX_URL` | Vercel / local server | Agent sandbox base URL — **must be Vercel-reachable in prod**; never commit real hosts |
| `SANDBOX_TOKEN` | Vercel + sandbox process | Shared bearer; server-only |
| `AGENT_MAX_STEPS` | Vercel (optional) | Optional tool-loop safety ceiling (1…256); unset = model-ended |

Agents on **origin**: secrets listed as **Done** in [`AGENTS.md`](../AGENTS.md)
are already configured — do not nag unless a log proves a regression.  
`SANDBOX_*` is **not** Done until the operator sets it.  
Forks/clones: set env on **your** Vercel per [`bring-your-own.md`](bring-your-own.md)
and [`sandbox.md`](sandbox.md).

Wasm race: [`harness-deploy-race.md`](harness-deploy-race.md).  
Sandbox ops: [`sandbox.md`](sandbox.md) (no host inventory in this table).

## Build runner (abstract)

| Field | Public value |
|-------|----------------|
| GHA runner name | `invincible-do-1` |
| Labels | `self-hosted`, `invincible`, `zig` |
| Zig pin | **0.16.0** (`native/ZIG_VERSION`) |
| Workflows | `build-harness`, `build-wasm`, `build-dvui-spike`, `runner-smoke` |
| Host details | **Private** — not in this repo ([SECURITY.md](../SECURITY.md)) |

Ops abstract guide: [`runner.md`](runner.md).  
**Agent sandbox** is a separate service — not this GHA runner ([`sandbox.md`](sandbox.md)).

## Git integration

Production branch: `main` → Vercel.
