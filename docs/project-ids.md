# Invincible — project IDs and URLs

- **Vercel project name:** invincible
- **Vercel team:** Bjorn's projects (`bjorns-projects-65588ed4`)
- **teamId:** `team_dS9oFKboGzOH94QwyQ4GMFj2`
- **projectId:** `prj_x8VWfNE5KiKXqqHNwm8IYPzokaS5`
- **Production:** https://invincible-dun-ten.vercel.app
- **Dashboard:** https://vercel.com/bjorns-projects-65588ed4/invincible
- **GitHub:** https://github.com/btipling/invincible (`main`)

## Env / secrets (already configured — agents: do not nag)

| Name | Where | Status |
|------|--------|--------|
| `AI_GATEWAY_API_KEY` | Vercel Production + Preview | **Configured** |
| `DEFAULT_MODEL` | Vercel (optional) | default `xai/grok-4.1-fast-non-reasoning` |
| `HARNESS_ARTIFACT_TOKEN` | Vercel Production + Preview | **Configured** — Actions: Read PAT for `harness-wasm` |
| `VERCEL_DEPLOY_HOOK_URL` | GitHub Actions secret | **Configured** — `build-harness` pings after artifact upload |

Agents: never prompt the user to “set up” or “wire” these unless a log proves a regression. See [`AGENTS.md`](../AGENTS.md).

Wasm race: [`docs/harness-deploy-race.md`](harness-deploy-race.md) (prebuild waits for commit-matched artifact).

## Git integration

Connected: `btipling/invincible` → production branch `main`.

## GitHub Project

- Board: https://github.com/users/btipling/projects/1/views/1

## Build runner (Phase 2)

| Field | Value |
|-------|--------|
| Droplet name | `ubuntu-s-2vcpu-4gb-120gb-intel-nyc1` |
| Region / size | `nyc1` / `s-2vcpu-4gb-120gb-intel` |
| Droplet ID | `589481218` |
| Public IPv4 | `204.48.30.46` |
| Ops doc | [`docs/runner.md`](runner.md) |
| Create script | [`scripts/create-invincible-droplet.sh`](../scripts/create-invincible-droplet.sh) |
| Bootstrap | [`scripts/bootstrap-runner-host.sh`](../scripts/bootstrap-runner-host.sh) |
| GHA runner | `invincible-do-1` · labels `invincible`,`zig` |
| Zig | `0.16.0` @ `/opt/zig/0.16.0` |
| Ops | **[`docs/runner.md`](runner.md)** (source of truth for rebuild) |
