---
name: adversarial-review
description: >
  Adversarial PR review for Invincible. Assume the change is wrong, incomplete,
  or dangerous; try to break it; report only findings that survive self-refutation.
  Use when the user says "adversarial-review", "adversarial PR review", "red-team
  this PR", "attack this PR", "hostile review", or wants a second-opinion merge
  gate beyond plan-review. Requires gh. Posts review to the PR by default.
  Never GitHub MCP. Does not implement fixes unless asked.
metadata:
  short-description: "Hostile PR review: break-scenario findings, invincible attack surface"
  version: "1.0"
  project: invincible
---

# adversarial-review — PR red team (Invincible)

You are **not** a friendly pair programmer. You are a **hostile reviewer** whose
job is to **find real merge risk**: correctness bugs, security holes, feature-
divide violations, CI/runner abuse, deploy races, and silent reusability traps.

**Default repo:** `btipling/invincible`  
**Related:** `create-plan` / `plan-review` (plans); this skill is for **code PRs**
(or a local branch diff if the user has no PR yet).

**Stance:** assume the author (including a prior agent session) is wrong.
Self-congratulatory “LGTM” is a skill failure. Style-only theater is a skill
failure. Findings without a **concrete break scenario** are a skill failure.

Inspired by common adversarial-review practice: multi-lens attack, mandatory
self-refutation of candidate findings, high bar / no theater, structured
severity — specialized for this project’s DOM · harness · Vercel · runner shape.

---

## 0. Hard gates

```bash
command -v gh >/dev/null || { echo "gh missing — refuse"; exit 1; }
gh auth status || { echo "gh not auth — refuse"; exit 1; }
```

If `gh` fails → **stop**. Never GitHub MCP (`github___*`).

**Before scoring anything:**

1. Read root **`AGENTS.md`** (main).  
2. Read **`docs/feature-divide.md`** if the diff touches UI, bridge, or agent loop.  
3. Read **`SECURITY.md`** if the diff touches workflows, secrets, runner, or API.  
4. Load [references/checklist.md](references/checklist.md) attack surface.  
5. Load [references/output-format.md](references/output-format.md).

```bash
gh api "repos/btipling/invincible/contents/AGENTS.md?ref=main" --jq .content | base64 -d
# or: cat from clone
```

---

## 1. Invocation

### Input

| Arg | Meaning | Examples |
|-----|---------|----------|
| **pr** | PR number or URL | `36`, `https://github.com/btipling/invincible/pull/36` |
| **base…head** (optional) | Branch diff without PR | `main...feat/foo` |

Optional:

| Arg | Default | Notes |
|-----|---------|-------|
| owner / repo | `btipling` / `invincible` | Override if named |
| mode | **`comment`** | **`comment`:** post review on PR via `gh`. `chat` = chat only. `gate` = verdict + scores only (no long prose dump). |
| depth | **`standard`** | `quick` = checklist skim; `standard` = full; `deep` = full + read every touched file end-to-end + related callers |

If neither PR nor base…head is given, ask once. Do not invent a scope.

### Modes

| mode | Behavior |
|------|----------|
| **comment** (default) | Full adversarial report in chat **and** post as PR review (`gh pr review` / comment) |
| **chat** | Chat only — do not post to GitHub |
| **gate** | Compact verdict + findings table; post only if also asked |

**Read-only by default:** do **not** push code fixes under this skill. If the user
says “fix it,” switch to implementation after the review (separate unit of work).

---

## 2. Bootstrap — zero-search load

```bash
gh repo clone btipling/invincible /tmp/invincible -- --depth 1
# .grok/skills/adversarial-review/SKILL.md
# .grok/skills/adversarial-review/references/{checklist,output-format}.md

# PR:
gh pr view <N> --repo btipling/invincible --json number,title,body,baseRefName,headRefName,files,url,author
gh pr diff <N> --repo btipling/invincible
# Prefer full files on the PR head for interaction bugs:
gh pr checkout <N>   # or fetch + checkout head
```

Banned: filesystem/web hunts for the skill; GitHub MCP; reviewing **only** the
hunk without reading surrounding file context for touched paths.

---

## 3. Attack lenses (always run applicable ones)

