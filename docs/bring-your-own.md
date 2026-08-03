# Bring your own Vercel + keys

End-to-end guide for **third-party operators**: clone this repository, attach
**your** Vercel project and AI Gateway key, supply harness Wasm, and run the
product without depending on the maintainer production URL.

This is **not** multi-tenant SaaS. You own the GitHub repo (clone/fork), the
Vercel project, the secrets, and (optionally) the self-hosted runner.

**Maintainer sample deployment** (demos only): see [project-ids.md](project-ids.md)
and the **Reference deployment** section in the [README](../README.md). Success
for BYO does **not** require `invincible-dun-ten.vercel.app`.

Related: [feature-divide.md](feature-divide.md) · [sandbox.md](sandbox.md) ·
[SECURITY.md](../SECURITY.md) · [runner.md](runner.md) ·
[harness-deploy-race.md](harness-deploy-race.md) · [AGENTS.md](../AGENTS.md)

---

## 1. What you get

| Piece | Role |
|-------|------|
| **Wasm harness** | Primary product UI — transcript, composer, Send / PONG, busy/error chrome |
| **Next.js host** | Shell only — nav, load module, bridge glue, SessionStore, thin status chips |
| **`POST /api/chat`** | Server-side single-shot inference via **your** Vercel AI Gateway key |
| **`POST /api/agent`** | Optional multi-step tools when you configure a **sandbox** ([sandbox.md](sandbox.md)) |

- Secrets stay on the **server** (Vercel env). Never put `AI_GATEWAY_API_KEY` or
  `SANDBOX_TOKEN` in client code, Wasm, or the browser.
- Do **not** build a competing React chat panel — canvas is the workspace.
- **Sandbox MVP is shipped** as a config seam (`SANDBOX_URL` + `SANDBOX_TOKEN`).
  Without it, harness falls back to chat. Full guide: [sandbox.md](sandbox.md).
