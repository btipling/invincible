# AGENTS.md — Invincible

Guidance for AI agents (and humans) working on this repository.

## Project

**Invincible** is an in-browser **agent harness**: Zig/dvui Wasm workspace
(transcript + composer) hosted by Next.js, with inference via Vercel AI Gateway.
The canvas at `/harness` is the product; DOM is host shell only.

| | |
|--|--|
| **Source** | https://github.com/btipling/invincible |
| **Prod (sample)** | https://invincible-dun-ten.vercel.app |
| **Architecture** | [`docs/feature-divide.md`](docs/feature-divide.md) · [README](README.md) |
| **Deploy** | Vercel (Git-linked) + Actions artifact `harness-wasm` |
| **GitHub account** | owner **`btipling`** (not display name “Bjorn”) |

## Reusable product (not a one-off)

Invincible is **meant to be reusable**, not a private single-purpose app.

**North star:** anyone can **connect this repository** to **their own Vercel
project** and **their own sandbox / runner**, then run the harness for **their**
work — **independent of the language or platform** of the target project, and
**without needing a personal laptop or desktop** to operate the product.

| Today | Intent |
|-------|--------|
| Single public deploy + this author’s infra are documented for operators | Multi-operator / bring-your-own Vercel + keys |
| Sandbox MVP **shipped** via `SANDBOX_URL` + `SANDBOX_TOKEN`; tenancy **per-row** `backend`/`image` (BYO or Vercel) via admin ([docs/sandbox.md](docs/sandbox.md)) | No host-wide `SANDBOX_BACKEND`; origin dogfood image: `dev/` + GHA **`dev-image-build`** → VCR ([dev/README.md](dev/README.md)) |
| Stack is Next + Zig/dvui Wasm + AI Gateway | Target projects can be **any** stack; the harness is the workspace |
| Tenancy code + origin Production cutover **Done** (login + DB grants). Tenancy is **hard-on**: multi-tenant-only, login wall + fail-closed auth (Phase 1) | Login/grants required **and** cloud-native bootstrap (no personal machine) |


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
| Run `npm test` / migrate / backfill **in the agent workspace or GHA** when needed | Treat “local” as the human’s personal computer |
| Prefer **cloud-native cutover** paths (**Actions `workflow_dispatch` primary**, then agent-run scripts, hosted DB) | Document laptop-only ops **or script-only npm** as the primary Production path |

“Local” in this file means **the agent’s or CI’s checkout**, not a developer’s
home directory. Product copy and plans must not require personal hardware.

**Plans are not enough if they only say “run npm.”** A sentence here is not an
operator surface. Any Production **data/secret mutate** (migrate, backfill,
re-encrypt, coordinated cutover) must ship a **GitHub Actions** entrypoint
(usually `workflow_dispatch` with confirm/dry_run guards on `ubuntu-latest`) as
the **primary** path. `package.json` scripts are what the job runs — not a
substitute for Actions when humans have no laptop shell.

**Living docs vs plan issues:**

| Place | Holds |
|-------|--------|
| **GitHub plan issues** | Phases, parent maps, handoff checklists, “implements #N” |
| **`docs/*`, README, SECURITY, this file** | Timeless product/ops truth for **new** people and agents |