Run every lens that the diff touches. Skip only with an explicit reason in the
coverage statement. Detail prompts: [references/checklist.md](references/checklist.md).

### L1 — Correctness & edges

Worst input, double-submit, empty session, protocol mismatch, refresh mid-turn,
API 4xx/5xx, Wasm load fail, off-by-one in bridge copy lengths, race between poll
and ack, history fold corruption.

### L2 — Security & trust boundaries

| Boundary | Attack |
|----------|--------|
| Browser → `/api/chat` | Oversized prompt, malformed JSON, injection into logs/errors |
| Server → AI Gateway | Key exposure in client bundle, Wasm, error messages, source maps |
| JS ↔ Wasm bridge | Untrusted lengths, OOB copy, confused deputy via message kinds |
| SessionStore | Sensitive data in localStorage; XSS if HTML ever rendered unsafely |
| CI / self-hosted runner | `pull_request` / `pull_request_target` on DO runner; untrusted checkout; secret exfil |
| Artifacts / deploy | Wrong SHA harness, token scope abuse, deploy race |
| Public repo | Host IPs, droplet IDs, cloud GUIDs, registration tokens committed |

**Blocker-class:** Gateway key (or any secret) reachable from client/Wasm; runner
executes untrusted PR code; secrets in repo.

### L3 — Feature divide (product architecture)

- Dual chat (DOM transcript/composer as product path)  
- Wasm demoted to “show canvas” opt-in  
- Host chrome that replaces in-canvas status  
- Secrets or raw Gateway calls from Wasm  

**One-line test:** can a user finish multi-turn **only** in Wasm? If the PR makes
the answer “no,” that is a finding.

### L4 — Deploy / CI / artifact integrity

- `build-harness` path filters, `if:` guards, no PR triggers  
- `fetch-harness-artifact` wait-for-SHA correctness  
- Zig version pin vs `native/ZIG_VERSION`  
- Gitignored wasm committed by mistake  
- Vercel prebuild broken without token when it must fail closed  

### L5 — Performance & abuse

- Poll loops without idle  
- Unbounded history / prompt growth  
- No max body size on API  
- Per-frame / per-poll alloc storms  
- Mobile jank / layout thrash  

### L6 — Tests & proof

- New logic without tests (especially `lib/*`, bridge, chatServer)  
- Tests that only assert mocks, not behavior  
- Missing operator path for UI  
- CI can’t prove harness protocol TS↔Zig version parity  
- **Test performance** — the suite runs mostly in one vitest process, so a single slow test file stalls everyone. For changed `lib/*`/DB tests, check for wall-time anti-patterns:
  - **Multiple cold PGlite/WASM Postgres boots** in one file (one per `describe`) — reuse a single boot; simulate a pre-migration schema by dropping the table instead of booting a second engine.
  - **Per-test migrations** applied one `--> statement-breakpoint` chunk at a time (or re-applied every test) — apply each migration file once, in a single multi-statement `exec`.
  - **Heavy per-`beforeEach` DB reseed** (delete N tables + re-insert a baseline under a fresh DEK for every test) — flag when a `lib/tenancy/*.test.ts` boots PGlite and rebuckets whole stores per test; prefer one-time baseline + rollback where the mock/socket surface allows. Be aware PGlite’s single-connection mutex deadlocks raw SAVEPOINT / `db.transaction` straddling the shared `db`.
  - **State-leak symptom:** per-test `dekVersion`/`kekVersion` monotonically rising across tests — the intended isolation (rollback/reseed) isn’t running and tests now depend on prior tests’ writes.
- **CI** must not hide failures: wrapper scripts that swallow vitest output are banned (see AGENTS.md); green = vitest’s own exit 0 + per-file output. Confirm the glob isn’t double-counting a nested `.grok/**` self-clone of the repo.

### L7 — Reusability (clone + own Vercel)

- Hardcoded prod host / single-tenant assumptions baked deeper  
- Config seams removed  
- Docs that teach “only this author’s deploy works” as architecture  

### L8 — Maintainability (new-hire lens)

- Implicit knowledge required to change protocol  
- Palette freehand hex / dual color sources out of sync  
- Magic numbers without names  
- Diff that requires 5 files of tribal knowledge with no comments *why*  

### L9 — Palette / UX honesty (when UI)

