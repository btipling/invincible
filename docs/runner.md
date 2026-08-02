# Invincible build runner (Phase 2)

DO hosts **build** (Zig/Wasm). Vercel hosts the **Next.js** app only.

## Status (2026-08-02)

| Item | Status |
|------|--------|
| Droplet | **Active** — id `589481218`, IPv4 `204.48.30.46` (nyc1) |
| Spec | Ubuntu 24.04 · `s-2vcpu-4gb-120gb-intel` · tag `invincible` |
| Bootstrap | **Done** (2026-08-02) — user `runner` + baseline packages; github.com 200 |
| Create helper | [`scripts/create-invincible-droplet.sh`](../scripts/create-invincible-droplet.sh) (for rebuilds) |

## Target inventory

| Field | Value |
|-------|--------|
| Name | `ubuntu-s-2vcpu-4gb-120gb-intel-nyc1` (host) · runner `invincible-do-1` |
| Region | `nyc1` |
| Size | `s-2vcpu-4gb-120gb-intel` (~$32/mo) |
| Image | `ubuntu-24-04-x64` |
| Tags | `invincible` (add `gha-runner` anytime) |
| Monitoring | confirm in DO UI |
| User | `runner` (sudo, uid 1000) |
| Droplet ID | `589481218` |
| Public IPv4 | `204.48.30.46` |
| Runner name | `invincible-do-1` |
| Labels | `self-hosted`, `Linux`/`linux`, `X64`/`x64`, `invincible`, `zig` |
| Zig version | **0.16.0** (pinned) |

## Create options

### A) doctl with a write-capable token (preferred for agents)

1. DigitalOcean → API → generate personal access token with **write** (droplet create).
2. Locally or in an agent env that has the token:

```bash
export DIGITALOCEAN_ACCESS_TOKEN=dop_v1_...
./scripts/create-invincible-droplet.sh
ssh root@<IP> 'bash -s' < scripts/bootstrap-runner-host.sh
```

3. Fill **Droplet ID / IPv4** into this file and `docs/project-ids.md`.

### B) DO dashboard

1. Create Droplet → Ubuntu 24.04 × `s-2vcpu-4gb` × `sfo3`
2. Name `invincible-runner`, tags `invincible` + `gha-runner`, monitoring on
3. Attach your SSH key
4. SSH and run bootstrap:

```bash
ssh root@<IP> 'bash -s' < scripts/bootstrap-runner-host.sh
```

### C) Reconnect Grok DO connector with write scopes

Then re-run Phase 2.1 from chat so the agent can call `droplet-create` and complete bootstrap (SSH still needs your keys on the droplet).

## Bootstrap does

- `apt` update/upgrade  
- packages: curl, git, build-essential, ca-certificates, jq, unzip  
- user `runner` + passwordless sudo (tighten in 2.7)  
- copy root `authorized_keys` → runner  
- outbound check to GitHub  

## Out of scope here

- GitHub Actions runner binary → issue **#2**  
- Zig → **#10**  
- Hardening → **#14**  

## Plan

See [docs/phase-2-plan.md](phase-2-plan.md) and [milestone 2](https://github.com/btipling/invincible/milestone/2).

## Connectivity note

`curl -f https://objects.githubusercontent.com/` often returns **404** on the bare host URL; that still means TLS/DNS work. GitHub Actions runner downloads use full object paths and succeed when `github.com` is 200.

## Runner service (Phase 2.2)

| Field | Value |
|-------|--------|
| Status | **Online** — Listening for Jobs (2026-08-02) |
| Path | `/home/runner/actions-runner` |
| Unit | `actions.runner.btipling-invincible.invincible-do-1.service` |
| User | `runner` |
| Version | `2.336.0` |

```bash
# as runner
cd ~/actions-runner
sudo ./svc.sh status
sudo ./svc.sh stop   # / start
```

## Zig toolchain (Phase 2.3) — **done**

| Field | Value |
|-------|--------|
| Status | Verified on droplet 2026-08-02 (`wasm OK`, 157 bytes) |
| Version | **0.16.0** (pinned in `native/ZIG_VERSION`) |
| Install path | `/opt/zig/0.16.0` |
| Symlink | `/usr/local/bin/zig` |
| Tarball | `https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz` |
| Install script | [`scripts/install-zig.sh`](../scripts/install-zig.sh) |
| Verify | [`scripts/verify-zig-wasm.sh`](../scripts/verify-zig-wasm.sh) |
| Probe source | [`native/hello.zig`](../native/hello.zig) |

```bash
# Private repo — need a PAT with Contents: Read
export GH_TOKEN=github_pat_...   # or ghp_...

gh_raw() {
  curl -fsSL     -H "Authorization: Bearer ${GH_TOKEN}"     -H "Accept: application/vnd.github.raw"     "https://api.github.com/repos/btipling/invincible/contents/$1?ref=main"
}

# one-shot install + wasm verify
gh_raw scripts/phase-2.3-zig.sh | bash

# or split:
# gh_raw scripts/install-zig.sh | bash
# gh_raw scripts/verify-zig-wasm.sh | bash
```

See also [`scripts/README.md`](../scripts/README.md).

## Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `runner-smoke` | `.github/workflows/runner-smoke.yml` | Phase 2.4 — `workflow_dispatch` on `[self-hosted, invincible, zig]` |

```bash
gh workflow run runner-smoke.yml --repo btipling/invincible
gh run list --workflow=runner-smoke.yml --repo btipling/invincible --limit 3
```
