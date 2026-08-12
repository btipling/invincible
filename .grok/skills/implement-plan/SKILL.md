---
name: implement-plan
description: >
  Turn a HANDOFF-READY plan issue into shippable code + tests for Invincible.
  Use when the user says "implement this plan", "implement issue #N", "code the
  plan", or after plan-review gives the go. Covers reading the plan, grounding in
  live code, the project's test/build workflow (how to run tests correctly in an
  agent workspace or CI), layer ownership (DOM / harness / Vercel backend), and
  the tested, reproducible way to verify before opening a PR. Requires gh.
  Does NOT merge: stops at PR open + merge-ready. READ-ONLY of skill is via gh.
metadata:
  short-description: "Code a reviewed plan: tests + build workflow + PR, no merge"
  version: "1.0"
  project: invincible
---

# implement-plan — code a reviewed plan (Invincible)

Turn a **plan issue** (created by `create-plan`, reviewed by `plan-review`) into
a **non-merged PR** with tests. This skill is the bridge between a reviewed plan
and the code that ships it.

**Default repo:** `btipling/invincible`
**Related:** `create-plan` (plans as issues) → `plan-review` (review/edit issue)
→ **this skill** (implement) → `adversarial-review` (hostile PR review).
**Also related — start clean:** run **`cleanup-sandbox`** *before* starting a new
implementation if the workspace is left over from a prior session (stray branch,
unpushed commits, untracked agent scratch that isn't yours to keep). A fresh
`main` checkout avoids implementing on top of stale state or racing an old run.

**By default this skill does NOT merge.** It opens / updates a PR, verifies it,
and stops at merge-ready. Merging happens only on an explicit, separate request
(the repo's merge convention is a **merge commit**, not squash — see AGENTS.md).

---

## 0. Hard gates

```bash
command -v gh >/dev/null || { echo "gh missing — refuse"; exit 1; }
gh auth status || { echo "gh not auth — refuse"; exit 1; }
```

If `gh` fails → **stop**. Never GitHub MCP (`github___*`).

Set the commit author (hard constraint in `AGENTS.md`):

```bash
git config user.name  "btipling"
git config user.email "btipling@users.noreply.github.com"
```

**Before coding:**

0. **Start from a clean workspace.** If the sandbox is left over from a prior
   session, run `cleanup-sandbox` first (reset to clean `main`) — do not
   implement on top of a dirty tree or race an orphaned run left over by an
   older session. See "start clean" note in the Related line above.
1. Read root **`AGENTS.md`** (`main` or the branch the user named).
2. Read **`docs/feature-divide.md`** if the change touches UI, bridge, or agent loop.
3. Read the **plan issue** you are implementing (`gh issue view N`).
4. Ground every claim in **live code** on the branch you code against (usually
   `main`). Do **not** invent APIs — if a symbol doesn't exist, mark it
   **Unverified** and either find it or narrow scope.
5. Note the plan's locked **Cloud ops path** (if it mutates Production data,
   secrets, or env cutover, the plan should already carry a GHA
   `workflow_dispatch` path — implement that too, never laptop-only ops).

---

## 1. Workflow overview

```text
1. gh gate + read AGENTS.md (+ feature-divide when UI/bridge/agent)
2. Read the plan issue body fully (headers: Status, Layers, Cloud ops, Living docs, DoD)
3. Create a feature branch:  git checkout -b plan/<slug>  (match the plan header if set)
4. Implement in the layer(s) the plan locked (DOM / harness / Vercel backend)
5. Add tests for every non-trivial piece of logic (lib/*.test.ts)
6. Verify: typecheck → targeted tests → full suite → build gate when applicable
7. Commit (one unit of work per commit), push, `gh pr create` with
   `Fixes #N` / `Closes #N` for the plan issue being implemented; `Refs #N` for
   parent/prerequisite issues
8. Do NOT merge. Report PR URL + checklist, ask if they want adversarial-review
```

Scope strictly to the plan. If the plan's DoD includes **living docs** or
**cloud ops** (`.env.example`, `SECURITY.md`, `docs/*`, `AGENTS.md`, GHA
workflow), they must ship in the **same** PR as the code that needs them — never
defer docs/ops to a "later" unit.

---

## 2. How we test (and build) — the canonical commands

The repo's canonical entrypoints (from `package.json`) are **three**:

| What | Script | Run |
|------|--------|-----|
| Unit/integration tests (everything tracked) | `npm test` | `vitest run` |
| Typecheck | `npm run typecheck` | `tsc --noEmit` |
| Sandbox daemon tests only | `npm run test:sandbox` | `vitest run sandbox` |
| Build | `npm run build` | `next build` (runs `prebuild` = fetch harness artifact) |

### Running the suite (no wrapper — tests run directly with vitest)

**Tests must be run directly with vitest; no script wrappers are allowed.**
There is no wrapper script around vitest (a former `run-tests.mjs` wrapper has
been removed and must **not** be re-added). Do **not** create a wrapper that
swallows vitest output and prints only a summarized pass/fail line — the verdict
must always come from vitest itself (`npm test` = `vitest run`). Run vitest
through the **local** binary and an explicit exec timeout so the transport cannot
drop a long run and leave you guessing about the result:

**Test strategy — `--changed` is the default; the full suite is a merge-only gate.**

Do **not** run the full `vitest run` (several minutes) on every iteration or PR
feedback round. Use `vitest run --changed` as the standard green check while
implementing and while iterating on review feedback; run the **full** suite once
as the pre-merge gate only (`merge-pr` skill requires it). A `--changed` run is
seconds, not minutes — that is what prevents "5 minutes of tests on every PR
feedback round".

- **Mechanical "test only what changed" (default, use constantly):**
  `node_modules/vitest/vitest.mjs run --changed` (or `npm run test:changed`), or
  `… run lib/<dir>` / `… run <file.test.ts>` for a targeted file. `--changed`
  uses git to run **only** the test files that changed since `HEAD` (plus any
  tests that import those files, via static dependency tracking). This is the
  fast opt-in-only gate for a quick green check without the full sweep — use it
  after every edit and every review-feedback fix.
- **Full suite (merge gate only):** `node_modules/vitest/vitest.mjs run` with
  `timeoutMs ≈ 600000`. In a bare agent workspace a full run (~173 files /
  ~2000 tests, several minutes) can drop the connection over the transport even
  though the process completes fine. Use the `timeoutMs` ≥ 2× the expected
  wall-clock (never the default 5 min) so a slow run isn't killed mid-flight.
  Run it **once**, at the end, right before merge — not after every commit.
- **Verdict is the exit code.** `vitest run` returns non-zero (and does not
  claim green) when vitest fails **or** any test `failed>0`. Shell `&&` chains
  and CI wrappers can trust it — never claim green from interleaved output when
  the exit code is non-zero.
- **Counts.** Read the live per-file output; report the actual numbers and always
  state the delta vs the previous run. Expected drift is real: if the PR **adds**
  tests, the pass count should be `baseline + (number of new test cases)`.

### In-sandbox exec rules (learned the hard way)

1. **Set the timeout explicitly for the full suite.** The `exec` tool's default
   is **5 min**; a full run takes ~5.5 min. Pass `timeoutMs ≈ 600000` (10 min) —
   ≥2x margin, well under the 30-min ceiling. `npm run typecheck` is fast; the
   default is fine there.
2. **Large/long streams drop the transport.** A ~5-min vitest run will often
   return `"fetch failed"` from the tool even though the process succeeds. That
   is a **daemon transport** problem, not a test failure and not a timeout.
3. **Avoid orphaning background runs.** If you background a test run and the
   tool call errors, the process keeps running and races the next run. Before a
   definitive run, clear stale vitest processes (`pkill -f vitest`) so you read
   a **fresh** report. Run vitest in the foreground with a 10-min timeout.
4. **Prefer the local binary over `npx`.** `npx vitest …` can hit a transient
   network fetch error in a bare agent sandbox. Always use the local binary:
   `node_modules/vitest/vitest.mjs run <path>` (or `vitest run <path>` when on a
   network-connected machine).
5. **`next build` needs the harness artifact token** (`HARNESS_ARTIFACT_TOKEN`)
   or an existing `public/harness`, because `prebuild` runs
   `scripts/fetch-harness-artifact.mjs`. In a bare sandbox without that token,
   **do not** claim a green `npm run build` — and remember `prebuild` failing on
   the token is environmental, not caused by a backend-only change. For
   backend-only / `lib/*` changes, `typecheck + tests` are the meaningful gate.
6. **Zig (`native/harness/**`) compiles only on the self-hosted runner**
   (`build-harness.yml`), never in a generic agent workspace. After harness
   source changes: CI → artifact → Vercel (wait-for-SHA prebuild + deploy hook).
7. **Parallelism is already on.** Vitest runs test **files** in parallel by
   default, matching workers to CPU count. On a 2-core box the ceiling is cores,
   not a missing `maxWorkers` knob. Do **not** commit `minWorkers`/`pool` tuning
   baked to one host's shape (risk of OOM on small boxes). More speed = more
   cores; until this harness supports background tasks, treat the full suite as a
   command to hand to the operator or defer to CI/GitHub Actions.

### What "green" looks like

Do **not** claim ready until all of these hold (agent workspace or CI, per
`AGENTS.md` — never a human's laptop):

```bash
npm run typecheck          # tsc --noEmit, exit 0
node_modules/vitest/vitest.mjs run --changed   # fast gate during iteration: only changed files (+ dependents)
node_modules/vitest/vitest.mjs run lib/<dir>   # targeted when the diff touches lib/* worth testing
node_modules/vitest/vitest.mjs run             # FULL suite, failed=0 (10-min timeout) — pre-MERGE only
# when Wasm changes: the self-hosted build-harness job, not a local zig build
# when cloud ops ships: the new workflow validated (dry_run/dispatch), not just "npm run"
```

The **full suite is the final, merge-only gate** (enforced by `merge-pr`). During
implementation and PR-feedback iteration, rely on `--changed` / targeted runs —
several-minutes full runs are reserved for right before merge, not every round.

Expected count drift is real: if the PR **adds tests**, the full-suite
`pass` count should be **baseline + (number of new test cases)**. Report that
delta so a reviewer can see the new tests actually ran.

---

## 3. Layer ownership (respect the plan's locked layers)

Source of truth: [`docs/feature-divide.md`](docs/feature-divide.md). The plan you
implement already locked which layers change; do not silently move ownership.

| Layer | Lives in | Owns | Never owns |
|-------|----------|------|------------|
| **DOM host shell** | `app/*`, `lib/*` (TS), Next routes | Route `/harness`, nav, load Wasm, bridge glue, poll submit, SessionStore, thin status chips | Primary transcript/composer, dual React chat panel |
| **Harness (Wasm)** | `native/harness/**` (Zig + dvui) | Transcript, composer, agent chrome, turn busy/error UX | Gateway secrets, raw network to inference, durable session server |
| **Vercel backend** | `app/api/**`, server-only `lib/*` | `/api/*` routes, AI Gateway, secrets, server validation | Client-visible secrets; keys in Wasm |

**Default agent turn data flow** (do not invert):

```text
User types in Wasm composer
  → pending submit (host polls bridge)
  → host folds SessionStore + POST /api/chat (or /api/agent)
  → host pushes assistant/error into Wasm
  → user reads reply in Wasm transcript
```

Palette: use `lib/palette.ts` (DOM) ↔ `native/harness/src/palette.zig` (Wasm)
TEAL/WARM/EMBER only — no freehand hex, EMBER = danger (except documented rich-
transcript diff removed-lines).

---

## 4. Code standards that survive review

Lessons from the plan → implement → adversarial-review loop (PR #416):

- **Ground claims in live code.** Read the module you're extending before naming
  its symbols. Reuse existing validators / caps (`lib/sessionCloudCaps.ts`) rather
  than restating magic numbers.
- **Fail closed on hostile input.** For any store/repository: validate on **read**
  too, not just write (corrupt blobs → null/skipped, never a schema-valid lie).
- **Bind identity at the boundary.** If a record carries an id/tenant key AND
  lives under a separate key, re-validate the record's own identity matches the
  key it was read from (confused-deputy guard).
- **Respect charset/contract.** Where a boundary already restricts a charset
  (e.g. a Redis-safe `^[A-Za-z0-9_-]{1,128}$`) or seeds a field (e.g.
  `updatedAt:0` on create), carry it forward; do not loosen it for convenience.
- **Preserve stored fields on upsert** (e.g. don't overwrite `createdAt`).
- **Document env in living docs.** New env vars go in `.env.example` (names only)
  and the secrets table in `SECURITY.md`.
- **Every locked invariant gets a test that exercises the store, not just mocks.**
- **One commit per unit of work.** Match the commit author constraint exactly.

---

## 5. Opening the PR (no merge)

```bash
# from main, up to date:
git checkout main && git pull --ff-only
git checkout -b plan/<slug>
# ... implement + test ...
git add <paths> && git commit -m "…"   # author = btipling (hard constraint)
git push -u origin plan/<slug>

gh pr create --repo btipling/invincible \
  --base main --head plan/<slug> \
  --title "<scope>: <summary>" \
  --body-file /tmp/pr-body.md --assignee @me
# body MUST include a plan-issue keyword, matching §1: `Fixes #N` / `Closes #N`
# for the plan issue being implemented, `Refs #N` for parent/prerequisite issues
```

PR body facts must be **true at push time** (e.g. "17 tests added" — update the
count if you add more before pushing). Set base `main`, head your branch.

**Record expected-CI delta in the PR body** (baseline `passed` → new `passed`) so
a reviewer can confirm the new tests actually executed. If required
checks exist (`test` / `typecheck` / `build` / `build-harness`), wait for them to
finish and report pending/failed out loud; never claim green on `pending`.

**Do NOT merge** under this skill. Stop at "merge-ready from review":
report the PR URL, the verification results, and the next suggested step
(`adversarial-review` on the PR, then an explicit merge request). Issue
close-out is the plan issue's, driven by the merge (see AGENTS.md merge
convention).

---

## 6. After opening

1. Post a short summary comment on the PR (what changed, verification, CI status).
2. If the plan's DoD lists living docs / cloud ops, confirm they are in **this**
   PR (not deferred).
3. If the user runs the full suite on their side, reconcile their counts against
   the PR body before calling it done.
4. On review feedback: read it, fix the findings, run `typecheck` + `vitest
   run --changed` (or a targeted file) again, commit as a **new** unit, push.
   **Do not run the full suite on every feedback round** — `--changed` is the
   feedback-loop green check (seconds, not minutes). The full suite runs once at
   the end, as the pre-merge gate. Re-review as needed until the reviewer verdict
   is PASS/PASS WITH NOTES.

---

## 7. Anti-patterns

- Implementing before reading the plan / AGENTS.md
- Inventing symbols or APIs not on the branch ("Unverified" not marked)
- Claiming green `npm run build` in a bare sandbox without `HARNESS_ARTIFACT_TOKEN`
- **Introducing (or re-adding) a script wrapper around vitest** and trusting its
  summarized pass/fail line instead of vitest's own output and exit code — tests
  must run directly with vitest, never through a wrapper that hides output
- Running `npm test` directly in a bare agent workspace and trusting a dropped
  transport result, or reporting a stale/orphaned report as fresh
- No tests for new `lib/*` logic
- **Running the full `vitest run` after every edit / every feedback round**
  instead of `--changed` — the full suite is a merge-only gate, not an
  iteration tool (keeps feedback rounds to seconds, not ~5 minutes)
- No full-suite run before PR / before merge
- Merging when the user only asked to implement
- Merging while required checks are pending/failed
- Deferring living docs / cloud ops that the plan locked into this PR
- Dual-chat UI regression; secrets leaking from server to client/Wasm

---

## 8. Minimal checklist

```text
[ ] gh auth OK; commit author = btipling
[ ] Workspace started clean (cleanup-sandbox run if prior-session leftovers)
[ ] AGENTS.md + plan issue read; feature-divide when UI/bridge/agent
[ ] Branch plan/<slug> off up-to-date main
[ ] Implementation in the plan's locked layers, grounded in live code
[ ] Tests for new logic; counts recorded in PR body (baseline → new)
[ ] npm run typecheck green
[ ] `vitest run --changed` green during iteration (not full suite every round)
[ ] full `vitest run` green (failed=0) with 10-min timeout — pre-merge gate
[ ] Build gate correct: wasm → self-hosted runner; backend-only → typecheck+tests; never fake `next build` w/o token
[ ] Cloud ops + living docs in the SAME PR when the plan locked them
[ ] PR created (base main, `Fixes #N`/`Closes #N` plan issue / `Refs` parents), not merged
[ ] Required CI reported pending/failed honestly
```