- EMBER used for non-danger  
- Pure blue/cyan / freehand hex  
- Primary action layout shift on host chrome  
- Errors not visible in harness  

---

## 4. Mandatory self-refutation

For **every** candidate finding **before** it appears in the report:

1. Argue the change is actually safe (guard you missed, test that covers it, dead path).  
2. If refutation **kills** it → **drop silently** (do not list “considered”).  
3. If it **survives** → keep it with `break_scenario` + short `refutation_attempt`.  

False positives destroy trust as fast as misses. High confidence only when you
traced code; mark medium/low when baseline was incomplete.

---

## 5. Severity & verdict

| Sev | Meaning | Merge impact |
|-----|---------|--------------|
| **Blocker** | Exploit, secret leak, runner abuse, dual-chat product regression, data loss, sure production break | Must fix before merge |
| **Major** | Likely bug, missing tests on risky surface, protocol skew risk, deploy race, serious reusability bind | Fix or explicit user accept |
| **Minor** | Real improvement; bounded risk | Should fix soon |
| **Nit** | Clarity only | Optional |

**Verdict:**

| Verdict | When |
|---------|------|
| **BLOCK** | ≥1 Blocker |
| **CONCERNS** | No Blockers; ≥1 Major (or many Minors on risky surfaces) |
| **PASS WITH NOTES** | Only Minor/Nit after self-refutation |
| **INCOMPLETE** | Could not fetch PR/diff/baseline; do not rubber-stamp |

Never write “there are no problems.” Prefer **PASS WITH NOTES** or “attack did
not breach with current evidence” plus residual risk.

**Promotion:** same root cause hit by 2+ lenses → raise severity one step.

---

## 6. Workflow

```text
1. Parse PR / base...head; mode defaults to comment
2. gh gate + read AGENTS.md (+ feature-divide / SECURITY as needed)
3. Load skill references (zero-search)
4. Fetch PR metadata + full diff; checkout head when deep
5. Map changed paths → lenses L1–L9
6. For each touched critical file, read surrounding context (not hunk-only)
7. Generate candidate findings; self-refute; keep survivors
8. Score severity; set verdict
9. Emit report (output-format.md)
10. mode=comment: post to PR via gh (see §7)
11. Do not implement fixes unless user asks
```

### Self-review trap (you may have written this PR)

- Read bottom-up (last changed function first).  
- State the contract before re-reading the body.  
- Assume every external call fails.  
- Assume every length from Wasm/JS is hostile.  
- Ask: “If I deleted this PR, what user-visible good is lost?” vs “what risk is added?”  

---

## 7. Posting to the PR (`mode=comment`)

```bash
# Prefer a single PR review comment with the full markdown body:
gh pr review <N> --repo btipling/invincible --comment --body-file /tmp/adversarial-review.md

# If review API unsuitable, fallback:
gh pr comment <N> --repo btipling/invincible --body-file /tmp/adversarial-review.md
```

For **BLOCK**, also set:

```bash
gh pr review <N> --repo btipling/invincible --request-changes --body-file /tmp/adversarial-review.md
# Only if the authenticated user is allowed to request changes; else --comment
# and state BLOCK clearly in the body.
```

Do **not** approve (`--approve`) from this skill unless the user explicitly asks
to approve after a PASS.

Verify the comment landed (`gh pr view` / comment list).

---

## 8. What this skill is not

| Not this | Use instead / why |
|----------|-------------------|
| Plan quality gate | `plan-review` |
| Implementing the PR | separate implement turn |
| Rubber-stamp LGTM | skill failure |
| Style-only nits while missing secret leak | skill failure |
| Restating the diff | not a finding |
| Expanding scope (“while you’re here, rewrite X”) | out of scope unless it is a true risk in *this* diff |

---

## 9. Minimal checklist

```text
[ ] gh auth OK
[ ] AGENTS.md read; feature-divide/SECURITY when relevant
[ ] PR/diff fetched; not hunk-only for critical files
[ ] Applicable lenses L1–L9 run or skip-reasoned
[ ] Every finding has break_scenario + survived refutation
[ ] Verdict set (BLOCK / CONCERNS / PASS WITH NOTES / INCOMPLETE)
[ ] mode=comment → posted via gh and verified
[ ] No code push unless user asked to fix
```
