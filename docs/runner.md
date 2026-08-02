# Invincible build runner — operator guide

**Purpose:** DigitalOcean runs **compile** (Zig → Wasm and later native toolchains).  
**Vercel** runs the **Next.js** app and AI Gateway only. Never expect Vercel to build Zig.

| Layer | Where | Role |
|-------|--------|------|
| UI + API | Vercel (`invincible`) | Prompt playground, deploy |
| CI build | DO droplet + GitHub Actions self-hosted | `zig` → `.wasm` artifacts |
| Source | GitHub `btipling/invincible` | Single source of truth |

Plan: [phase-2-plan.md](phase-2-plan.md) · Milestone: [Phase 2](https://github.com/btipling/invincible/milestone/2) · Board: [projects/1](https://github.com/users/btipling/projects/1/views/1)

---

## 1. Inventory (live)

| Field | Value |
|-------|--------|
| Droplet ID | `589481218` |
| Droplet name (host) | `ubuntu-s-2vcpu-4gb-120gb-intel-nyc1` |
| Public IPv4 | `204.48.30.46` |
| Private IPv4 | `10.116.0.2` (VPC) |
| Region | `nyc1` |
| Size | `s-2vcpu-4gb-120gb-intel` (~**$32/mo** — confirm on DO bill) |
| Image | Ubuntu **24.04** LTS x64 |
| Tags | `invincible` (optional: `gha-runner`) |
| OS user | `runner` (uid 1000, sudo) |
| GHA runner name | **`invincible-do-1`** |
| GHA labels | `self-hosted`, `Linux`/`X64` (platform), **`invincible`**, **`zig`** |
| Runner path | `/home/runner/actions-runner` |
| systemd unit | `actions.runner.btipling-invincible.invincible-do-1.service` |
| Runner version | `2.336.0` (as of 2026-08-02; auto-updates possible) |
| Zig pin | **0.16.0** (`native/ZIG_VERSION`) |
| Zig install | `/opt/zig/0.16.0` → `/usr/local/bin/zig` |
| IDs also in | [project-ids.md](project-ids.md) |

**Workflows target:**

```yaml
runs-on: [self-hosted, invincible, zig]
```

---

## 2. Secrets policy

| Secret | Where it may live | Never |
|--------|-------------------|--------|
| Vercel `AI_GATEWAY_API_KEY` | Vercel project env | git, droplet, Actions logs |
| GitHub PAT (script curl) | shell env on droplet only, short-lived | git, screenshots, issues |
| GHA **registration** / **remove** tokens | GitHub UI once, ~1h life | git, docs, chat long-term |
| DO API token | local `doctl` / password manager | git |
| Runner `.credentials` | `/home/runner/actions-runner/` only | copy into repo |

Fine-grained PAT for `gh_raw` scripts: **Contents: Read** on `invincible` only — see [scripts/README.md](../scripts/README.md).

---

## 3. Bootstrap (new droplet)

### 3.1 Create VM

- Spec: Ubuntu 24.04, **≥ 2 vCPU / 4 GB**, SSD, SSH keys attached, monitoring on.
- Tag `invincible`. Prefer a stable name like `invincible-runner`.
- Helpers: [`scripts/create-invincible-droplet.sh`](../scripts/create-invincible-droplet.sh) (needs **write** DO token; Grok connector is often read-only).

### 3.2 Host packages + `runner` user

```bash
# as root, or:  gh_raw scripts/bootstrap-runner-host.sh | sudo bash
# script: scripts/bootstrap-runner-host.sh
```

Creates user `runner`, baseline packages (`curl`, `git`, `build-essential`, `jq`, `unzip`, …), copies root `authorized_keys` to runner when present.

### 3.3 GitHub Actions runner

1. [New self-hosted runner](https://github.com/btipling/invincible/settings/actions/runners/new) (Linux x64).
2. As `runner`:

```bash
su - runner
mkdir -p ~/actions-runner && cd ~/actions-runner
# download + extract per GitHub UI, then:
./config.sh --url https://github.com/btipling/invincible --token <CONFIG_TOKEN> \
  --name invincible-do-1 \
  --labels self-hosted,linux,x64,invincible,zig \
  --work _work \
  --unattended
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

3. Confirm **Idle / Online** under Settings → Actions → Runners.

### 3.4 Zig (pinned)

```bash
export GH_TOKEN=...   # Contents: Read
gh_raw() {
  curl -fsSL \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github.raw" \
    "https://api.github.com/repos/btipling/invincible/contents/$1?ref=main"
}
gh_raw scripts/phase-2.3-zig.sh | bash
# expect: zig version 0.16.0  +  wasm OK
```

Split: `install-zig.sh` then `verify-zig-wasm.sh`.

### 3.5 Prove CI

```bash
gh workflow run runner-smoke.yml --repo btipling/invincible
gh workflow run build-wasm.yml --repo btipling/invincible
```

Update this inventory table with new droplet ID / IP after any rebuild.

---

## 4. Re-register runner (rebuild / token / rename)

Use when: machine reimaged, runner removed in UI, labels wrong, or `.credentials` lost.

1. **Stop service** (if still present):

```bash
cd /home/runner/actions-runner
sudo ./svc.sh stop
```

2. **Remove registration** (needs **remove token** from  
   Settings → Actions → Runners → this runner → Remove):

```bash
./config.sh remove --token <REMOVE_TOKEN>
# or interactive: ./config.sh remove
```

3. **New config token** from [New runner](https://github.com/btipling/invincible/settings/actions/runners/new) (not the remove token).

4. **Configure** with plan name/labels (section 3.3), then:

```bash
sudo ./svc.sh install   # if unit missing
sudo ./svc.sh start
```

5. Run `runner-smoke` once.

If the old systemd unit name lingers after rename:

```bash
sudo systemctl disable --now 'actions.runner.btipling-invincible.*.service'  # careful
# prefer: sudo ./svc.sh uninstall  from the actions-runner dir before re-install
```

---

## 5. Workflows

| Workflow | File | Triggers | Job |
|----------|------|----------|-----|
| **runner-smoke** | `.github/workflows/runner-smoke.yml` | `workflow_dispatch`, push to that file | Host + `zig 0.16.0` + GitHub HTTPS |
| **build-wasm** | `.github/workflows/build-wasm.yml` | `workflow_dispatch`, push to `native/**` or that file | `./native/build.sh` → artifact **`hello-wasm`** |

```bash
# dispatch
gh workflow run runner-smoke.yml --repo btipling/invincible
gh workflow run build-wasm.yml --repo btipling/invincible

# watch
gh run list --repo btipling/invincible --limit 5
gh run view <id> --repo btipling/invincible --log-failed
```

**Artifact:** Actions run → Artifacts → `hello-wasm` (14-day retention). Free GitHub accounts support this; storage is shared (~500 MB free tier) — our placeholder is tiny.

**Local build (on runner or any Zig 0.16.0 host):**

```bash
./native/build.sh   # → native/dist/hello.wasm
```

---

## 6. Day-2 operations

```bash
# service
cd /home/runner/actions-runner
sudo ./svc.sh status
sudo ./svc.sh stop
sudo ./svc.sh start

# journal
sudo journalctl -u actions.runner.btipling-invincible.invincible-do-1.service -n 100 --no-pager

# zig
zig version
ls -la /opt/zig/

# disk (caches grow)
df -h
du -sh /home/runner/actions-runner/_work /opt/zig 2>/dev/null || true
```

---

## 7. Failure playbook

| Symptom | Checks / fix |
|---------|----------------|
| Runner **Offline** | `sudo ./svc.sh status`; journalctl; reboot; re-register (section 4) |
| Job **queued forever** | Labels must include `invincible` + `zig`; runner Idle; only one job if concurrency 1 |
| `zig: not found` in CI | PATH; `/usr/local/bin/zig`; re-run `phase-2.3-zig.sh` |
| Zig version mismatch | `native/ZIG_VERSION` vs `zig version`; reinstall pin |
| Checkout / action download fails | Outbound HTTPS to GitHub; DNS; disk full |
| Disk full | `df -h`; clean `_work/_tool` and old run dirs; expand droplet |
| OOM during Zig link | Resize above 4 GB or reduce parallel jobs |
| Artifact upload fail | Free storage quota; retention; artifact name path exists |
| DO 403 from agents | Connector/token lacks write — use dashboard or write PAT for create only |
| `objects.githubusercontent.com` bare URL 404 | **Normal**; use full object URLs (runner does) |

---

## 8. Zig upgrade (controlled)

1. Bump `native/ZIG_VERSION` and SHA in `scripts/install-zig.sh` / `phase-2.3-zig.sh`.
2. On host: install new version under `/opt/zig/<ver>`, retarget symlink.
3. Update smoke workflow pin check if it hardcodes `0.16.0`.
4. Run `runner-smoke` + `build-wasm`.
5. Keep previous `/opt/zig/<old>` until green, then delete.

---

## 9. Cost & destroy

| Item | Estimate |
|------|----------|
| Droplet `s-2vcpu-4gb-120gb-intel` nyc1 | ~**$32/month** (check DO) |
| Bandwidth | Usually fine for CI |
| GitHub Actions minutes (self-hosted) | **$0** |
| Artifact storage | Free tier; purge old artifacts if needed |

**Destroy when Phase 2 paused:**

1. Remove runner in GitHub UI (or `config.sh remove`).
2. Destroy droplet in DO (or power off to stop compute charges — still may pay for disk/snapshots).
3. Clear inventory IPs from this doc / `project-ids.md`.
4. Optional: delete stale Actions artifacts.

---

## 10. Script index

| Script | Role |
|--------|------|
| [`scripts/bootstrap-runner-host.sh`](../scripts/bootstrap-runner-host.sh) | packages + `runner` user |
| [`scripts/create-invincible-droplet.sh`](../scripts/create-invincible-droplet.sh) | doctl create (write token) |
| [`scripts/install-zig.sh`](../scripts/install-zig.sh) | pin Zig to `/opt/zig` |
| [`scripts/verify-zig-wasm.sh`](../scripts/verify-zig-wasm.sh) | wasm magic check |
| [`scripts/phase-2.3-zig.sh`](../scripts/phase-2.3-zig.sh) | install + verify one-shot |
| [`scripts/harden-runner-host.sh`](../scripts/harden-runner-host.sh) | Phase 2.7 SSH/UFW/unattended-upgrades |
| [`native/build.sh`](../native/build.sh) | CI/local `hello.wasm` |
| [`scripts/README.md`](../scripts/README.md) | private-repo `gh_raw` curl recipes |

---

## 11. Related product surfaces

| Surface | URL / path |
|---------|------------|
| Production app | https://invincible-dun-ten.vercel.app |
| GitHub repo | https://github.com/btipling/invincible |
| Vercel project | see [project-ids.md](project-ids.md) |
| Self-hosted runners | https://github.com/btipling/invincible/settings/actions/runners |

**Out of scope for this doc:** Phase 3 dvui harness UI, AI Gateway keys (Vercel only), full host hardening (issue #14).

---

## 12. Hardening & cost (Phase 2.7)

**Status:** applied on droplet `589481218` (2026-08-02) — UFW SSH-only, key-only sshd, unattended-upgrades, restricted runner sudo; runner stayed active.

### Applied baseline (run on host)

```bash
gh_raw scripts/harden-runner-host.sh | sudo bash
# optional lock SSH to your IP:
# SSH_ALLOW_FROM='x.x.x.x/32' gh_raw scripts/harden-runner-host.sh | sudo bash
```

Script: [`scripts/harden-runner-host.sh`](../scripts/harden-runner-host.sh)

| Control | Behavior |
|---------|----------|
| SSH | `PasswordAuthentication no`, `PermitRootLogin prohibit-password`, no X11/TCP forwarding |
| UFW | default deny in; **only 22/tcp** (or from `SSH_ALLOW_FROM`); **no 80/443** |
| Updates | `unattended-upgrades` daily security |
| Runner | must not be root; sudo limited to apt + runner `svc.sh` / unit |
| Marker | `/var/lib/invincible/hardened-at` |

**Web console:** DO Recovery/web console still works if you lock yourself out of SSH.

**After harden:** confirm runner **Idle** in GitHub UI, then:

```bash
gh workflow run runner-smoke.yml --repo btipling/invincible
```

### DO console (recommended extras)

1. **Networking → Firewalls** (optional second layer): inbound TCP 22 only; attach to droplet `589481218`.
2. **Billing → Budgets & alerts**: e.g. alert at $40 if droplet is ~$32/mo.
3. Avoid unplanned **snapshots/volumes** unless noted here (none today).
4. **Monitoring** on for the droplet.

### Cost summary

| Item | Amount |
|------|--------|
| Droplet `s-2vcpu-4gb-120gb-intel` nyc1 | ~**$32/month** |
| Extra volumes / snapshots | **none** (do not add without updating this doc) |
| GitHub self-hosted minutes | $0 |
| Destroy | Section 9 above |

### Post-harden checklist

- [ ] `sudo ufw status` shows 22 only (or restricted source)
- [ ] `sshd -T \| grep -i passwordauthentication` → `no`
- [ ] `systemctl is-active actions.runner.btipling-invincible.invincible-do-1.service` → active
- [ ] Runner Online in GitHub
- [ ] `runner-smoke` green

