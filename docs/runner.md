# Invincible build runner — operator guide

**Purpose:** A self-hosted machine runs **compile** (Zig → Wasm).  
**Vercel** runs the **Next.js** app and AI Gateway only. Never expect Vercel to build Zig.

| Layer | Where | Role |
|-------|--------|------|
| UI + API | Vercel project `invincible` | `/harness` host, `/api/chat` |
| CI build | Self-hosted GHA runner | `zig` → `.wasm` artifacts |
| Source | GitHub `btipling/invincible` | Single source of truth |

Product handoff: [phase-4-handoff.md](phase-4-handoff.md) · Public safety: [SECURITY.md](../SECURITY.md)

---

## 1. Public inventory (safe to publish)

| Field | Value |
|-------|--------|
| GHA runner name | **`invincible-do-1`** |
| Labels (required) | **`self-hosted`**, **`invincible`**, **`zig`** |
| Zig pin | **0.16.0** (`native/ZIG_VERSION`) |
| Typical install path | `/opt/zig/0.16.0` → `/usr/local/bin/zig` |
| OS (recommended) | Ubuntu 24.04 LTS x64, ≥ 2 vCPU / 4 GB RAM |
| Runner OS user | `runner` |
| Runner path (typical) | `/home/runner/actions-runner` |

**Host IP, droplet ID, VPC addresses, and cloud account IDs are private.** Keep them in your password manager / private notes — not in this repository.

**Workflows target:**

```yaml
runs-on: [self-hosted, invincible, zig]
```

### Public-repo rules (mandatory)

Self-hosted runners on **public** repos are high risk if untrusted PR code can execute on them.

| Rule | Implementation |
|------|----------------|
| No `pull_request` / `pull_request_target` on self-hosted jobs | All four workflows: push `main` + `workflow_dispatch` only |
| Repository + ref guard | Job `if:` requires `github.repository == 'btipling/invincible'` and not a PR event |
| Path filters | Only relevant `native/**` / workflow paths on push |
| Fork PRs | Do not add self-hosted PR builds without a security design review |

See [SECURITY.md](../SECURITY.md).

---

## 2. Secrets policy

| Secret | Where it may live | Never |
|--------|-------------------|--------|
| Vercel `AI_GATEWAY_API_KEY` | Vercel project env | git, runner host, Actions logs, client, Wasm |
| Vercel `HARNESS_ARTIFACT_TOKEN` | Vercel project env (Actions: Read PAT) | git, client |
| GitHub `VERCEL_DEPLOY_HOOK_URL` | Actions secret | git |
| GHA **registration** / **remove** tokens | GitHub UI once, ~1h life | git, docs, chat |
| DO API token | local `doctl` / password manager | git |
| Runner `.credentials` | runner host only | copy into repo |

Gateway key is **never** on the build host and **never** inside Wasm or session blobs.

---

## 3. Bootstrap (new host — abstract)

### 3.1 Create VM

- Spec: Ubuntu 24.04, **≥ 2 vCPU / 4 GB**, SSD, SSH keys, monitoring.
- Tag e.g. `invincible`. Name is operator choice (private).
- Helper scripts under `scripts/` need a DO write token on your laptop (not in CI).

### 3.2 Host packages + `runner` user

```bash
# on the host as root — clone repo or curl raw script if public:
#   bash scripts/bootstrap-runner-host.sh
```

Creates user `runner`, baseline packages, copies root `authorized_keys` when present.

### 3.3 GitHub Actions runner

1. Repo → Settings → Actions → Runners → New (Linux x64).
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
```

3. Confirm **Idle / Online**.

### 3.4 Zig (pinned)

On the runner host:

```bash
# from a clone of this repo:
./scripts/phase-2.3-zig.sh
# expect: zig version 0.16.0 + wasm OK
```

### 3.5 Prove CI

```bash
gh workflow run runner-smoke.yml --repo btipling/invincible
gh workflow run build-harness.yml --repo btipling/invincible
```

---

## 4. Re-register runner

When reimaged, labels wrong, or `.credentials` lost: stop service → `config.sh remove` → new config token → reinstall labels as in §3.3 → `runner-smoke`.

---

## 5. Workflows

| Workflow | Triggers | Artifact |
|----------|----------|----------|
| **runner-smoke** | `workflow_dispatch`, push to workflow file on `main` | — |
| **build-wasm** | `workflow_dispatch`, push `native/**` on `main` | `hello-wasm` |
| **build-dvui-spike** | `workflow_dispatch`, push spike paths on `main` | `dvui-spike-wasm` |
| **build-harness** | `workflow_dispatch`, push `native/harness/**` on `main` | **`harness-wasm`** |

All jobs: self-hosted + `if:` guards (no PR).

### Product path: harness → Vercel

```text
push native/harness/** on main
  → build-harness (self-hosted)
  → artifact harness-wasm
  → optional VERCEL_DEPLOY_HOOK_URL
  → Vercel prebuild: scripts/fetch-harness-artifact.mjs
  → CDN /harness/*
```

| Piece | Detail |
|-------|--------|
| Labels | `[self-hosted, invincible, zig]` |
| Zig | `native/ZIG_VERSION` (0.16.0) |
| Build | `./native/harness/build.sh` |
| Race | [harness-deploy-race.md](harness-deploy-race.md) |
| Product handoff | [phase-4-handoff.md](phase-4-handoff.md) |

```bash
gh workflow run build-harness.yml --repo btipling/invincible
export HARNESS_ARTIFACT_TOKEN=…   # local
npm run fetch-harness && npm run dev
```

**Do not** commit `public/harness/*.wasm` / `web.js`.

---

## 6. Day-2 ops

| Task | Note |
|------|------|
| Online? | GitHub → Settings → Actions → Runners |
| Disk | Zig caches grow — monitor privately |
| Smoke | `gh workflow run runner-smoke.yml` |
| Harness | `gh workflow run build-harness.yml` then check prod `/harness` |

---

## 7. Related

| Doc | Topic |
|-----|--------|
| [SECURITY.md](../SECURITY.md) | Public repo + runner policy |
| [phase-4-handoff.md](phase-4-handoff.md) | Product operator path |
| [project-ids.md](project-ids.md) | Public URLs only |
| [native/harness/README.md](../native/harness/README.md) | Bridge / exports |
