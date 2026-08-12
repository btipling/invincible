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
| Run `npm test` / migrate / seed / backfill **in the agent workspace or GHA** when needed | Treat “local” as the human’s personal computer |
| Prefer **cloud-native cutover** paths (**Actions `workflow_dispatch` primary**, then agent-run scripts, hosted DB) | Document laptop-only ops **or script-only npm** as the primary Production path |

“Local” in this file means **the agent’s or CI’s checkout**, not a developer’s
home directory. Product copy and plans must not require personal hardware.

**Plans are not enough if they only say “run npm.”** A sentence here is not an
operator surface. Any Production **data/secret mutate** (migrate, seed, backfill,
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
  do **not** use seed/bootstrap for that (seed resets password + token). Dual-read
  keeps Production working until the operator dispatches backfill + optional
  `TENANT_TOKEN_DECRYPT_MODE=dek-only`. Never laptop npm as the official cutover.
- **Tenant BYOK inference** is on `main`: admin **`/admin/inference`**, `GET /api/models`, harness protocol v3 model cycle, chat/agent request-scoped BYOK. **Never** route via a host env-model fallback. Additive schema for provider tables: GHA **`db-migrate`** (not seed). Docs: [docs/bring-your-own.md](docs/bring-your-own.md) §4a Inference keys.

- Do **not** instruct humans to clone the repo on a laptop to re-seed; use a
  cloud agent workspace, GitHub Actions `db-tenancy-bootstrap`, or
  [docs/bring-your-own.md](docs/bring-your-own.md) §4a.


## Project agent skills

Load from **this repo** via `gh` (not generic template skills). Zero-search:

| Skill | Path on `main` | Use when |
|-------|----------------|----------|
| **create-plan** | `.grok/skills/create-plan/SKILL.md` | “use create-plan”, feature plans as **GitHub issues**, parent + phase issues; locks **cloud ops (GHA)** + **living docs** |
| **plan-review** | `.grok/skills/plan-review/SKILL.md` (+ `LOAD.md`, `references/*`) | Review a plan **issue**; default edit issue body via `gh`; scores cloud ops + living docs |
| **adversarial-review** | `.grok/skills/adversarial-review/SKILL.md` (+ `LOAD.md`, `references/*`) | Hostile **PR** review; break scenarios; post comment via `gh` |
| **cleanup-sandbox** | `.grok/skills/cleanup-sandbox/SKILL.md` (+ `LOAD.md`) | Post-session hygiene: checkout + pull latest `main`, delete leftover local branches / agent scratch; **refuses** to discard current uncommitted work without explicit operator consent |
| **implement-plan** | `.grok/skills/implement-plan/SKILL.md` (+ `LOAD.md`) | Code a reviewed plan into a **non-merged PR** + tests; canonical test/build workflow (`npm run typecheck`, `node run-tests.mjs`), in-sandbox exec rules, layer ownership, code standards |

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
| `HARNESS_ARTIFACT_TOKEN` (Vercel) | **Done** | PAT Actions: Read — prebuild downloads `harness-wasm` |
| `VERCEL_DEPLOY_HOOK_URL` (GitHub secret) | **Done** | deploy hooks; `build-harness` pings after artifact upload |
| DO runner `invincible-do-1` labels `invincible`,`zig` | **Done** | Zig 0.16.0 only there |
| `SANDBOX_URL` / `SANDBOX_TOKEN` (Vercel) | **Done** | Agent sandbox on origin Production — see [docs/sandbox.md](docs/sandbox.md); host inventory private; never invent a host URL |
| `DATABASE_URL` (Vercel) | **Done** | Pooled Postgres (Neon) for required multi-tenant auth — Production cutover smoke passed (unauth 401 + login); no host inventory in git |
| `AUTH_SECRET` (Vercel) | **Done** | Auth.js signing secret — Production cutover smoke passed |
| `CREDENTIALS_ENCRYPTION_KEY` (Vercel) | **Done** | AES-GCM AMK wrapping per-tenant DEKs (tokens under DEK; dual-read cutover) — dual-store with GHA; never reuse casually on public Preview. Owner DEK rotate via `/admin`. Existing-data backfill: GHA `db-tenancy-backfill-deks`. Do not rotate Production AMK without re-wrap tool |
| Optional OIDC (`AUTH_OIDC_ISSUER` / `AUTH_OIDC_CLIENT_ID` / `AUTH_OIDC_CLIENT_SECRET` / `AUTH_OIDC_LABEL?`) | **Not Done** | Generic SSO — configure when operator wants IdP login; callback `{origin}/api/auth/callback/oidc`; BYO: [docs/bring-your-own.md](docs/bring-your-own.md) §4b |
| Optional SCIM (`SCIM_BEARER_TOKEN`) | **Not Done** | SCIM 2.0 Users at `/api/scim/v2` — set only when directory provisioning is intended; fail-closed 404 when unset |


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
  not a greenfield cutover. Prefer cloud cutover docs
  ([docs/bring-your-own.md](docs/bring-your-own.md) §4a) and GHA
  `db-tenancy-bootstrap` for re-seed (resets bootstrap password + token
  ciphertext by design) or GHA `db-tenancy-backfill-deks` for legacy AMK→DEK
  data cutover (never seed for that). Public smoke: `npm run smoke:tenancy`.
- Per-user **MCP** code is on `main` (Settings + agent merge). Schema on Production still needs GHA **`db-migrate`** when `user_mcp_servers` is missing. Operator smoke: [docs/mcp.md](docs/mcp.md) (Exa). Never put MCP API keys or user GitHub PATs in client/Wasm/git.
- Optional **OIDC / SCIM** on origin are **Not Done** until an operator sets env
  and smokes. Do **not** claim they are configured, invent IdP URLs, or nag to
  “enable SSO” as a forgotten secret. When configuring: follow
  [docs/bring-your-own.md](docs/bring-your-own.md) §4b; never put
  `AUTH_OIDC_CLIENT_SECRET` or `SCIM_BEARER_TOKEN` in client/Wasm or git.


IDs and URLs (maintainer sample): [`docs/project-ids.md`](docs/project-ids.md).  
BYO: [`docs/bring-your-own.md`](docs/bring-your-own.md). Sandbox: [`docs/sandbox.md`](docs/sandbox.md).  
MCP: [`docs/mcp.md`](docs/mcp.md). Builtin HTTP: [`docs/builtin-http.md`](docs/builtin-http.md).  
Runner ops: [`docs/runner.md`](docs/runner.md). Security: [`SECURITY.md`](SECURITY.md).

## Public repository policy

- Do **not** commit host IPs, droplet IDs, or cloud account GUIDs.
- Self-hosted workflows: default `workflow_dispatch` or `push` to `main`. **`build-harness` only** also runs **same-repo** contributor `pull_request` → `main` (not forks; no `pull_request_target`; no Vercel deploy hook on PR). Other self-hosted workflows stay main/dispatch only.
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
├── scripts/             # fetch-harness, seed-tenancy, runner scripts
├── docs/                # BYO, sandbox, mcp, builtin-http, feature-divide, limits, deploy race
├── public/harness/      # wasm/js gitignored; README only committed
├── AGENTS.md
└── package.json
```

| Kind of change | Where |
|----------------|--------|
| UI page / layout | `app/` |
| API / AI Gateway / agent | `app/api/*`, `lib/agent/*`, `lib/sandbox/*` |
| Agent SSE stream (tools + text + reasoning) | `lib/agent/agentStream.ts`, `lib/agent/runAgent.ts`, `lib/agent/reasoningConfig.ts`, `app/api/agent/route.ts`, `lib/agentApi.ts`, `docs/agent-stream.md` |
| Agent read-before-edit / file freshness | `lib/agent/fileFreshness.ts`, `lib/agent/tools.ts`, `lib/agent/runAgent.ts`, [docs/sandbox.md](docs/sandbox.md) |
| Logical agent cwd (`change_dir` / session / default env) | `lib/agent/workPath.ts`, `lib/agent/tools.ts`, `lib/agent/agentBody.ts`, `lib/sandbox/config.ts` (`SANDBOX_DEFAULT_CWD`), `lib/sessionStore.ts`, `lib/harnessChat.ts`, `lib/agentApi.ts`, [docs/sandbox.md](docs/sandbox.md), [docs/session-model.md](docs/session-model.md), [docs/agent-stream.md](docs/agent-stream.md) |
| Cloud multi-device harness session (`/api/session`, hybrid local+cloud) | `app/api/session/*`, `lib/sessionRepository.ts`, `lib/sessionCloudCaps.ts`, `lib/tenancy/harnessSessions.ts`, `app/harness/HarnessHost.tsx`, `middleware.ts` (`/api/session`), [docs/session-model.md](docs/session-model.md), [SECURITY.md](SECURITY.md) — schema: GHA **`db-migrate`** |
| Harness stream chrome (Thinking collapse/caps, live tools) | `lib/harnessChat.ts`, `native/harness/src/ui.zig` (Thinking kind), protocol v10 in `lib/harnessBridge.ts` (Stop cancel v9; Thinking kind v8; tool-run kind 6 v10) |
| Tool-run aggregation + expandable transcript control (#325) | `lib/agent/agentStream.ts` (backend `tool_result.preview` — bounded/redacted L2 detail), `lib/toolRun.ts` (encode/decode, host aggregation, `meaningfulDetail` preview→`detail`, `mergeToolRunPayloads`/`encodeToolRunPayload` hydrate coalesce), `lib/harnessChat.ts` (stream/JSON aggregation → kind 6 `tool_run`; grouping keys off last-UI/bridge row state `lastUiKind` — thinking continues a streak, commit-once, reload coalescing of consecutive `tool_run` rows via `coalesceToolRunMessages` in `pushSessionToBridge`), `lib/sessionStore.ts` role `tool_run`, `native/harness/src/rich/toolrun.zig` (decode), `native/harness/src/ui.zig` (`paintToolRun` — **headerless**: no `tools` kind band; 📋 copy on the header row; status glyphs as the single channel from embedded faces, `✓`/`✗` DejaVu symbols + `…` Noto; L2 preview in Vera Sans Mono for command/output tools **or any multi-line detail**, body otherwise; short single-line results → static label, no blank expander), protocol **v10**; expand state + stick-to-bottom reuse dvui `reorder_tree.zig` / `scrolling.zig` idioms |
| Builtin HTTPS fetch (`http_get`) | `lib/agent/httpFetch*.ts`, `lib/agent/vercelSandboxHttpRunner.ts`, `lib/net/publicUrlPolicy.ts`, `docs/builtin-http.md` — env `BUILTIN_HTTP_FETCH`; user-created HTTP instance attach-only (Settings → Sandbox) |
| Tenancy schema / migrations | `db/schema.ts`, `db/migrations/` |
| Tenancy crypto / seed helpers | `lib/tenancy/*`, `scripts/seed-tenancy.ts` |
| Tenant BYOK / inference grants | `app/admin/inference/*`, `lib/tenancy/providerSecrets*`, `lib/tenancy/resolveInference*`, `lib/gateway/byokProviders.ts`, `app/api/models/*` |
| Tenant sandboxes (backend + image) | `app/admin/sandboxes/*`, `lib/tenancy/manageSandbox.ts`, `lib/tenancy/sandboxBackend.ts`, `lib/tenancy/resolveSandbox.ts`, `lib/sandbox/vercelClient.ts`, [docs/sandbox.md](docs/sandbox.md) |
| Vercel attach resilience (transient classify + bounded retry, both FS + hop-B) | `lib/sandbox/resilience.ts`, `lib/sandbox/vercelClient.ts`, `lib/agent/vercelSandboxHttpRunner.ts` — shared seam; BYO daemon (`lib/sandbox/client.ts`) is **untouched** |
| User durable Vercel instances (Settings create; agent attach-only) | `lib/tenancy/userSandboxInstance.ts`, `app/settings/sandbox/*`, `lib/sandbox/vercelClient.ts`, `lib/agent/vercelSandboxHttpRunner.ts`, `app/api/agent/route.ts`, guard `lib/tenancy/sandboxCreateGuard.test.ts`, orphan GHA `sandbox-orphan-cleanup`, [docs/sandbox.md](docs/sandbox.md), [docs/builtin-http.md](docs/builtin-http.md) — **never** `Sandbox.create` / `getOrCreate` outside `userSandboxInstance` |
| User Settings / per-user MCP | `app/settings/*`, `lib/tenancy/userMcpServers.ts`, `lib/mcp/*` |
| User GitHub PAT (Settings + sandbox exec inject) | `app/settings/github/*`, `lib/tenancy/userGithubToken.ts`, `lib/sandbox/{client,vercelClient}.ts`, `sandbox/tools.mjs`, `app/api/agent/route.ts`, [docs/sandbox.md](docs/sandbox.md) |
| User preferred sandbox (Settings) | `app/settings/sandbox/*`, `lib/tenancy/userPreferredSandbox.ts`, `lib/tenancy/resolveSandbox.ts`, [docs/sandbox.md](docs/sandbox.md) |
| Harness model catalog (protocol v3) | `lib/harnessBridge.ts`, `native/harness/src/bridge.zig`, `app/harness/HarnessHost.tsx` |
| Schema-only migrate (GHA) | `.github/workflows/db-migrate.yml` |
| Dogfood sandbox image (VCR) | `dev/Dockerfile`, `dev/README.md`, `.github/workflows/dev-image-build.yml`, [docs/sandbox.md](docs/sandbox.md) |
| Sandbox daemon | `sandbox/` — `exec` is argv-only (no shell); client `/v1/exec` HTTP abort follows request `timeoutMs` + `EXEC_TIMEOUT_BUFFER_MS`, not a fixed 45 s ([docs/sandbox.md](docs/sandbox.md)) |
| Sandbox daemon version + out-of-date gate + auto-update | `sandbox/constants.mjs` (`INVINCIBLE_SANDBOX_DAEMON_VERSION`), `lib/sandbox/daemonVersion.ts` (`EXPECTED_SANDBOX_DAEMON_VERSION`), `lib/sandbox/client.ts`, `sandbox/createServer.mjs`, `sandbox/autoUpdate.mjs`, `sandbox/server.mjs` — bump **both** version constants in the **same PR** (parity test blocks drift); see [docs/sandbox.md §3 daemon-version gate](docs/sandbox.md) |
| Colors / tokens (DOM) | `lib/palette.ts` |
| Colors / tokens (dvui) | `native/harness/src/palette.zig` (hex sync with palette.ts) |
| JS ↔ Wasm bridge | `lib/harnessBridge.ts` + `native/harness/src/bridge.zig` |
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
| Nav, load module, bridge glue, SessionStore + cloud session repo | Transcript, composer, agent chrome | `/api/chat`, `/api/agent`, `/api/session`, AI Gateway, secrets |
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
  In a cloud agent workspace where a full `npm test` stream drops over the exec
  transport, prefer `npm run test:full` (= `node run-tests.mjs`) for the full
  suite — it writes a one-line summary and **exits non-zero on any failure**
  (see `run-tests.mjs` / the implement-plan skill).
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