- **MCP** / multi-tenant control plane are still future — see
  [§8 Future](#8-future-not-shipped).

---

## 2. Prerequisites

| Need | Notes |
|------|--------|
| **Node.js 18+** | Next.js 15 app |
| **GitHub** | Your clone or fork of this repo |
| **Vercel account** | New project linked to **your** repo (any project name) |
| **AI Gateway key** | Create via [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) |
| **Optional** | Self-hosted runner with Zig **0.16.0** if you will rebuild `native/harness` |

---

## 3. Quick path (local app + keys)

```bash
git clone <your-fork-or-clone-url>
cd invincible
npm install
cp .env.example .env.local
# edit .env.local — set AI_GATEWAY_API_KEY=…
```

### Harness files (`public/harness/`)

Binaries are **gitignored**. Pick one:

| Approach | How |
|----------|-----|
| Fetch artifact | `HARNESS_ARTIFACT_TOKEN=<PAT with Actions:Read> npm run fetch-harness` |
| Skip network | `HARNESS_SKIP_FETCH=1` if you already have valid files under `public/harness/` |
| Local Zig | Build on a machine with Zig 0.16.0 per [native/harness/README.md](../native/harness/README.md), then sync into `public/harness/` |

```bash
npm run dev
# open http://localhost:3000/harness
```

Optional overrides (see `.env.example`): `HARNESS_OWNER`, `HARNESS_REPO`,
`DEFAULT_MODEL`, wait/poll knobs for deploy races.

**Local resolution note:** when not in “require” mode, owner/repo can fall back
to `btipling/invincible` if no git env is set. Prefer explicit `HARNESS_*` or a
normal Vercel Git deploy so fetches hit **your** artifacts. Resolution order is
documented in `scripts/harnessRepo.mjs`.

---

## 4. Deploy on your Vercel

1. Import **your** GitHub repository into Vercel → create a **new** project
   (name is yours; it does not need to match the maintainer’s).
2. **Choose a Wasm supply path before first prod deploy** (see [§5](#5-wasm-supply-paths)).
   A fresh fork/clone has **no** `harness-wasm` Actions artifact until **you** publish
   one (path **A**) or you point fetch at a repo that already publishes it (path **B**).
   Without that, Vercel prebuild resolves owner/repo to **your** connected git repo,
   finds nothing, and the deploy fails or ships an empty harness.
3. Set **Environment Variables** (Production + Preview as needed):

| Name | Required | Purpose |
|------|----------|---------|
| `AI_GATEWAY_API_KEY` | **Yes** | Server-side inference — never client/Wasm |
| `HARNESS_ARTIFACT_TOKEN` | **Yes** for prod builds that download Wasm | Fine-grained PAT: **Actions: Read** on the repo that publishes artifact `harness-wasm` (your repo for path **A**, or the upstream/build repo for path **B**) |
| `HARNESS_OWNER` / `HARNESS_REPO` | **Yes until your repo publishes `harness-wasm`** | Point at a repo that already has artifact `harness-wasm` (typical cold-start: path **B**). Once path **A** has uploaded artifacts on **your** repo, omit these so Vercel Git env (`VERCEL_GIT_REPO_OWNER` / `VERCEL_GIT_REPO_SLUG`) is used |
| `DEFAULT_MODEL` | No | Defaults to gateway model id in code / `.env.example` |
| `SANDBOX_URL` / `SANDBOX_TOKEN` | No (tools off without both) | Agent sandbox base URL + bearer — **server only**; URL must be **reachable from Vercel** in prod ([sandbox.md](sandbox.md)) |
| `AGENT_MAX_STEPS` / `AGENT_MODEL` | No | Tool-loop step cap / optional tool-capable model override |

4. Optional GitHub Actions **secret** (on **your** repo): `VERCEL_DEPLOY_HOOK_URL` —
   only if you use `build-harness`’s post-artifact deploy-hook ping. Not required
   for a first deploy once prebuild can fetch a real artifact (Git integration
   redeploy alone does **not** create Wasm).
5. Deploy. Open **`https://<your-vercel-host>/harness`**.

On Vercel Git deploys, artifact owner/repo resolve to the **connected** Git repo
unless you set `HARNESS_*`. Runtime does **not** depend on the maintainer prod
**host** URL — but cold-start forks **do** need an explicit artifact **source**
(path **B** or a completed path **A**) before prebuild succeeds.

Race-safe wait for the matching `harness-wasm` artifact:
[harness-deploy-race.md](harness-deploy-race.md).

---

## 5. Wasm supply paths

| Path | When | What to do |
|------|------|------------|
| **A — Own runner** | You edit `native/harness` and want CI builds | Register a self-hosted runner on **your** repo → set Actions **variable** `SELF_HOSTED_BUILDS=true` → optional `RUNNER_LABELS` JSON array (default `["self-hosted","invincible","zig"]`) → follow [runner.md](runner.md) · [SECURITY.md](../SECURITY.md) |
| **B — Other repo’s artifacts** | **Typical first deploy** (fork has no artifact yet) or you always consume upstream/build-repo Wasm | Set `HARNESS_OWNER` / `HARNESS_REPO` + token with Actions:Read on **that** repo (e.g. origin `btipling` / `invincible` while you have no runner) |
| **C — Local / skip (non-prod)** | Dev without CI | Zig 0.16.0 local build, or `HARNESS_SKIP_FETCH=1` with existing files — **not** recommended as sole prod strategy |

**Origin (`btipling/invincible`) note:** workflows also allow a **grandfather**
path (`github.repository == 'btipling/invincible'`) so maintainer CI stays
eligible if the Actions variable is unset. **Clones and forks must set**
`SELF_HOSTED_BUILDS=true` after attaching **their** runner; without it, jobs
**skip** (safe default).

**Never** add `pull_request` / `pull_request_target` triggers to self-hosted
workflows. Jobs run only on `workflow_dispatch` or `push` to `main`.

---

## 6. Security

| Rule | Detail |
|------|--------|
| Secrets server-side | `AI_GATEWAY_API_KEY`, `SANDBOX_TOKEN` only on Vercel (or local `.env.local`); never in Wasm or client bundles |
| Variables ≠ secrets | `SELF_HOSTED_BUILDS` / `RUNNER_LABELS` are Actions **variables** (non-secret) |
| Public-repo runners | No PR execution on self-hosted; see [SECURITY.md](../SECURITY.md) |
| Agent sandbox ≠ Zig runner | Separate process/user; see [sandbox.md](sandbox.md) · [runner.md](runner.md) |
| No host inventory in git | IPs, droplet IDs, cloud account GUIDs stay offline |

---

## 7. Verify (any host)

Use **your** deploy URL (local or Vercel). Do not require the maintainer prod host.

1. Open `/harness` — after load, the **canvas** is the workspace (not a React chat card).  
2. Type in the canvas composer → **Enter** or **Send**.  
3. **PONG** smokes the host Gateway path (reply appears in canvas).  
4. Refresh restores session into Wasm; nav **Clear** resets.  
5. DOM chrome = nav + status chips only (host shell).  
6. ~390px width remains usable.  
7. **Optional agent tools:** with `SANDBOX_*` set, try a write/exec prompt; without them, PONG/chat still works ([sandbox.md](sandbox.md)).

Feature divide: [feature-divide.md](feature-divide.md). Product-oriented handoff
(maintainer URLs as samples): [phase-4-handoff.md](phase-4-handoff.md).

If the canvas stays blank: check Vercel build logs for harness fetch failures
(token, artifact missing, wrong owner/repo). Prefer fail-loud over shipping an
empty `public/harness`.

---

## 8. Future (not shipped)

| Capability | Status |
|------------|--------|
| Pluggable **sandbox** for agent build/run tools | **Shipped (MVP)** — config seam; see [sandbox.md](sandbox.md) |
| Multi-tenant sandbox isolation / fleet | **Not shipped** — single workspace root per process for now |
| **MCP** / multi-tenant control plane | **Not shipped** — separate epic; do not half-build here |

This guide covers **BYO Vercel + keys + runner/Wasm supply + optional sandbox**.
Target projects can be any language or platform; Invincible is the harness
workspace, not a locked stack for the work you operate on.

---

## 9. Reference deployment (maintainer sample)

| | |
|--|--|
| **GitHub** | `btipling/invincible` |
| **Production** | https://invincible-dun-ten.vercel.app |
| **Harness** | https://invincible-dun-ten.vercel.app/harness |
| **IDs** | [project-ids.md](project-ids.md) |

Agents working **on that origin** should not re-prompt for secrets already
listed as Done in [AGENTS.md](../AGENTS.md). Operators on **forks/clones** use
**this** document instead.

---

## Checklist

- [ ] Cloned **your** repo; Node 18+; `npm install`
- [ ] `.env.local` / Vercel: `AI_GATEWAY_API_KEY` set (server only)
- [ ] Harness path chosen (A / B / C); cold-start forks set `HARNESS_OWNER`/`HARNESS_REPO` (B) or publish path A first; Vercel has `HARNESS_ARTIFACT_TOKEN` with Actions:Read on the **artifact** repo
- [ ] Deployed **your** Vercel project; opened **your** `/harness`
- [ ] PONG + multi-turn + refresh + Clear work in canvas
- [ ] If using self-hosted builds: runner online + `SELF_HOSTED_BUILDS=true`
- [ ] Optional: sandbox daemon + Vercel/local `SANDBOX_URL`/`SANDBOX_TOKEN` ([sandbox.md](sandbox.md))
- [ ] No keys in client/Wasm; no PR triggers on self-hosted workflows
