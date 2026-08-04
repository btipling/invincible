# AGENTS.md — Invincible

Guidance for AI agents (and humans) working on this repository.

## Project

**Invincible** is a cloud prompt playground / agent harness.

- **Source:** https://github.com/btipling/invincible
- **Prod:** https://invincible-dun-ten.vercel.app
- **Phase 1–2:** Next.js playground, AI Gateway, DO runner `invincible-do-1` (Zig 0.16.0)
- **Phase 3:** Pipeline PoC — bridge + DOM chat + optional Wasm companion (done)
- **Phase 4 (done):** Wasm-**primary** harness MVP — [`docs/phase-4-handoff.md`](docs/phase-4-handoff.md) · epic #27
- **Deploy:** Vercel (Git-linked) + Actions artifact `harness-wasm`
- **GitHub account:** owner **`btipling`** (not display name “Bjorn”)

## Reusable product (not a one-off)

Invincible is **meant to be reusable**, not a private single-purpose app.

**North star:** anyone can **connect this repository** to **their own Vercel
project** and **their own sandbox / runner**, then run the harness for **their**
work — **independent of the language or platform** of the target project, and
**without needing a personal laptop or desktop** to operate the product.

| Today | Intent |
|-------|--------|
| Single public deploy + this author’s infra are documented for operators | Multi-operator / bring-your-own Vercel + keys |
| Sandbox MVP **shipped** via `SANDBOX_URL` + `SANDBOX_TOKEN` ([docs/sandbox.md](docs/sandbox.md)) | Pluggable sandbox without rewriting the harness |
| Stack is Next + Zig/dvui Wasm + AI Gateway | Target projects can be **any** stack; the harness is the workspace |
| Tenancy code + origin Production cutover **Done** (login + DB grants) | Optional login/grants **and** cloud-native bootstrap (no personal machine) |


**Third-party / fork deploy:** follow
[`docs/bring-your-own.md`](docs/bring-your-own.md) (Vercel + keys + Wasm supply)
and optionally [`docs/sandbox.md`](docs/sandbox.md). Do not assume origin
secrets, runner, sandbox URL, or prod URL exist on a fork.

### Operator & agent model (no personal hardware)

Invincible is a **cloud product**. Humans operate it through **hosted UI**
(Vercel dashboard, browser) and **cloud agents** (e.g. Grok Build sessions that
check out the repo and run `gh` / `npm` in a **remote workspace**). CI and the
self-hosted **runner** are also cloud.

| Do | Do not |
|----|--------|
| Assume the “shell” is a **cloud agent workspace** or **GitHub Actions** job | Assume the human has a laptop clone of the repo |
| Tell operators to set secrets in **Vercel** / GitHub / managed Postgres UI | Tell them to `cd ~/…`, install Node on their machine, or “run locally” |
| Run `npm test` / migrate / seed **in the agent workspace or GHA** when needed | Treat “local” as the human’s personal computer |
| Prefer **cloud-native cutover** paths (Actions, agent-run scripts, hosted DB) | Document laptop-only ops as the primary path |

“Local” in this file means **the agent’s or CI’s checkout**, not a developer’s
home directory. Product copy and plans must not require personal hardware.

**Agent rules:**

- Prefer designs and plans that keep **config seams** (env, project IDs, runner
  labels) rather than hardcoding one owner’s prod URL or cloud account.
- Do **not** treat “works only on invincible-dun-ten.vercel.app” as architecture.
- When a change **blocks** reusability **or forces personal-hardware ops**, call
  it out in the plan/PR and prefer a cloud-agent / CI / Vercel path.