Do **not** write product/ops guides as phase narratives or issue archaeology
(“see phase 3 / issue #95”). Write what the system does and how to operate it
**now** (workflow names, env names, order of steps).

**Agent rules:**

- Prefer designs and plans that keep **config seams** (env, project IDs, runner
  labels) rather than hardcoding one owner’s prod URL or cloud account.
- Do **not** treat “works only on invincible-dun-ten.vercel.app” as architecture.
- When a change **blocks** reusability **or forces personal-hardware ops**, call
  it out in the plan/PR and prefer a cloud-agent / **GHA** / Vercel path.
- **create-plan** / **plan-review** must lock **Cloud ops path** + **Living docs**
  (always consider `AGENTS.md` + `README.md` updates). plan-review treats
  laptop/script-only Production cutover as a **Blocker**.
- **Cap governance:** every cap/limit/budget in a plan goes in a **Caps table**
  (value + rationale + code location), generous by default for NEW caps/ceilings.
  **Any change to an existing cap — a raise OR a lowering — is a BLOCK + human
  decision**: plan-review may **suggest** a change, the implement-plan agent
  **decides** (which blocks the plan), and only a **human** **approves**, on the
  plan's explicit justification/defense — always budget accounting vs the
  **inviolable transport ceiling of the wire that carries the value** (a raise
  above that ceiling is the #511/#525 Function-body class) + residual risk.
  Nothing about raising an existing cap is "never a blocker."
- Config seams for BYO Vercel/keys/runner (#38), **sandbox MVP** (#45),
  **optional multi-tenant auth** (#54 phases 1–5 + cloud cutover #67), and
  the **first-run sign-up bootstrap** ([docs/bring-your-own.md](docs/bring-your-own.md) §4a)
  are **landed** on origin Production (unauth API 401 + login verified).
  **SSO/SCIM** code ([#64](https://github.com/btipling/invincible/issues/64)
  phases 1–3) is on `main`; **origin** OIDC/SCIM env remains **Not Done** until
  an operator configures + smokes (see infra table). Still write docs/config as
  reusable BYO seams — not a single-owner IdP hardcoding.
- Origin `SANDBOX_*` is **Done** for the reference deploy (private host inventory
  stays offline). Still never invent a host URL; forks set their own env.
- Origin **dogfood VCR image** (`dev/` + GHA `dev-image-build`) is **code on
  main** when landed; **secrets/vars + first push + admin image** remain
  **Not Done** until an operator configures them. Do not nag as forgotten
  Product env; treat as optional origin infra like OIDC. Never put `VERCEL_TOKEN`
  in client/Wasm/git.
- Origin **tenancy** (`DATABASE_URL` / `AUTH_SECRET` / `CREDENTIALS_ENCRYPTION_KEY`)
  is **Done** on Production (cutover smoke: unauth 401 + login). Per-tenant DEK
  **code** is on `main` (envelope + dual-read + owner DEK rotate). Origin **data**
  cutover (legacy AMK tokens → DEK, then optional `dek-only`): primary path is
  GHA **`db-tenancy-backfill-deks`** (`confirm=backfill`; dual-store secrets);
  do **not** use `db-migrate`/the bootstrap for that (migrations are schema-only).
  Dual-read keeps Production working until the operator dispatches backfill +
  optional `TENANT_TOKEN_DECRYPT_MODE=dek-only`. Never laptop npm as the
  official cutover.
- **Tenant BYOK inference** is on `main`: admin **`/admin/inference`**, `GET /api/models`, harness protocol v3 status-bar model menu, chat/agent request-scoped BYOK. **Never** route via a host env-model fallback. Additive schema for provider tables: GHA **`db-migrate`** (schema-only; the bootstrap is the app's first-run sign-up). Docs: [docs/bring-your-own.md](docs/bring-your-own.md) §4a Inference keys.

- Do **not** instruct humans to clone the repo on a laptop to bootstrap tenancy;
  the app's **first-run sign-up** (after GHA **`db-migrate`**) is the no-laptop,
  no-seed path — see [docs/bring-your-own.md](docs/bring-your-own.md) §4a.


## Project agent skills

Load from **this repo** via `gh` (not generic template skills). Zero-search:

| Skill | Path on `main` | Use when |
|-------|----------------|----------|
| **create-plan** | `.grok/skills/create-plan/SKILL.md` | “use create-plan”, feature plans as **GitHub issues**, parent + phase issues; locks **cloud ops (GHA)** + **living docs** |
| **plan-review** | `.grok/skills/plan-review/SKILL.md` (+ `LOAD.md`, `references/*`) | Review a plan **issue**; default edit issue body via `gh`; scores cloud ops + living docs |
| **adversarial-review** | `.grok/skills/adversarial-review/SKILL.md` (+ `LOAD.md`, `references/*`) | Hostile **PR** review; break scenarios; post comment via `gh` |
| **cleanup-sandbox** | `.grok/skills/cleanup-sandbox/SKILL.md` (+ `LOAD.md`) | Post-session hygiene: checkout + pull latest `main`, delete leftover local branches / agent scratch; auto-deletes **nested self-clones** (same-origin `ivc-*` / `.grok` copies) without asking; **refuses** to discard current uncommitted work without explicit operator consent |
| **implement-plan** | `.grok/skills/implement-plan/SKILL.md` (+ `LOAD.md`) | Code a reviewed plan into a **non-merged PR** + tests; canonical test/build workflow (`npm run typecheck`, `vitest run`, `vitest run --changed`), in-sandbox exec rules, layer ownership, code standards |
| **merge-pr** | `.grok/skills/merge-pr/SKILL.md` (+ `LOAD.md`) | Merge a reviewed PR into `main` with a **mandatory full vitest run** gate — tests run directly with vitest, no wrapper; merge commit (no squash); verifies issue close-out + post-merge cleanup. `vitest run --changed` is the fast PR-iteration signal, never a merge gate |

Index: [`.grok/skills/README.md`](.grok/skills/README.md).

**Plan storage:** implementation plans are **GitHub issues** (see create-plan),
not a required `docs/*-plan.md`. Completed phase plan/handoff markdown was
removed; living product/ops guides live under `docs/` (feature-divide, runner,
BYO, limits) and must stay **timeless** (no phase/issue process artifacts).


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

## PR merge convention (optional)

This is an **optional** convention — apply it only when an operator asks you to
merge a PR. There is no hard wiring; the repo currently has no enforced merge
policy, so fall back to these defaults for consistency.

| Item | Default |
|------|---------|
| Merge type | **Merge commit** — `gh pr merge <n> --merge` (keep each PR’s conventional commits intact; **no squash / no linearize**) |
| Author identity | Every commit authored `btipling <btipling@users.noreply.github.com>` per the hard constraint above; do **not** rebase or rewrite authorship on a PR |
| When to merge | **Only on explicit request.** Default is do **not** merge (agents stop at “merge-ready from review”) |
| CI before merge | Wait for the PR’s checks to complete and show green **before** merging (e.g. `test`, `typecheck`, `build`, `build-harness`). Do not merge while required checks are `pending`/`failed`; if `main` has no enforced branch protection, still wait for the PR’s CI unless the only outstanding checks are unrequired/infrastructure ones you call out explicitly |
| Issue close-out | PR body carries `Fixes #N` / `Refs #N`; merge auto-closes linked issues. For plan issues, close as **completed** and reference the merge |
| After merge | Delete the merged branch, then in any agent/local checkout `git checkout main && git pull` and prune stale remote-tracking refs (`git remote prune origin`) |

Once merged, linked self-hosted workflows (`build-harness`, DB migrations)
run on the runner and ship through the artifact→Vercel seam; operator smoke
items remain gated on Preview/Production as the plan’s DoD requires.

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
| Tenant BYOK provider secrets (DB) | **Done** (code) | Admin `/admin/inference`; ciphertext under tenant DEK; grants + model catalog; chat/agent attach request-scoped Gateway BYOK (never env model routing). Schema-only Production: GHA **`db-migrate`** (`confirm=migrate`) |
| Per-user MCP servers (DB) | **Done** (code) | Settings `/settings/mcp`; header secrets under tenant DEK; tools on `/api/agent` only; SSRF url policy; DEK rotate re-encrypts. Schema: GHA **`db-migrate`**. Ops/smoke: [docs/mcp.md](docs/mcp.md) |
| Per-user GitHub PAT (DB + inject) | **Done** (code) | Settings `/settings/github`; DEK ciphertext; sandbox **exec** inject `GH_TOKEN`/`GITHUB_TOKEN` (both backends); redact on turn; DEK rotate re-encrypts. Schema: GHA **`db-migrate`**. Ops: [docs/sandbox.md](docs/sandbox.md) |
| Per-user agent personas (DB + API, phase 1 #486) | **Done** (code) | `user_personas` store + `GET /api/personas` summaries + `meta.{personaId,personaSnapshot}` reserved keys + raised meta budget. Bodies are **non-secret** plaintext (no DEK). Version history + rollback (plan #726, source #534): `user_persona_versions` table (journal 0015) — every create/body-edit/Restore captures an append-only body snapshot capped `PERSONA_VERSION_MAX`=100; Settings Restore/Copy/View via `/api/settings/personas/[id]/{versions,versions/[versionId],rollback}`. Schema: GHA **`db-migrate`** (0010 + 0015). |
| Per-user agent skills (DB + API, phase 1 #498) | **Done** (code) | `user_skills` store + `GET /api/skills` summaries (no body) + server-side `getSkillBySlug` injection seam. Bodies are **non-secret** plaintext (no DEK); slug charset `^[a-z][a-z0-9_-]{0,127}$` (hyphen allowed) is the single source shared with the phase-3 slash parser. `/api/skills` sits on the **middleware auth edge** (`isApiProtected` + matcher) like `/api/personas` (dual gate: in-route `requireSessionUser` + middleware). Schema: GHA **`db-migrate`** (0011). Attach/injection/UI/tool: later phases |
| `HARNESS_ARTIFACT_TOKEN` (Vercel) | **Done** | PAT Actions: Read — prebuild downloads `harness-wasm` |
| `VERCEL_DEPLOY_HOOK_URL` (GitHub secret) | **Done** | deploy hooks; `build-harness` pings after artifact upload |
| DO runner `invincible-do-1` labels `invincible`,`zig` | **Done** | Zig 0.16.0 only there |
| `SANDBOX_URL` / `SANDBOX_TOKEN` (Vercel) | **Done** | Agent sandbox on origin Production — see [docs/sandbox.md](docs/sandbox.md); host inventory private; never invent a host URL |
| `DATABASE_URL` (Vercel) | **Done** | Pooled Postgres (Neon) for required multi-tenant auth — Production cutover smoke passed (unauth 401 + login); no host inventory in git |
| `AUTH_SECRET` (Vercel) | **Done** | Auth.js signing secret — Production cutover smoke passed |
| `CREDENTIALS_ENCRYPTION_KEY` (Vercel) | **Done** | AES-GCM AMK wrapping per-tenant DEKs (tokens under DEK; dual-read cutover) — dual-store with GHA; never reuse casually on public Preview. Owner DEK rotate via `/admin`. Existing-data backfill: GHA `db-tenancy-backfill-deks`. Do not rotate Production AMK without re-wrap tool |
| Optional OIDC (`AUTH_OIDC_ISSUER` / `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` / `AUTH_OIDC_LABEL?`) | **Not Done** | Generic SSO — configure when operator wants IdP login; callback `{origin}/api/auth/callback/oidc`; BYO: [docs/bring-your-own.md](docs/bring-your-own.md) §4b |
| Optional SCIM (`SCIM_BEARER_TOKEN`) | **Not Done** | SCIM 2.0 Users at `/api/scim/v2` — set only when directory provisioning is intended; fail-closed 404 when unset |
| Blob transcript store (`BLOB_READ_WRITE_TOKEN`, phase 0 #515) | **Not Done** (documented seam only) | Vercel Blob (or BYO S3/R2 behind the same seam) for the session **transcript**; Redis keeps the small envelope. Server-minted short-lived scoped upload URLs; client→Blob uploads; legacy full-record GET stays for roll-forward while old blobs stay small. Configure in Vercel/env-manager, never a laptop ritual; no migrate/backfill/seed. Docs: [docs/bring-your-own.md](docs/bring-your-own.md), [docs/session-model.md](docs/session-model.md). When unset the app runs an in-memory transcript store (dev/tests only) |
| Vercel Workflows (backend-agents) | **Done (code)** | Workflow SDK wired (`workflow` dep + `withWorkflow` in `next.config.js`), authed smoke route (`app/api/workflows/smoke`), dispatch GHA **`workflows-smoke`** (default `environment=production`). Workflows **activates automatically when you deploy with the SDK** — there is no dashboard enable button; the operator step is **deploy to Production** then dispatch **`workflows-smoke`** (`confirm=smoke`, `environment=production`). Never the tab-owned `/api/agent` as the smoke path. Ops: [docs/feature-divide.md](docs/feature-divide.md) |


**Agent behavior (origin):**

- Do **not** prompt “set `VERCEL_DEPLOY_HOOK_URL`” / “wire the deploy hook” / “optional secret if not already”.
- If workflow log says hook skipped (`not set`), treat as a real regression and investigate — still prefer fixing CI/docs over lecturing the user.
- Race fix lives in `scripts/fetch-harness-artifact.mjs` (wait for commit-matched artifact). See `docs/harness-deploy-race.md`.
- `SANDBOX_*` is **Done** on origin Production. If harness shows exact 503 not-configured or tools vanish, treat as regression (env/redeploy/reachability) — still no invented hosts ([docs/sandbox.md](docs/sandbox.md)).
- **Sandbox daemon version gate:** once deployed Next expects a matching
  `daemonVersion`, a long-lived behind unit returns **426 out-of-date** on every
  FS tool until it is updated once (manual restart **or** daemon opt-in
  `SANDBOX_AUTO_UPDATE=1` + `SANDBOX_GIT_DIR` → ff-only pull + self-restart).
  Never bump `INVINCIBLE_SANDBOX_DAEMON_VERSION` without the matching
  `EXPECTED_SANDBOX_DAEMON_VERSION` — the parity unit test blocks drift. No new
  GHA deploy needed; host inventory stays private ([docs/sandbox.md §3](docs/sandbox.md)).
- Tenancy triple env is **Done** on origin Production, and tenancy is now
  **hard-on**: multi-tenant-only with a login wall + fail-closed auth. There is
  no open shell (no login-free deploy mode). Do **not** nag the origin
  maintainer to “set `DATABASE_URL`” as if forgotten. If unauth `/api/agent` no
  longer returns 401 or login fails, treat as **regression** (env/redeploy),
  not a greenfield cutover. The **bootstrap is the app's first-run sign-up** —
  after GHA **`db-migrate`**, open `/login` on a tenant-less DB to create the
  first tenant + owner (no seed env, no laptop); the owner provisions sandboxes
  at `/admin/sandboxes`. Legacy AMK→DEK data cutover stays GHA
  **`db-tenancy-backfill-deks`** only (never `db-migrate` for data). Public
  smoke: `npm run smoke:tenancy`.
- Per-user **MCP** code is on `main` (Settings + agent merge). Schema on Production still needs GHA **`db-migrate`** when `user_mcp_servers` is missing. Operator smoke: [docs/mcp.md](docs/mcp.md) (Exa). Never put MCP API keys or user GitHub PATs in client/Wasm/git.
- Optional **OIDC / SCIM** on origin are **Not Done** until an operator sets env
  and smokes. Do **not** claim they are configured, invent IdP URLs, or nag to
  “enable SSO” as a forgotten secret. When configuring: follow
  [docs/bring-your-own.md](docs/bring-your-own.md) §4b; never put
  `AUTH_OIDC_CLIENT_SECRET` or `SCIM_BEARER_TOKEN` in client/Wasm or git.
- **Vercel Workflows** runs/steps live **server-side** (Vercel Functions +
  Queues), never in Wasm/DOM. Workflows is **not** a dashboard toggle or an app
  env flag — it **activates automatically once you deploy with the SDK**
  (`workflow` dep + `withWorkflow`); there is no enable button to hunt for.
  Verify enablement + a completed run via the **`workflows-smoke`** dispatch
  (`confirm=smoke`, `environment=production`); an unready project fails
  the smoke (**fail closed**, non-zero) and is never a silent fallback to the
  tab-owned `/api/agent`. Run/step traces: Vercel → Observability → Workflows.

### Vercel Workflows (backend-agents)

- **Wiring ships by Git deploy:** `workflow` dependency + `withWorkflow(nextConfig)`
  in `next.config.js`; `"use workflow"` fixtures/xhr live server-side
  (`lib/workflows/*`, `app/api/workflows/smoke`).
- **No enable button** — Workflows activates automatically when you **deploy with
  the SDK** (`workflow` dep + `withWorkflow(nextConfig)`); there is no dashboard
  Workflows toggle. **Observability → Workflows** is a *view* (run/step traces),
  not a control — runs record automatically once deployed.
- **Verify:** dispatch Actions → **`workflows-smoke`** → Run workflow
  (`confirm=smoke`, `environment` **defaults to `production`**) after deploying.
  It drives `start`→`getRun`→`completed` for the
  trivial fixture through the Vercel Workflows API (SDK Vercel World) using the
  existing `VERCEL_TOKEN` / `VERCEL_PROJECT_ID` / `VERCEL_TEAM_ID` (no new secret)
  and exits 0 only on `completed`. Disabled/unready → non-zero; never a silent
  fallback to the tab-owned `/api/agent` POST.
- **Authed human surface:** `POST /api/workflows/smoke` (start → `{runId}`) +
  `GET /api/workflows/smoke?runId=` (poll → `{status}`), cookie-gated
  `requireSessionUser()` — meets unauth with **401** (not 403), `start` disabled
  → **503** fail-closed, and back-to-back `POST`s within the per-process window
  → **429**. A server-side GHA has no browser cookie, so it does not route
  through this route (plan-review lock).
- **Caps:** step `maxDuration` = 1800 s (Fluid Function ceiling, unchanged);
  smoke poll budget `WORKFLOWS_SMOKE_POLL_TIMEOUT_MS` 120000 / interval
  `WORKFLOWS_SMOKE_POLL_INTERVAL_MS` 2000 (±0.5 s jitter); per-process
  `POST` start guard `WORKFLOWS_SMOKE_POST_MIN_INTERVAL_MS` = 15000 (429) —
  bounded, generous, NEW caps in the plan's Caps table. `maxDuration` stays as
  the plan pinned; a LOWER ceiling would be a human-gated cap change.

IDs and URLs (maintainer sample): [`docs/project-ids.md`](docs/project-ids.md).  
BYO: [`docs/bring-your-own.md`](docs/bring-your-own.md). Sandbox: [`docs/sandbox.md`](docs/sandbox.md).  
MCP: [`docs/mcp.md`](docs/mcp.md). Builtin HTTP: [`docs/builtin-http.md`](docs/builtin-http.md).  
Runner ops: [`docs/runner.md`](docs/runner.md). Security: [`SECURITY.md`](SECURITY.md).

## Public repository policy

- Do **not** commit host IPs, droplet IDs, or cloud account GUIDs.
- Self-hosted workflows: default `workflow_dispatch` or `push` to `main`. **`build-harness` only** also **compiles** on **same-repo** contributor `pull_request` → `main` (not forks; no `pull_request_target`; no Vercel deploy hook on PR; production artifact `harness-wasm` is **main-only** — PRs upload `harness-wasm-pr-<n>`). Other self-hosted workflows stay main/dispatch only.
- Job `if:` opt-in: `vars.SELF_HOSTED_BUILDS == 'true'` **or** origin grandfather `github.repository == 'btipling/invincible'`. Clones must set the Actions **variable** (not secret) after attaching their own runner; foreign repos without the var **skip**.
- Optional `vars.RUNNER_LABELS` JSON array for `runs-on` (default `["self-hosted","invincible","zig"]`). See `SECURITY.md` + `docs/runner.md`.
- Prefer abstract runner docs; private inventory stays offline.


## Structure

```text
invincible/
├── app/                 # Next App Router (/, /harness, /login, /admin, /settings, /api/*)
├── db/                  # Drizzle schema + SQL migrations (tenancy)
├── lib/                 # palette, chat, agent, bridge, session, sandbox, tenancy
├── sandbox/             # protocol v2 daemon (BYO tools workspace)
├── native/harness/      # Zig + dvui Wasm (CI on self-hosted runner)
├── scripts/             # fetch-harness, backfill, runner scripts
├── docs/                # BYO, sandbox, mcp, builtin-http, feature-divide, limits, deploy race
├── public/harness/      # wasm/js gitignored; README only committed
├── AGENTS.md
└── package.json
```

| Kind of change | Where |
|----------------|--------|
| UI page / layout | `app/` |
| DOM site chrome nav (hamburger Account menu) | `app/components/AppNav.tsx` (brand wordmark; optional `busy?: boolean` from `HarnessHost` only — TEAL outline + neon bloom + sine pulse + motes while the active harness turn is Busy; never poll the bridge; settings/admin omit the prop), `app/components/AuthNavLinks.tsx` (server: `soleMembership`+`canAccessAdmin` → `showAdmin`), `app/components/NavMenu.tsx` (client dropdown: ARIA `menu`, Arrow/Tab/Home/End, Escape + click-outside close + focus return, ≥44px touch targets, palette-only TEAL), `lib/navMenu.ts` + `lib/navMenu.test.ts` (`buildSignedInNavItems` — pure ordering/gating rule, unit-tested), footer slot `app/logout/LogoutButton.tsx`; unauth keeps inline `Sign in` header control. Client holds **zero** role-gate logic — it renders pre-gated inert `items` only |
| API / AI Gateway / agent | `app/api/*`, `lib/agent/*`, `lib/sandbox/*` |
| Agent SSE stream (tools + text + reasoning) | `lib/agent/agentStream.ts`, `lib/agent/runAgent.ts`, `lib/agent/reasoningConfig.ts`, `lib/agent/generateOneRound.ts`, `lib/workflows/modelGenerateStep.ts`, `lib/workflows/toolExecuteStep.ts` (one step per model round’s `toolCalls`; live `tool_result` via `withDefaultStreamWriter`; `maxRetries = 0` — 1-call infra throws retry in-process), `lib/workflows/turnSseWrite.ts` (`withDefaultStreamWriter` around `generateOneRound` for durable live `reasoning_delta` / `text_delta` / `tool_start` — **one** `getWritable()` per model round, not per token; same held-writer for a tool batch; loop does not dump those events; `writeOnDefaultStream` is the sparse `writeTurnSse` path for `done` / `error`), `app/api/agent/route.ts`, `lib/agentApi.ts`, `docs/agent-stream.md` |
| Durable turn-end (truncated / capped is Error, not model-finished) | `lib/agent/modelFinish.ts` (`isTruncatedFinish`: `length` / `content-filter` / `error`), `lib/workflows/turnLoop.ts` (empty tools + truncated `finishReason` → terminal persist then SSE `error` `output truncated`, not `done`; 512-step cap → close unpaired tool-calls then tools-off wrap-up (model sees the error) then terminal persist then `step budget exhausted`), `lib/workflows/turnLog.ts` (`console.log` one JSON line `invincible.turn.model` / `invincible.turn.persist` inside `'use step'` — Observability → Workflows, **not** HTTP Runtime Logs), `lib/harnessChat.ts` (truncated `done` defense), [docs/agent-stream.md](docs/agent-stream.md). There is **no** in-repo `maxOutputTokens`. |
| Durable agent system prompt (same resolver as `/api/agent`) | `lib/agent/agentSystem.ts` (`resolveSystem` + `DEFAULT_AGENT_SYSTEM` / HTTP / skill / meta-only strings), `lib/workflows/modelGenerateStep.ts` (in-step after assemble, from the assembled registry; persona snapshot + sticky/always-on skills fail-open independently — persona via the envelope seam, never legacy `get`/`put`; slash-command attach is **not** handled in the step; cap wrap-up `disableTools` skips assemble and uses `STEP_BUDGET_WRAPUP_SYSTEM`, never `DEFAULT_AGENT_SYSTEM`), `lib/agent/runAgent.ts` (same helper). Do **not** add `maxOutputTokens`. |
| Agent read-before-edit / file freshness | `lib/agent/fileFreshness.ts`, `lib/agent/pathLock.ts` (per-path apply serialization), `lib/agent/tools.ts`, `lib/agent/runAgent.ts`, [docs/sandbox.md](docs/sandbox.md) |
| Logical agent cwd + workspace-root↔abs canonicalization (`change_dir` / session / default env; **`sandbox_info`** is the bind/cwd/caps/env introspector — do not `exec env`; `canonicalizePath(R, p)` / `workspaceAbsToRel(R, abs)` / `resolvePathForTool(R, cwd, p)` / `rewriteExecRootToRel(R, text)` in `lib/agent/workPath.ts`) + **`search`** (read-grant-only code-grep via `rg`; `lib/agent/tools.ts`) | `lib/agent/workPath.ts`, `lib/agent/tools.ts`, `lib/agent/runAgent.ts`, `lib/agent/agentBody.ts`, `lib/sandbox/config.ts`, `lib/sessionStore.ts`, `lib/harnessChat.ts`, `lib/agentApi.ts`, `lib/sessionCloudCaps.ts` (shared client-safe `sanitizeSessionCwd` + Redis-safe opaque id predicate), [docs/sandbox.md](docs/sandbox.md), [docs/session-model.md](docs/session-model.md), [docs/agent-stream.md](docs/agent-stream.md). Tool paths accept **in-jail absolute paths** on all FS tools + `change_dir` + `exec` cwd: an absolute under the per-binding jail root R (`resolved.value.workspaceRoot` → `RunAgentParams.workspaceRoot` → `createAgentTools`) is canonicalized to the same workspace-relative freshness key as its relative form (BYO + Vercel parity); out-of-jail absolutes and `..`/symlink escapes fail closed. Absolute paths under `R` that **appear in `exec` stdout/stderr** are likewise rewritten to workspace-relative (`rewriteExecRootToRel` in `lib/agent/workPath.ts`, applied to `result.stdout`/`result.stderr` separately) so `exec pwd` ≡ `pwd`/annotations; when `R` is unresolvable the exec output passes through byte-for-byte (fail-open), and rewrites are capped and never throw. When R is unresolvable (BYO daemon down/pre-v2 — `workspaceRoot === null`) absolute is rejected (“root unavailable — use workspace-relative”) while relative + cwd still work. Initial request/session `cwd` stays relative-only; `.` is the workspace-root default session start (there is no `SANDBOX_DEFAULT_CWD` env knob), `..` walks up toward the workspace root and errors only past it, and an **exact ancestor** of cwd re-roots cleanly (`change_dir invincible` from `cwd=invincible/docs` → `invincible`, not the phantom `invincible/docs/invincible`) while a name-prefix sibling is never re-rooted. P1/GAP-1 (#452/#330): `cwd` + `activeSandboxId` are **session-owned** and ride the Redis record (`meta.{logicalCwd,activeSandboxId}`). `activeSandboxId` is now **server-resolved** (routing override via `lib/tenancy/resolveSandbox.ts` `requestedSandboxId`), not carry-only. A **confirmed successful `change_dir`** is persisted as the session cwd even when the turn later cancels / times out / hard-errors (`lib/harnessChat.ts` host-side `liveCwd`); the success path still prefers the authoritative `agentResult.cwd`, and only a confirmed `change_dir` (never an errored one) is stored on a failed/aborted turn. The **`exec` tool** returns a **compact summary**, not a raw dump: first `EXEC_LOG_HEAD_LINES` (10) + last `EXEC_LOG_TAIL_LINES` (10) lines per stdout/stderr with line/byte counts and `... (N lines truncated)`, each shown line byte-clipped (`EXEC_SUMMARY_LINE_MAX_BYTES`=4096) so a single fat stdio line can't inline the stream or truncate the `log:` pointer off; and when either stream is non-empty writes the full redacted output to `<workspace>/.invincible/logs/exec-<ts>-<seq>.log` via `client.write_file(..., mkdir: true)` (a brand-new hidden workspace dir; backends never auto-create parents; the `-<seq>` monotonic counter keeps same-ms parallel execs from overwriting), reporting two `read_file` pointers — `log: <rel path>` (cwd-relative, from nested cwd `../.invincible/logs/…`) and `log (root): <root path>` (workspace-root-relative, read from the workspace root `cwd .`, so a depth-changing `change_dir` can never strand the full output); the write stays workspace-root, and `.invincible/` is gitignored; both pointers ride immediately after `exit=`/`TIMED_OUT` — empty output (`exec true`) writes no file, and a log-write failure fails soft with a `⚠ log write failed` note whose reason is **sanitized** (a backend/jail path never surfaces) (caps `EXEC_LOG_HEAD_LINES`/`EXEC_LOG_TAIL_LINES`=10 and `EXEC_LOG_MAX_BYTES`=8 MiB in `lib/sandbox/config.ts`) |
| Cloud multi-device harness session (Redis multi-session, `/api/sessions*`, hybrid local+cloud; **phase 0 #515 envelope + Blob transcript carrier**) | `app/api/sessions/*` (+ `app/api/sessions/[id]/envelope/*`, `[id]/transcript/*`), `lib/sessionRepository.ts`, `lib/sessionCloudCaps.ts`, `lib/sessions/*` (+ `lib/sessions/blobStore.ts`, `blobStores.ts`), `lib/tenancy/harnessSessionsRedis.ts`, `lib/tenancy/harnessSessions.ts` (archive read + shared validator), `lib/di/index.ts` (root), `app/harness/HarnessHost.tsx`, `middleware.ts`, [docs/session-model.md](docs/session-model.md), [docs/bring-your-own.md](docs/bring-your-own.md), [SECURITY.md](SECURITY.md) — one-shot Postgres→Redis backfill: GHA **`sessions-redis-backfill`** (idempotent per-user marker); Postgres `harness_sessions` is a read-only archive. P1/GAP-1 (#452): session-carrier `meta.{logicalCwd,activeSandboxId}` folds into the PUT body and restores on pull/adopt; **plan #616 (source #610)** adds the reserved `meta.selectedModel` session carrier for the selected model pick (restore by id after the model catalog push; server **drops a poisoned value to unset**, never a 400). **Phase 0 (#515):** the transcript lives in **Vercel Blob** (`BLOB_READ_WRITE_TOKEN` / BYO S3-R2 seam) pointed to by `meta.transcriptPointer` on the small Redis envelope (`harness:envelope:*`); server mints short-lived scoped upload URLs for **client→Blob** uploads; legacy full-record GET stays for roll-forward while old blobs stay small. Envelope upsert/read: `PUT`/`GET /api/sessions/:id/envelope`; mint/read: `POST`/`GET /api/sessions/:id/transcript` |

| Harness stream chrome (Thinking collapse/caps, live tools) | `lib/harnessChat.ts`, `native/harness/src/ui.zig` (facade + `frame`; transcript band owner), `native/harness/src/ui/thinking.zig` (Thinking kind), `native/harness/src/transcript_split.zig` (collapsible left rail + session list in the transcript band), `native/harness/src/session_catalog.zig` (v17 catalog + pending switch), protocol **v21** in `lib/harnessBridge.ts` (Stop cancel v9; Thinking kind v8; tool-run kind 6 v10→live paint v11; skill-attach kind 7 v12; **status-slot store v13**; **turn-clock feed v14**; **v14 addendum** `inv_set_busy_tick`; **v16** model persist; **v17** session-rail catalog + pending switch; **v18** `inv_queued_count` submit-queue depth; **v19** `inv_set_queue_promote_allowed` — host arms a one-shot per-terminal scalar so a Stop/Esc/error/timeout Ready **never drains the queue**; only idle ▶ / Ctrl+Enter with an empty composer + non-empty queue promotes, plan #760; **v20** `inv_queued_insert_front` — **turn retry that never drains the queue** (plan #759): the host retries a retryable agent-turn error up to `TURN_RETRY_ATTEMPTS`=5 (NEW cap) with bounded backoff via the additive `classify` seam (`lib/sandbox/resilience.ts`), then gives up onto `Lifecycle.Error` (a failed turn is never terminal for the Wasm promote gate — `ui.zig` promotes only on successful Ready), inserting `Continue the current turn` at the queue head (`inv_queued_insert_front`) when non-empty; permanent `PERMANENT_TURN_STATUS` statuses (400/401/403/404/413/422) give up after one attempt (no loop); 408/429/5xx and timeout/empty retry up to 5 attempts — but **1 attempt** once the live stream has painted a ring row past the user line (fail-closed: replaying would re-run tools / duplicate bubbles), and **1 attempt** once a durable `/api/turns` run has started (`onTurnStarted` folded `turnRunId` + `running`; another POST would start a second workflow). Durable SSE that ends without a producer `done`/`error` after that start is **detach** (keep `turnRunId` + `running`, no Turn-ended line) — `lib/harnessChat.ts` (`sawStreamTerminal` + this-turn start flag + D18 persist fold); `lib/turnApi.ts` forwards `turnRunId` on stream-read failure. **In-canvas Pause (submit-queue hold):** a Wasm-internal `queue_paused` latch folded into `submit_queue.canPromote` (via `bridge.tryPromoteQueued`, the single promote seam) holds **every promote path** — auto-promote on successful Ready and idle empty-▶ / empty Ctrl+Enter Play — so the next turn reads from the composer; typed send + FIFO contents + enqueue/edit/remove/Clear unaffected; **auto-clears when the FIFO empties**; TEAL `· paused` toggle on the queue-band header (`n>0`); **no new export / no protocol bump / no cap change** (Wasm-ephemeral like the queue) |
| Keyboard shortcuts (keymap, leader, help overlay) | `native/harness/src/keymap.zig` (single chord table + reserved-browser deny-list + leader machine; **NEW caps** `KEYMAP_MAX`=64, `LEADER_WINDOW_MS`=800), `native/harness/src/ui/keymap_dispatch.zig` (one per-frame walk of `dvui.events()`, handled-marking, leader dvui-timer arm/expiry), `native/harness/src/ui/help_overlay.zig` (modal `floatingWindow` **wide two-column table** over the transcript band — fixed chord column + remaining-width help column; wheel/trackpad scrolls the list **inside** the panel, never the transcript; a backdrop click-outside closes it; every looping widget uses a loop-unique `id_extra`, no duplicate-id red outlines), `native/harness/src/ui/metrics.zig` (help-overlay size = band fractions `HELP_OVERLAY_W_FRACTION`/`H_FRACTION` + `_MIN_*`/`_FLOOR_*` floors + `HELP_OVERLAY_CHORD_COL_W`; the fixed 460×320 `HELP_OVERLAY_W/H` cap is retired), wired in `native/harness/src/ui.zig` (dispatch before textEntry; overlay paint) + `ui/queue_band.zig` (scan removed; `queue_save`/`cancel_queue_edit` routed via dispatcher). **DOM adds no keyboard UI / `window` keydown / React cheatsheet** |
| Workspace status bar (protocol v13 status-slot store; bridge overall **v14** — plan #538/#541 + Phase 2 git #540 + Phase 3 context/usage #539, **two-line bottom status bar under the composer — #554/#555/#570**) | `native/harness/src/{bridge,ui,model_picker,model_catalog}.zig` (status-slot store + two-line 64 px bar directly **below the composer**: **line 1** = identity (spinner · `h:{build-id}` · model menu) relocated from the deleted header band, **line 2** = `paintStatusSlots` right-aligned slot pack — header merged by plan #570; each line has explicit 32 px height so the model picker (`PICKER_TRIGGER_H`=32) fits and slots never clip; sandbox/cwd/git + context/usage slots — context painted generically via `STATUS_SLOT_DROP_ORDER`), `lib/harnessBridge.ts` (`StatusSlot`, `setStatusSlot`/`getStatusSlot`/`clearStatusSlot`/`clearStatusSlots`, `STATUS_SLOT_MAX_BYTES` mirror), `lib/harnessChat.ts` (`foldStatusSlots` — folds `activeSandboxId` + `cwd` + **context/usage** (`formatUsageSummary`, re-sanitized on read) after hydrate, after **every** agent turn — success **and** fail (403-clear / committed `change_dir` repaint the pack — PR #543), and **live mid-turn on tool results** (Phase 2 #627 / #625: a confirmed `change_dir` or successful `meta_sandbox_switch` repaints sandbox/cwd immediately, plus the host persists via `onSessionPatch`); context default **hidden** on missing usage, abort/cancel carries the prior honest value forward; host-ellipsized to the byte cap before the wire; `refreshGitStatusSlot` — host polls the read-only `GET /api/harness/status` probe on a ~10 s cadence **and** on-demand after a successful `exec` or `meta_sandbox_switch` mid-turn (not only the cadence), fail-soft keeps the last git value on transient error/429), `app/harness/HarnessHost.tsx` (Clear/New clears the pack; wires the git cadence + `onSessionPatch` → persist), `app/api/harness/status/route.ts` (read-only git probe: envelope-authoritative bind (`meta.activeSandboxId` wins over Redis-safe `?sandboxId=` carry), `resolveSandbox` → bounded argv-only read-only git at the bind workspace root via `lib/agent/statusProbe.ts`, per-instance rate cap `STATUS_PROBE_MIN_INTERVAL_MS`; middleware matcher + in-route `requireSessionUser` dual gate; never mutates a session/envelope — no Production write), `lib/agent/statusProbe.ts` (`STATUS_GIT_PROBE_OUT_MAX_BYTES`=512, fail-soft `{}`), `lib/sessionCloudCaps.ts` (`STATUS_SLOT_MAX_BYTES` = 96 + `STATUS_PROBE_MIN_INTERVAL_MS` = 2000 — client-safe single sources), **context/usage carrier:** `lib/agent/usageSummary.ts` (bounded provider-usage mapper `mapProviderUsage` / read-side `sanitizeUsageSummary` / host `formatUsageSummary`, `USAGE_SUMMARY_MAX_BYTES` = 96 — NEW cap), emitted **live mid-stream** from `finish` parts (aggregate only — never `finish-step` per-step counts) in `lib/agent/agentStream.ts` (SSE `usage` event), reconciled at the final `done.usage` / JSON result / chat result in `lib/agent/runAgent.ts` (+ `app/api/chat/route.ts`), parsed by `lib/agentApi.ts` / `lib/chatApi.ts`, mirrored on `SessionSnapshot.usage` (`lib/sessionStore.ts`; reserved cloud `meta.usage` JSON string, drop-to-unset on poison), docs: [docs/feature-divide.md](docs/feature-divide.md), [docs/harness-limits.md](docs/harness-limits.md), [docs/agent-stream.md](docs/agent-stream.md), [docs/session-model.md](docs/session-model.md) | |
| Tool-run aggregation + expandable transcript control (#325) | `lib/agent/agentStream.ts` (backend `tool_result.preview` — bounded/redacted L2 detail), `lib/toolRun.ts` (encode/decode, host aggregation, `meaningfulDetail` preview→`detail`, `mergeToolRunPayloads`/`encodeToolRunPayload` hydrate coalesce), `lib/harnessChat.ts` (stream/JSON aggregation → kind 6 `tool_run`, **live-painted**: a tool event opens/grows ONE card immediately via `update_last` — grouping keys off the host's `lastRingRowIsToolRun` flag, the only ring writer: grow iff the last ring row is a tool-run, else a NEW card at `1`; a thinking/assistant/user/error row last is a separator; commit-once is removed; reload coalescing of consecutive `tool_run` rows via `coalesceToolRunMessages` in `pushSessionToBridge`), `lib/sessionStore.ts` role `tool_run`, `native/harness/src/rich/toolrun.zig` (decode), `native/harness/src/ui/toolrun.zig` (`paintToolRun` — **headerless**: no `tools` kind band; 📋 copy on the header row; status glyphs as the single channel from embedded faces, `✓`/`✗` DejaVu symbols + `…` Noto; L2 preview in Vera Sans Mono for command/output tools **or any multi-line detail**, body otherwise; short single-line results → static label, no blank expander), `native/harness/src/bridge.zig` + `lib/harnessBridge.ts` (protocol **v11**; additive test-only ring readback `inv_message_*_at`), protocol **v11**; expand state + stick-to-bottom reuse dvui `reorder_tree.zig` / `scrolling.zig` idioms |

| Builtin HTTPS fetch (`http_get`) | `lib/agent/httpFetch*.ts`, `lib/agent/vercelSandboxHttpRunner.ts`, `lib/net/publicUrlPolicy.ts`, `docs/builtin-http.md` — always-available when a running HTTP instance exists; attach-only (Settings → Sandbox) |
| Tenancy schema / migrations | `db/schema.ts`, `db/migrations/` |
| Tenancy crypto / first-run bootstrap | `lib/tenancy/*` |
| Tenancy DB wiring (inject `db`/`connect`, never open your own) | `lib/di/index.ts` (composition root), `lib/di/withConnection.ts` (resolver), `lib/db` / `db/index.ts`; tests inject via `lib/tenancy/test/shared.ts` |
| Repo-wide I/O-construction gate | `scripts/di-gate.mjs`, `package.json` `test:di-gate` — bans in-body I/O construction (`createDbConnection(`/`new PGlite(` **and** the phase-2 sandbox/http/redis surface `Sandbox.get(`/`createClient(`/`new RedisSessionStore(`/`createSandboxClient(`/`createVercelSandboxClient(`/`createVercelSandboxHttpRunner(`) outside allowlisted roots (composition root + factory owners + grant-boundary lifecycle + test factories) |
| Sandbox / HTTP / Redis DI (phase 2) | `lib/di/index.ts` (composition root: `serverSecrets`, `createHttpRunner`, `createByoSandboxClient`, `createVercelFsSandboxClient`, `createSessionStore`); factory owners `lib/sandbox/client.ts`, `lib/sandbox/vercelClient.ts`, `lib/agent/vercelSandboxHttpRunner.ts`, `lib/sessions/redisSessionStore.ts`; grant-boundary attach `lib/tenancy/userSandboxInstance.ts` |
| Tenant BYOK / inference grants | `app/admin/inference/*`, `lib/tenancy/providerSecrets*`, `lib/tenancy/resolveInference*`, `lib/gateway/byokProviders.ts`, `app/api/models/*` |
| Tenant sandboxes (backend + image) | `app/admin/sandboxes/*`, `lib/tenancy/manageSandbox.ts`, `lib/tenancy/sandboxBackend.ts`, `lib/tenancy/resolveSandbox.ts`, `lib/sandbox/vercelClient.ts`, [docs/sandbox.md](docs/sandbox.md) |
| Vercel attach resilience (transient classify + bounded retry, both FS + hop-B) | `lib/sandbox/resilience.ts`, `lib/sandbox/vercelClient.ts`, `lib/agent/vercelSandboxHttpRunner.ts` — shared seam; BYO daemon (`lib/sandbox/client.ts`) is **untouched** |
| User durable Vercel instances (Settings create; agent attach-only) | `lib/tenancy/userSandboxInstance.ts`, `app/settings/sandbox/*`, `lib/sandbox/vercelClient.ts`, `lib/agent/vercelSandboxHttpRunner.ts`, `app/api/agent/route.ts`, guard `lib/tenancy/sandboxCreateGuard.test.ts`, orphan GHA `sandbox-orphan-cleanup`, [docs/sandbox.md](docs/sandbox.md), [docs/builtin-http.md](docs/builtin-http.md) — **never** `Sandbox.create` / `getOrCreate` outside `userSandboxInstance` |
| User agent personas (backend + data, phase 1) | `db/schema.ts` `user_personas` + `user_persona_versions` (version history, plan #726), `db/migrations/0010_user_personas.sql` + `0015_user_persona_versions.sql` (journal idx 15), `lib/tenancy/userPersonas.ts` (injected `db`/`connect`; **no DEK** — bodies are non-secret user content; create/update_body capture append-only body versions to `user_persona_versions`, capped `PERSONA_VERSION_MAX`=100; `listPersonaVersions`/`getPersonaVersion`/`rollbackPersona` for Settings Restore), `app/api/personas/route.ts` (GET summaries, no body), `app/api/settings/personas/[id]/versions` + `[versionId]` + `rollback` (REST gate `requireUserId`, mirror skills), `lib/agent/agentBody.ts` (`parsePersonaId`), `lib/sessionCloudCaps.ts` / `lib/sessions/sessionStore.ts` (reserved `meta.{personaId,personaSnapshot}`, `PERSONA_SNAPSHOT_MAX_BYTES`=512 KiB, `HARNESS_SESSION_MAX_META_BYTES`=1 MiB, `PERSONA_VERSION_MAX`=100), `middleware.ts` | |
| User agent skills (backend + data, phase 1) | `db/schema.ts` `user_skills`, `db/migrations/0011_user_skills.sql`, `lib/tenancy/userSkills.ts` (injected `db`/`connect`; **no DEK** — bodies are non-secret user content; slug RE `^[a-z][a-z0-9_-]{0,127}$` hyphen-allowed), `app/api/skills/route.ts` (GET summaries, no body), `lib/di/index.ts` (wire `createUserSkills`), `middleware.ts` (`isApiProtected` + matcher — `/api/skills` on the auth edge), `middleware.test.ts` | |
| User agent skills — Settings CRUD UI (phase 2) | `app/settings/skills/{page,SkillForm}.tsx` + `app/settings/skills/actions.ts` (server actions on `services.userSkills`: create + auto-slug (`slugFromName`) + dedupe, `updateUserSkillSummary` for name+description, `updateUserSkillBody` for body, `deleteUserSkill`; slug **immutable** on rename; owner-own body prefilled server-side via `getSkillBySlug`, discovery stays summaries-only), `app/settings/ui.ts` (`SETTINGS_NAV` Skills link), `app/settings/skills/actions.test.ts`, `app/settings/skills/data-contract.test.ts`, docs: [docs/skills.md](docs/skills.md) | |
| User agent skills — attach/injection + Wasm display (phase 2 #517) | `lib/tenancy/skillInject.ts` (slash parse `/skill-name` + `/unskill`, `getSkillBySlug` resolve, session-sticky `meta.attachedSkills` re-resolve; fail-closed unknown/foreign, offline-safe store), `lib/tenancy/harnessSessions.ts` + `lib/sessionStore.ts` role `skill_attached`, `lib/agent/runAgent.ts` (`skillsPreamble` appended after persona), `app/api/agent/route.ts` (strip `/slug`, no-model `/unskill` turn, SSE `skill_attached` + JSON `skillEvents`/`attachedSkills`), `lib/agent/agentStream.ts` (`skill_attached` event), `lib/agentApi.ts` (client-safe `skillEvents`), `lib/harnessBridge.ts` (`MessageKind.SkillAttached = 7`, protocol **v12**), `lib/harnessChat.ts` (`roleToKind` + `skillRowText`/`pushSkillRow` display-only, JSON + SSE), `native/harness/src/{bridge,ui}.zig` + `rich/kinds.zig` (`skill_attached = 7`, `paintSkillAttached`), docs: [docs/skills.md](docs/skills.md), [docs/session-model.md](docs/session-model.md) | |
| User agent skills — agent tool surface (phase 3 #516) | `lib/agent/skillTools.ts` (`createSkillTools({userId,userSkills})` → read-only `find_skill` (bounded summaries search, `SKILL_FIND_RESULT_MAX`=20) + `fetch_skill` (user-scoped body by slug, model-returned body capped `SKILL_FETCH_MAX_RETURN_BYTES`=256 KiB with truncation marker; `not_found` no-existence-leak), bound to route `userId` (confused-deputy guard), AI SDK `tool`/`jsonSchema` shape), assembled into `extraTools` in `app/api/agent/route.ts` always (independent of sandbox state; soft-path 403 fallback ignores these so a skill-only turn never masks a workspace-absent/grant-deny), `lib/agent/runAgent.ts` (`resolveSystem` `hasSkill` → `SKILL_TOOLS_ONLY_SYSTEM`; pick-criteria on each `find_skill`/`fetch_skill` `tool.description` (not a system addendum)), caps in `lib/sessionCloudCaps.ts`, docs: [docs/skills.md](docs/skills.md) | |
| User agent personas + skills — built-in meta authoring tools (phase 1 #531) | `lib/agent/metaTools.ts` (`createMetaPersonaSkillTools({userId,userPersonas,userSkills})` → first-party **write** tools (`meta_persona_*`: list/read/create/update_name/update_body/set_default/clear_default/delete; `meta_skill_*`: list/read/create/update_summary/update_body/str_replace/delete), **always-on** on `/api/agent`, bound to route `userId` (ignores model-passed identity; stores are tenant+user scoped → `not_found` no-existence-leak), in-process AI SDK `tool`/`jsonSchema` (NOT a remote MCP transport), author-as-user auto-confirm (same as Settings), no flags; slug derived in the tool layer when omitted (stores require a slug on create); bodies returned to the model only on explicit `*_read`, capped (skills `SKILL_FETCH_MAX_RETURN_BYTES` truncation marker; personas at store body cap), writes over-cap rejected (never truncate). **`meta_skill_str_replace`** (plan for #600) patches a skill body **by id** with a **literal exact-text** `old_string`→`new_string` (optional `replace_all`) for output-token-safe editing of large bodies: replacement is built `split`/`join` + slice (mirrors sandbox `lib/sandbox/vercelClient.ts` `strReplace`), **never** `String.prototype.replace`, so `$`-template / regex metacharacters land verbatim; 0-match & ambiguous `>1`-without-`replace_all` error (no write); empty `old_string` error; each fragment capped `META_SKILL_FRAGMENT_MAX_BYTES` (64 KiB, `lib/sessionCloudCaps.ts`), resulting body re-validated against the 4 MiB store write cap (rejected, never truncated); resolves the target via the new **`getSkillById`** store seam (`lib/tenancy/userSkills.ts`, mirrors `getPersonaById`, tenant+user scoped, full stored body server-side regardless of read cap, non-UUID id fails closed to null); result is a one-liner (no body echo); assembled into `extraTools` in `app/api/agent/route.ts` always; `lib/agent/runAgent.ts` (`resolveSystem` `hasMeta` → `SKILL_META_ONLY_SYSTEM`; pick-criteria on each `meta_*` `tool.description` (not a system addendum)); the route soft-path guard excludes `meta_*` keys via `isMetaToolName` (`nonSkillToolCount`); docs: [docs/mcp.md](docs/mcp.md), [docs/personas.md](docs/personas.md), [docs/skills.md](docs/skills.md) | |
| User agent sandboxes — built-in meta bind tools (phase 2 #532) | `lib/agent/metaSandboxTools.ts` (`createMetaSandboxTools({userId,sessionId,userPreferredSandbox,sessionStoreSeam})` → `meta_sandbox_list` (non-secret projection mirroring `GET /api/sandboxes.options`), `meta_sandbox_active` (persisted `meta.activeSandboxId` when a usable grant, else null, + `describeSandboxTools` surface), `meta_sandbox_switch` (persist `meta.activeSandboxId` to the caller's **own** session envelope → `resolveSessionStore` → `isEnvelopeStore` → `readEnvelope`/`upsertEnvelope`, `updatedAt` preserved, fail-closed no-partial-write on non-Redis-safe id / unusable-un-granted grant / missing sessionId / unavailable-or-non-envelope store), **always-on** on `/api/agent`, bound to route `userId`/`sessionId` (ignores model-passed identity), in-process AI SDK tools, no secrets (`base_url`/token never leave server); assembled into `extraTools` in `app/api/agent/route.ts` (seam = `resolveSessionStore()` + `services.harnessSessionsRedis.resolveTenantIdForUser`); `lib/agent/runAgent.ts` does not fold `META_SANDBOX_SYSTEM_ADDENDUM` into `resolveSystem`; pick-criteria live on each `meta_sandbox_*` `tool.description`; docs: [docs/mcp.md](docs/mcp.md), [docs/sandbox.md](docs/sandbox.md), [docs/session-model.md](docs/session-model.md) | |
| User personas — injection + session model (phase 3 #488) | `lib/tenancy/personaInject.ts` (server-side snapshot resolver, injected session-store seam), `lib/agent/agentBody.ts` (`personaId` **+ `sessionId`**), `lib/agentApi.ts` + `lib/harnessChat.ts` (fold `sessionId`/`personaId` into the agent body), `lib/agent/runAgent.ts` (`resolveSystem` `personaPreamble`), `app/api/agent/route.ts` (session-store snapshot lookup + snapshot-once), `app/api/sessions/route.ts` (mint accepts optional `personaId` → `meta.personaId`), `app/harness/HarnessHost.tsx` + `app/components/SessionPicker.tsx` (New session = Clear alias, binds default persona; Continue preserves), `lib/sessionStore.ts` + `lib/sessionRepository.ts` (`personaId` carrier via `meta.personaId`), docs: [docs/personas.md](docs/personas.md), [docs/session-model.md](docs/session-model.md) | |
| User Settings / per-user MCP | `app/settings/*`, `lib/tenancy/userMcpServers.ts`, `lib/mcp/*` |
| User GitHub PAT (Settings + sandbox exec inject) | `app/settings/github/*`, `lib/tenancy/userGithubToken.ts`, `lib/sandbox/{client,vercelClient}.ts`, `sandbox/tools.mjs`, `app/api/agent/route.ts`, [docs/sandbox.md](docs/sandbox.md) |
| User preferred sandbox (Settings) + session-owned active binding + inventory/tool-surface API | `app/settings/sandbox/*`, `lib/tenancy/userPreferredSandbox.ts`, `lib/tenancy/resolveSandbox.ts` (`init.requestedSandboxId` override), `lib/tenancy/sandboxTools.ts` (`describeSandboxTools`), `app/api/sandboxes/route.ts` (`GET /api/sandboxes`; middleware + in-route `requireSessionUser`), `lib/agent/agentBody.ts` (`sandboxId`), `lib/harnessChat.ts`/`lib/agentApi.ts` (fold + reconcile), [docs/sandbox.md](docs/sandbox.md), [docs/session-model.md](docs/session-model.md) |
| Harness model catalog (protocol v3) + **selected-model persistence (protocol v16)** | `lib/harnessBridge.ts`, `native/harness/src/bridge.zig` (`inv_set_selected_model` restore-by-id + `inv_has_pending_model_change`/`inv_ack_pending_model_change` for a user Next cycle), `app/harness/HarnessHost.tsx` (boot/adopt/switch restore-by-id, Next-cycle fold, New/Clear reset), `lib/sessionStore.ts` + `lib/sessionRepository.ts` + `lib/sessions/sessionStore.ts` (reserved `meta.selectedModel`; `sanitizeModelId` ≤ 128 B in `lib/sessionCloudCaps.ts`, single TS source, Zig `MAX_MODEL_ID_LEN` parity-locked), [docs/session-model.md](docs/session-model.md), [docs/feature-divide.md](docs/feature-divide.md) |
| Session list in the transcript rail (protocol **v17**) | `native/harness/src/session_catalog.zig` + `transcript_split.zig` (paint), `lib/harnessBridge.ts` (`setSessionCatalog` / `takePendingSessionSwitch`), `lib/sessionSummaryLabel.ts` (label + pin-current slice), `app/harness/HarnessHost.tsx` (push + poll), `app/components/SessionPicker.tsx` (New-only). Host lists via `GET /api/sessions`; Wasm never talks to Redis/Blob. Caps: `HARNESS_SESSION_RAIL_MAX`=256, `HARNESS_SESSION_LABEL_MAX_BYTES`=128 |
| Schema-only migrate (GHA) | `.github/workflows/db-migrate.yml` — `scripts/drizzle-journal-gate.mjs` fail-closes if `db/migrations/*.sql` is missing from `meta/_journal.json` (silent no-op #735) |
| Dogfood sandbox image (VCR) | `dev/Dockerfile`, `dev/README.md`, `.github/workflows/dev-image-build.yml`, [docs/sandbox.md](docs/sandbox.md) |
| Sandbox daemon | `sandbox/` — `exec` is argv-only (no shell); client `/v1/exec` HTTP abort follows request `timeoutMs` + `EXEC_TIMEOUT_BUFFER_MS`, not a fixed 45 s; `GET /health` returns the per-binding jail root `workspaceRoot` (daemon v2) and **omits it when the jail root is unresolvable** (still 200 + `version`/`daemonVersion`; liveness never blanked) ([docs/sandbox.md](docs/sandbox.md)) |
| Sandbox daemon version + out-of-date gate + auto-update | `sandbox/constants.mjs` (`INVINCIBLE_SANDBOX_DAEMON_VERSION`), `lib/sandbox/daemonVersion.ts` (`EXPECTED_SANDBOX_DAEMON_VERSION`), `lib/sandbox/client.ts`, `sandbox/createServer.mjs`, `sandbox/autoUpdate.mjs`, `sandbox/server.mjs` — bump **both** version constants in the **same PR** (parity test blocks drift); a bump is required whenever deployed Next relies on a new daemon surface (e.g. **v2** adds `workspaceRoot` to `/health`); see [docs/sandbox.md §3 daemon-version gate](docs/sandbox.md) |
| Colors / tokens (DOM) | `lib/palette.ts` |
| Colors / tokens (dvui) | `native/harness/src/palette.zig` (hex sync with palette.ts) |
| JS ↔ Wasm bridge | `lib/harnessBridge.ts` + `native/harness/src/bridge.zig` — **frame budget** (no app alloc / host I/O in `ui.frame()`): [docs/harness-limits.md](docs/harness-limits.md) · Frame budget |
| Plans / ops | `docs/*` (living guides); **new plans → GitHub issues** via create-plan |
| Agent skills | `.grok/skills/*` |

## Palette (imported from Asteronica / webgpu-game)

**Source of truth (DOM):** `lib/palette.ts`  
**Source of truth (dvui Wasm):** `native/harness/src/palette.zig` — same TEAL/WARM/EMBER hex; keep in sync.

### Families

| Family | Role | Anchor |
|--------|------|--------|
| **TEAL** | Primary UI chrome, backgrounds, borders, readable text, interactive accents | `teal.*` CSS tokens + `TEAL_PALETTE` |
| **WARM** | Complementary amber `#D47C2C` — secondary highlights, CTAs, success/emphasis | `warm.*` + `WARM_PALETTE[6]` |
| **EMBER** | Red-orange `#D4412C` — **danger / error**, plus intentional **unified-diff removed lines** in Wasm rich paint | `ember.*` + `EMBER_PALETTE[6]` |

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
4. **EMBER** = **danger** (API errors, destructive confirm, invalid state). Never for normal chrome, success, or links. **Exception:** Wasm rich transcript `diff`/`patch` fence **deleted (`-`) lines** use `ember_text` as *removed-line* semantics (not error chrome) — see `native/harness/src/rich/paint_diff.zig` / `docs/harness-limits.md`.
5. Do **not** invent coral / orange / red outside `warm` / `ember`.
6. Palette ramps and CSS token objects are **golden** — do not renumber or recolor casually. `lib/palette.test.ts` locks values.
7. Prefer `teal.*` / `warm.*` / `ember.*` for DOM styles; Zig uses matching hex in `palette.zig`.

### Forbidden examples

- `#e87a5c`, `#f0a090`, Tailwind orange/red/blue defaults
- Pure blue/cyan backgrounds or accents
- Using `ember` for non-error UI (except documented diff removed-line paint in harness rich transcript)
- Hardcoding `#2dd4bf` instead of `teal.accent` (literals drift)

## Feature divide

**Wasm is the harness; DOM is host shell only.** See [`docs/feature-divide.md`](docs/feature-divide.md).

| DOM host shell | Wasm harness | Vercel backend |
|----------------|--------------|----------------|
| Nav, load module, bridge glue, SessionStore + cloud session repo | Transcript, composer, agent chrome | `/api/chat`, `/api/agent`, `/api/sessions`, AI Gateway, secrets |
| No competing chat panel | Primary multi-turn UX | Server-only inference + optional sandbox tools |

Do **not** rebuild a React agent chat panel as product UI.  
Do **not** put Gateway or sandbox secrets in client or Wasm.  
See create-plan / plan-review **layer** rules when planning features.

## Working rules

- Zig compile **only** on the configured self-hosted runner (`build-harness.yml`; origin sample `invincible-do-1`). After harness source changes: CI → artifact → Vercel (wait-for-SHA prebuild + deploy hook).
- Inference stays server-side (`POST /api/chat` / `POST /api/agent`). No Gateway or sandbox secrets in client or Wasm.
- Agent sandbox is a **separate process** from the Zig GHA runner — see [`docs/sandbox.md`](docs/sandbox.md).
- Prefer extending `native/harness` + `HarnessHost` over new infra.
- **Harness frame budget:** app code in `dvui_update` → `ui.frame()` must not GPA-allocate or do host I/O. Parse / decode / texture belong on the **bridge write** (`inv_push_message` / `inv_update_last` / `inv_*_cache_put`), not paint. Contract + current exceptions: [docs/harness-limits.md](docs/harness-limits.md) · Frame budget.
- **Tests are run directly with vitest — no script wrappers allowed.** Never
  introduce or use a wrapper script around vitest, and do not re-add one if it was
  removed. Run the suite with `npm test` (= `node scripts/di-gate.mjs && node scripts/drizzle-journal-gate.mjs && vitest run --project default --project tenancy` —
  di-gate and drizzle-journal-gate each run first so in-body `createDbConnection(`/`new
  PGlite(`/sandbox/http/redis I/O construction and a `db/migrations` SQL↔journal
  mismatch each fail before vitest) or invoke vitest through the **local** binary directly
  (`node_modules/vitest/vitest.mjs run`, never `npx`)
  with an explicit exec timeout (`timeoutMs ≈ 600000`) — a long run can drop over
  the transport but still complete. For a fast mechanical gate that only tests files
  changed since `HEAD`, use `npm run test:changed` (= `vitest run --changed --project default --project tenancy` — same `--project` flags as `npm test`; vitest 3 runs every `test.projects` entry otherwise).
  `vitest run` **exits non-zero on any failure**; trust the exit code and the
  per-file output, never a summarized/hidden log. Run `npm run typecheck` /
  `npm run build` before claiming ready (**agent workspace or CI**; build needs
  token or existing `public/harness`). The **real-Wasm integration suite**
  (`lib/harnessChat.wasm-int.test.ts`) loads `public/harness/harness.wasm` (then
  `native/dist/harness/harness.wasm`) via the protocol-v11 ring-readback seam and
  **fails closed** (throws, never `it.skip`) when the Wasm is missing or is a
  stale pre-v11 artifact — build native/harness on the runner
  (`build-harness`) and fetch via `scripts/fetch-harness-artifact.mjs` before
  expecting those rows green. The durable-turn int project (`npm run test:int` =
  `vitest run --project int`) is **not** in `npm test` — vitest runs every
  `test.projects` entry unless `--project` is passed. It fail-closes on missing
  `harness.wasm` via a green load test (throw, never `it.skip`); known-broken
  persist/boot contracts wrap only those expects in `it.fails`.
  Naked `node_modules/vitest/vitest.mjs run` (merge-pr / local-binary line
  above) collects **every** `test.projects` entry, including `int` — that is
  extra wasm + `it.fails` on the full merge-green suite, not a second supply
  gate (`lib/harnessChat.wasm-int.test.ts` already fail-closes without wasm).
- **Module bodies never construct I/O directly.** Server modules receive live
  handles or factory providers (DB: `db`/`connect`; sandbox: BYO/Vercel client
  factories; HTTP: runner factory; sessions: store factory) through an injection
  seam; they never call `createDbConnection()`, `new PGlite()`, `Sandbox.get()`,
  `createClient()`, `new RedisSessionStore()`, `createSandboxClient()`,
  `createVercelSandboxClient()`, `createVercelSandboxHttpRunner()`, or a backend
  `fetch` in their own body. Production wiring is the sole job of the composition
  root `lib/di/index.ts` (plus the factory-owner modules and the durable-instance
  grant-boundary `lib/tenancy/userSandboxInstance.ts`). Enforced by
  `npm run test:di-gate` (`scripts/di-gate.mjs`), which fails any in-body I/O
  constructor outside the allowlisted roots (composition root + factory owners +
  `lib/tenancy/userSandboxInstance.ts` + `scripts/sandbox-orphan-cleanup.mjs` +
  `lib/mcp/client.ts` (MCP-deferred) + `lib/tenancy/test/shared.ts` + test files).
- **Tenancy tests share one engine.** `lib/tenancy/**` runs via a tenancy-scoped
  vitest `projects` entry in `vitest.config.ts` (`forks.singleFork` +
  `isolate:false`), so the single PGlite booted in `lib/tenancy/test/shared.ts`
  is shared across test files; each file resets via `resetTenantTables()`. The
  only `new PGlite(` in the repo is in `lib/tenancy/test/shared.ts`. Do **not**
  boot a fresh PGlite in a per-file `beforeAll` (git-gated by `test:di-gate`).
- No secrets in repo; Vercel / GitHub secrets only.
- Ops instructions for humans: **Vercel / browser / cloud agent** only — never
  “install Node on your laptop” or “clone this path on your machine.”

## Do not

- Commit real API keys or `public/harness/*.wasm|web.js`
- Bypass palette for “temporary” colors
- Use pure blue/cyan or coral one-offs
- Grow a second unrelated color module
- Ask the **origin** maintainer to configure deploy hooks / tokens that are already listed as **Done** above (forks: use [`docs/bring-your-own.md`](docs/bring-your-own.md))
- Tell humans to use a **personal laptop/desktop** for product ops (clone, migrate, npm). Use cloud agent workspaces, GitHub Actions, or Vercel instead.
