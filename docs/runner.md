# Invincible build runner — operator guide

**Purpose:** DigitalOcean runs **compile** (Zig → Wasm and later native toolchains).  
**Vercel** runs the **Next.js** app and AI Gateway only. Never expect Vercel to build Zig.

| Layer | Where | Role |
|-------|--------|------|
| UI + API | Vercel (`invincible`) | Playground, `/harness` host, `/api/chat` |
| CI build | DO droplet + GitHub Actions self-hosted | `zig` → `.wasm` artifacts |
| Source | GitHub `btipling/invincible` | Single source of truth |

Phase 3 handoff: [phase-3-handoff.md](phase-3-handoff.md) · Plan: [phase-3-plan.md](phase-3-plan.md) · Board: [projects/1](https://github.com/users/btipling/projects/1/views/1)

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
| Vercel `AI_GATEWAY_API_KEY` | Vercel project env | git, droplet, Actions logs, client, Wasm |
| Vercel `HARNESS_ARTIFACT_TOKEN` | Vercel project env (Actions: Read PAT) | git, client |
| GitHub `VERCEL_DEPLOY_HOOK_URL` | Actions secret (already configured) | git; do not nag operators to re-add |
| GitHub PAT (script curl) | shell env on droplet only, short-lived | git, screenshots, issues |
| GHA **registration** / **remove** tokens | GitHub UI once, ~1h life | git, docs, chat long-term |
| DO API token | local `doctl` / password manager | git |
| Runner `.credentials` | `/home/runner/actions-runner/` only | copy into repo |

Fine-grained PAT for `gh_raw` scripts: **Contents: Read** on `invincible` only — see [scripts/README.md](../scripts/README.md).

Gateway key is **never** on the droplet and **never** inside Wasm or session blobs.

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
gh workflow run build-harness.yml --repo btipling/invincible
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

| Workflow | File | Triggers | Artifact |
|----------|------|----------|----------|
| **runner-smoke** | `.github/workflows/runner-smoke.yml` | `workflow_dispatch`, push to that file | (none — health) |
| **build-wasm** | `.github/workflows/build-wasm.yml` | `workflow_dispatch`, push `native/**` | **`hello-wasm`** (Phase 2 probe) |
| **build-dvui-spike** | `.github/workflows/build-dvui-spike.yml` | `workflow_dispatch`, push `native/dvui-spike/**` | **`dvui-spike-wasm`** (research) |
| **build-harness** | `.github/workflows/build-harness.yml` | `workflow_dispatch`, push `native/harness/**` | **`harness-wasm`** (**product**) |

### Product path: harness → Vercel

```text
push native/harness/** 
  → build-harness on invincible-do-1
  → upload-artifact name=harness-wasm  (harness.wasm + web.js + index.html)
  → optional: POST VERCEL_DEPLOY_HOOK_URL
  → Vercel npm run prebuild → scripts/fetch-harness-artifact.mjs
       waits for this commit’s build-harness when racing Git deploy
  → public/harness/* on CDN as /harness/*
```

| Piece | Detail |
|-------|--------|
| Labels | `[self-hosted, invincible, zig]` |
| Zig | must match `native/ZIG_VERSION` (0.16.0) |
| Build script | `./native/harness/build.sh` → `native/dist/harness/` |
| Artifact | **`harness-wasm`**, retention 14 days |
| Vercel auth | env **`HARNESS_ARTIFACT_TOKEN`** (Actions: Read) |
| Race doc | [harness-deploy-race.md](harness-deploy-race.md) |
| Full handoff | [phase-3-handoff.md](phase-3-handoff.md) |

```bash
gh workflow run build-harness.yml --repo btipling/invincible
gh run list --workflow=build-harness.yml --repo btipling/invincible --limit 5
gh run view <id> --repo btipling/invincible --log-failed
```

**Local build (on runner or any Zig 0.16.0 host):**

```bash
cd /path/to/invincible
test "$(zig version)" = "$(tr -d '[:space:]' < native/ZIG_VERSION)"
./native/harness/build.sh
ls -la native/dist/harness/
```

**Local Next after fetching artifact:**

```bash
export HARNESS_ARTIFACT_TOKEN=…   # or GH_TOKEN from gh auth
npm run fetch-harness
npm run dev
```

**Do not** commit `public/harness/*.wasm` / `web.js`.

---

## 6. Day-2 ops

| Task | Command / note |
|------|----------------|
| Runner online? | GitHub → Settings → Actions → Runners |
| Disk | `df -h` on droplet — Zig + caches grow |
| Zig upgrade | bump `native/ZIG_VERSION`, re-run install script, fix build if API broke |
| Smoke | `gh workflow run runner-smoke.yml` |
| Harness | `gh workflow run build-harness.yml` then check `/harness` on prod |

---

## 7. Related docs

| Doc | Topic |
|-----|--------|
| [phase-3-handoff.md](phase-3-handoff.md) | Fresh-session rebuild + secrets |
| [phase-3-plan.md](phase-3-plan.md) | Issue map (complete) |
| [harness-limits.md](harness-limits.md) | Browser / product limits |
| [session-model.md](session-model.md) | SessionStore |
| [project-ids.md](project-ids.md) | Vercel / DO IDs |
| [native/harness/README.md](../native/harness/README.md) | Exports + bridge protocol |