- Config seams for BYO Vercel/keys/runner (#38), **sandbox MVP** (#45),
  **optional multi-tenant auth** (#54 phases 1–5 + cloud cutover #67), and
  GHA `db-tenancy-bootstrap` + [docs/bring-your-own.md](docs/bring-your-own.md) §4a
  are **landed** on origin Production (unauth API 401 + login verified).
  **SSO/SCIM** code ([#64](https://github.com/btipling/invincible/issues/64)
  phases 1–3) is on `main`; **origin** OIDC/SCIM env remains **Not Done** until
  an operator configures + smokes (see infra table). Still write docs/config as
  reusable BYO seams — not a single-owner IdP hardcoding.
- Origin `SANDBOX_*` is **Done** for the reference deploy (private host inventory
  stays offline). Still never invent a host URL; forks set their own env.
- Origin **tenancy** (`DATABASE_URL` / `AUTH_SECRET` / `CREDENTIALS_ENCRYPTION_KEY`)
  is **Done** on Production (cutover smoke: unauth API 401 + login). Do **not**
  instruct humans to clone the repo on a laptop to re-seed; use a cloud agent
  workspace, GitHub Actions `db-tenancy-bootstrap`, or
  [docs/bring-your-own.md](docs/bring-your-own.md) §4a.


## Project agent skills

Load from **this repo** via `gh` (not generic template skills). Zero-search:

| Skill | Path on `main` | Use when |
|-------|----------------|----------|
| **create-plan** | `.grok/skills/create-plan/SKILL.md` | “use create-plan”, feature plans as **GitHub issues**, parent + phase issues |
| **plan-review** | `.grok/skills/plan-review/SKILL.md` (+ `LOAD.md`, `references/*`) | Review a plan **issue**; default edit issue body via `gh` |
| **adversarial-review** | `.grok/skills/adversarial-review/SKILL.md` (+ `LOAD.md`, `references/*`) | Hostile **PR** review; break scenarios; post comment via `gh` |

Index: [`.grok/skills/README.md`](.grok/skills/README.md).

**Plan storage:** implementation plans are **GitHub issues** (see create-plan),
not a required `docs/*-plan.md`. Historical phase docs under `docs/` remain
valid handoffs.

```bash
command -v gh >/dev/null && gh auth status   # refuse GitHub work if this fails
# never GitHub MCP for plan create/review or adversarial PR review
```

## Hard constraint: git commit author = `btipling`

| Field | Required value |
|-------|----------------|
| `user.name` | `btipling` |
| `user.email` | `btipling@users.noreply.github.com` |

```bash
git config user.name "btipling"
git config user.email "btipling@users.noreply.github.com"
```

## Hard constraint: GitHub via `gh` + `git` (agent / CI workspace)

Prefer `gh` + `git` for all GitHub read/write. One commit per unit of work; one
push. Run these in the **cloud agent workspace** or CI — not on a human’s
personal machine.

```bash
command -v gh >/dev/null || exit 1
gh auth status || exit 1
```

## Infrastructure already configured (origin maintainer only)

**Scope: origin `btipling/invincible` only.** Do **not** assume these exist on
forks. Third-party operators set **their** Vercel/env/runner (via hosted UI + cloud agents) per
[`docs/bring-your-own.md`](docs/bring-your-own.md).

On origin, rows marked **Done** are **already set up**. Never ask the origin
maintainer to create, wire, or “remember to set” those unless a build log
**proves** they are missing/broken. Never invent a sandbox host URL (private
ops inventory).

| Item | Status | Notes |
|------|--------|--------|
| Vercel project + Git `main` | **Done** | prod URL above |
| `AI_GATEWAY_API_KEY` (Vercel) | **Done** | server-side only |
| `HARNESS_ARTIFACT_TOKEN` (Vercel) | **Done** | PAT Actions: Read — prebuild downloads `harness-wasm` |
| `VERCEL_DEPLOY_HOOK_URL` (GitHub secret) | **Done** | deploy hooks; `build-harness` pings after artifact upload |
| DO runner `invincible-do-1` labels `invincible`,`zig` | **Done** | Zig 0.16.0 only there |
| `SANDBOX_URL` / `SANDBOX_TOKEN` (Vercel) | **Done** | Agent sandbox on origin Production — see [docs/sandbox.md](docs/sandbox.md); host inventory private; never invent a host URL |
| `DATABASE_URL` (Vercel) | **Done** | Pooled Postgres (Neon) for optional tenancy — Production cutover smoke passed (unauth 401 + login); no host inventory in git |
| `AUTH_SECRET` (Vercel) | **Done** | Auth.js signing secret — Production cutover smoke passed |
| `CREDENTIALS_ENCRYPTION_KEY` (Vercel) | **Done** | AES-GCM KEK for sandbox tokens at rest — dual-store with GHA; never reuse casually on public Preview |
| Optional OIDC (`AUTH_OIDC_ISSUER` / `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` / `AUTH_OIDC_LABEL?`) | **Not Done** | Generic SSO — configure when operator wants IdP login; callback `{origin}/api/auth/callback/oidc`; BYO: [docs/bring-your-own.md](docs/bring-your-own.md) §4b |
| Optional SCIM (`SCIM_BEARER_TOKEN`) | **Not Done** | SCIM 2.0 Users at `/api/scim/v2` — set only when directory provisioning is intended; fail-closed 404 when unset |


**Agent behavior (origin):**

- Do **not** prompt “set `VERCEL_DEPLOY_HOOK_URL`” / “wire the deploy hook” / “optional secret if not already”.
- If workflow log says hook skipped (`not set`), treat as a real regression and investigate — still prefer fixing CI/docs over lecturing the user.
- Race fix lives in `scripts/fetch-harness-artifact.mjs` (wait for commit-matched artifact). See `docs/harness-deploy-race.md`.
- `SANDBOX_*` is **Done** on origin Production. If harness shows exact 503 not-configured or tools vanish, treat as regression (env/redeploy/reachability) — still no invented hosts ([docs/sandbox.md](docs/sandbox.md)).
- Tenancy triple env is **Done** on origin Production. Do **not** nag the origin
  maintainer to “set `DATABASE_URL`” as if forgotten. If unauth `/api/agent`
  no longer returns 401 or login fails, treat as **regression** (env/redeploy),
  not a greenfield cutover. Prefer cloud cutover docs
  ([docs/bring-your-own.md](docs/bring-your-own.md) §4a) and GHA
  `db-tenancy-bootstrap` for re-seed (resets bootstrap password + token
  ciphertext by design). Public smoke: `npm run smoke:tenancy`.
- Optional **OIDC / SCIM** on origin are **Not Done** until an operator sets env
  and smokes. Do **not** claim they are configured, invent IdP URLs, or nag to
  “enable SSO” as a forgotten secret. When configuring: follow
  [docs/bring-your-own.md](docs/bring-your-own.md) §4b; never put
  `AUTH_OIDC_CLIENT_SECRET` or `SCIM_BEARER_TOKEN` in client/Wasm or git.


IDs and URLs (maintainer sample): [`docs/project-ids.md`](docs/project-ids.md).  
BYO: [`docs/bring-your-own.md`](docs/bring-your-own.md). Sandbox: [`docs/sandbox.md`](docs/sandbox.md).  
Runner ops: [`docs/runner.md`](docs/runner.md). Security: [`SECURITY.md`](SECURITY.md).

## Public repository policy

- Do **not** commit host IPs, droplet IDs, or cloud account GUIDs.
- Self-hosted workflows: **no** `pull_request` / `pull_request_target` triggers; jobs run only on `workflow_dispatch` or `push` to `main`.
- Job `if:` opt-in: `vars.SELF_HOSTED_BUILDS == 'true'` **or** origin grandfather `github.repository == 'btipling/invincible'`. Clones must set the Actions **variable** (not secret) after attaching their own runner; foreign repos without the var **skip**.
- Optional `vars.RUNNER_LABELS` JSON array for `runs-on` (default `["self-hosted","invincible","zig"]`). See `SECURITY.md` + `docs/runner.md`.
- Prefer abstract runner docs; private inventory stays offline.


## Structure

```text
invincible/
├── app/                 # Next App Router (/, /harness, /login, /admin, /api/*)
├── db/                  # Drizzle schema + SQL migrations (tenancy phase 1+)
├── lib/                 # palette, chat, agent, bridge, session, sandbox, tenancy
├── sandbox/             # protocol v1 daemon (BYO tools workspace)
├── native/harness/      # Zig + dvui Wasm (CI on self-hosted runner)
├── scripts/             # fetch-harness, seed-tenancy, runner scripts
├── docs/                # BYO, sandbox, phase plans, limits, deploy race
├── public/harness/      # wasm/js gitignored; README only committed
├── AGENTS.md
└── package.json
```

| Kind of change | Where |
|----------------|--------|
| UI page / layout | `app/` |
| API / AI Gateway / agent | `app/api/*`, `lib/agent/*`, `lib/sandbox/*` |
| Tenancy schema / migrations | `db/schema.ts`, `db/migrations/` |
| Tenancy crypto / seed helpers | `lib/tenancy/*`, `scripts/seed-tenancy.ts` |
| Sandbox daemon | `sandbox/` |
| Colors / tokens (DOM) | `lib/palette.ts` |
| Colors / tokens (dvui) | `native/harness/src/palette.zig` (hex sync with palette.ts) |
| JS ↔ Wasm bridge | `lib/harnessBridge.ts` + `native/harness/src/bridge.zig` |
| Plans / ops | `docs/*` (handoffs, limits); **new plans → GitHub issues** via create-plan |
| Agent skills | `.grok/skills/*` |

## Palette (imported from Asteronica / webgpu-game)

**Source of truth (DOM):** `lib/palette.ts`  
**Source of truth (dvui Wasm):** `native/harness/src/palette.zig` — same TEAL/WARM/EMBER hex; keep in sync.

### Families

| Family | Role | Anchor |
|--------|------|--------|
| **TEAL** | Primary UI chrome, backgrounds, borders, readable text, interactive accents | `teal.*` CSS tokens + `TEAL_PALETTE` |
| **WARM** | Complementary amber `#D47C2C` — secondary highlights, CTAs, success/emphasis | `warm.*` + `WARM_PALETTE[6]` |
| **EMBER** | Red-orange `#D4412C` — **danger / error only** | `ember.*` + `EMBER_PALETTE[6]` |

### CSS tokens (use these — no freehand hex)

```ts
import { teal, warm, ember } from '@/lib/palette';
// teal.bg, teal.surface, teal.border, teal.muted, teal.text, teal.accent, teal.accentDark, teal.clear
// warm.* / ember.* same shape (no clear on warm/ember)
```

### Hard rules (same as Asteronica)

1. **All UI colors come from palette modules.** No one-off hex, no Tailwind default palette, no pure blue/cyan.
2. **TEAL** = default chrome (page bg, panels, borders, body text, primary buttons via `teal.accent`).
3. **WARM** = complementary accent only when intentional (secondary button, stream highlight, non-danger emphasis). Anchor `#d47c2c` / `warm.accent`.
4. **EMBER** = **danger only** (API errors, destructive confirm, invalid state). Never for normal chrome, success, or links.
5. Do **not** invent coral / orange / red outside `warm` / `ember`.
6. Palette ramps and CSS token objects are **golden** — do not renumber or recolor casually. `lib/palette.test.ts` locks values.
7. Prefer `teal.*` / `warm.*` / `ember.*` for DOM styles; Zig uses matching hex in `palette.zig`.

### Forbidden examples

- `#e87a5c`, `#f0a090`, Tailwind orange/red/blue defaults
- Pure blue/cyan backgrounds or accents
- Using `ember` for non-error UI
- Hardcoding `#2dd4bf` instead of `teal.accent` (literals drift)

## Feature divide (Phase 4)

**Wasm is the harness; DOM is host shell only.** See [`docs/feature-divide.md`](docs/feature-divide.md).

| DOM host shell | Wasm harness | Vercel backend |
|----------------|--------------|----------------|
| Nav, load module, bridge glue, SessionStore | Transcript, composer, agent chrome | `/api/chat`, `/api/agent`, AI Gateway, secrets |
| No competing chat panel | Primary multi-turn UX | Server-only inference + optional sandbox tools |

Do **not** rebuild a React agent chat panel as product UI.  
Do **not** put Gateway or sandbox secrets in client or Wasm.  
See create-plan / plan-review **layer** rules when planning features.

## Working rules

- Zig compile **only** on the configured self-hosted runner (`build-harness.yml`; origin sample `invincible-do-1`). After harness source changes: CI → artifact → Vercel (wait-for-SHA prebuild + deploy hook).
- Inference stays server-side (`POST /api/chat` / `POST /api/agent`). No Gateway or sandbox secrets in client or Wasm.
- Agent sandbox is a **separate process** from the Zig GHA runner — see [`docs/sandbox.md`](docs/sandbox.md).
- Prefer extending `native/harness` + `HarnessHost` over new infra.
- Run `npm test` / `npm run typecheck` / `npm run build` before claiming ready
  (**agent workspace or CI**; build needs token or existing `public/harness`).
- No secrets in repo; Vercel / GitHub secrets only.
- Ops instructions for humans: **Vercel / browser / cloud agent** only — never
  “install Node on your laptop” or “clone this path on your machine.”

## Do not

- Commit real API keys or `public/harness/*.wasm|web.js`
- Bypass palette for “temporary” colors
- Use pure blue/cyan or coral one-offs
- Grow a second unrelated color module
- Ask the **origin** maintainer to configure deploy hooks / tokens that are already listed as **Done** above (forks: use [`docs/bring-your-own.md`](docs/bring-your-own.md))
- Tell humans to use a **personal laptop/desktop** for product ops (clone, migrate, seed, npm). Use cloud agent workspaces, GitHub Actions, or Vercel instead.
