# Invincible build runner (Phase 2)

DO hosts **build** (Zig/Wasm). Vercel hosts the **Next.js** app only.

## Status (2026-08-02)

| Item | Status |
|------|--------|
| Droplet | **Not created yet** — Grok DO connector got **403** on `droplet create` (read scopes only) |
| Spec | Ready (below) |
| Bootstrap script | [`scripts/bootstrap-runner-host.sh`](../scripts/bootstrap-runner-host.sh) |
| Create helper | [`scripts/create-invincible-droplet.sh`](../scripts/create-invincible-droplet.sh) (needs write token) |

## Target inventory

| Field | Value |
|-------|--------|
| Name | `invincible-runner` |
| Region | `sfo3` (SF — close to owner) |
| Size | `s-2vcpu-4gb` (~$24/mo — confirm current pricing) |
| Image | `ubuntu-24-04-x64` |
| Tags | `invincible`, `gha-runner` |
| Monitoring | on |
| User | `runner` (sudo) |
| Droplet ID | _pending_ |
| Public IPv4 | _pending_ |
| Runner name | `invincible-do-1` (Phase 2.2) |
| Labels | `self-hosted,linux,x64,invincible,zig` (Phase 2.2) |
| Zig version | _pending Phase 2.3_ |

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
