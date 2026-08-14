---
name: plan-review
description: >
  FIRST read repo AGENTS.md, then review a GitHub issue plan (parent or phase)
  for correctness, performance, architectural soundness, testing, layer placement
  (DOM host vs Wasm harness vs Vercel backend), cloud-native ops (GHA primary for
  Production mutates — never laptop-only), living docs (docs/ AGENTS README
  SECURITY without phase/issue process artifacts), parent adherence when phased,
  and numeric limits (generous; never lower — caution theater). DEFAULT: apply
  recommended fixes by editing the same issue body via gh.
  LOAD: do not search — use gh to read .grok/skills/plan-review/* from main.
  Refuse if gh missing/unauthenticated. Never GitHub MCP.
  Triggers: "review plan", "plan review", "review the plan", "team review",
  "HANDOFF-READY", "check this plan", "load the plan-review skill", issue URL
  or number, "parent adherence".
metadata:
  short-description: "Review plan issues; cloud ops + living docs; never lower limits"
  version: "1.2"
  project: invincible
---

# Plan review (GitHub issue plan → critique → **update issue**)

## ⚠ FIRST — read `AGENTS.md` before anything else

**Before** reviewing a plan, scoring axes, or editing the issue: load and
**actually read** the repo’s root **`AGENTS.md`** from `main` (or the branch the
user named for implementation context).

```bash
gh api "repos/btipling/invincible/contents/AGENTS.md?ref=main" --jq .content | base64 -d
# or from clone: cat AGENTS.md
```

Also load **`docs/feature-divide.md`** when the plan touches UI or the agent loop.

`AGENTS.md` is the project constitution: commit author `btipling`, **gh-only**
GitHub, **cloud-native ops (no personal laptop shell)**, palette locks, feature
divide, configured infra (do not nag), harness build path. Reviewing without it
invents dual chat, wrong ownership, laptop-only cutovers, or MCP pushes.

**Hard rule:** if you have not read `AGENTS.md` this session, **stop and load it**
before the first finding.

---

Review a **plan stored as a GitHub issue** before implementation. Output is a
**structured review** with severity-ranked findings **and**, when there are
recommended changes, an **updated issue body** on the **same issue**.

Chat-only commentary without writing the plan is **not** the default.

**Default repo:** `btipling/invincible`. Override when the user names another
owner/repo that uses this skill pack.

**Related skills:** `create-plan` (author plans as issues).  
**Do not implement application code under this skill** unless the user
explicitly asks after the review. **Do** edit the **plan issue** body.

Load [references/rubric.md](references/rubric.md) for checklists and
[references/output-format.md](references/output-format.md) for the response
shape. Load [LOAD.md](LOAD.md) for the zero-search fetch recipe.
Limits policy (do not skip): [references/limits.md](references/limits.md).

---

## Bootstrap — zero-search load (do this FIRST)

Project skills are **not** in the generic template auto-list. **Do not hunt.**

**Order:** (1) `gh` hard gate → (2) **read `AGENTS.md`** → (3) load this skill
tree → (4) load the plan issue. Skipping (2) is a skill failure.

### Hard gate

```bash
command -v gh >/dev/null || { echo "gh missing — refuse plan-review GitHub work"; exit 1; }
gh auth status || { echo "gh not auth — refuse"; exit 1; }
```

If `gh` fails → **stop**. Never fall back to GitHub MCP.

### Banned

- `find` / web-search loops to “locate” the skill  
- GitHub MCP (`github___*`, `call_connected_tool` for GitHub)  
- Browsing GitHub HTML for the skill  

### Required: load skill + plan via `gh`

```bash
gh repo clone btipling/invincible /tmp/invincible -- --depth 1
# skill files:
#   /tmp/invincible/.grok/skills/plan-review/SKILL.md
#   /tmp/invincible/.grok/skills/plan-review/references/{rubric,output-format,layers,limits}.md

# Or single-file:
gh api "repos/btipling/invincible/contents/.grok/skills/plan-review/SKILL.md?ref=main" \
  --jq .content | base64 -d

# Plan issue:
gh issue view <N> --repo btipling/invincible --json number,title,body,state,labels,url
# or from URL: https://github.com/btipling/invincible/issues/<N>
```

After load: classify → ground baseline → score → verdict → **if any recommended
plan changes: edit issue body once via `gh issue edit`** → report.

Also listed in root `AGENTS.md` → **Project agent skills**.

---

## 0. Invocation contract

### Input (required)

| Arg | Meaning | Examples |
|-----|---------|----------|
| **issue** | Plan issue number or URL | `42`, `https://github.com/btipling/invincible/issues/42` |

Optional:

| Arg | Default | Notes |
|-----|---------|-------|
| owner | `btipling` | GitHub owner |
| repo | `invincible` | GitHub repo |
| parent | auto-detect | Explicit parent issue if not linked |
| mode | **`fix`** | **`fix` (default):** apply recommended edits to the **issue body**. `review` = chat only. `gate` = scores + verdict only. |

User phrasing that means this skill (all default to **`fix`** unless they say
“chat only” / “don’t edit” / `mode=review`):

- “Review plan issue #42”
- “Team-review the phase 2 plan”
- “Is this plan HANDOFF-READY?”
- “Load plan-review and review <issue url>”

If the issue is missing, ask once for the number/URL, then stop. Do **not** invent a plan.

### Output (always)

1. **Verdict:** `HANDOFF-READY` | `NEEDS REVISION` | `BLOCKED`
2. **Scores** (1–5) for each required axis (§3) — include **Cloud ops**,
   **Living docs**, and **Limits** (or N/A with reason)
3. **Findings table** (severity · axis · issue · fix)
4. **Parent adherence** block when applicable (§4)
5. **Layer / UI** block when applicable (§5)
6. **Cloud ops + living docs** block when Production mutate or docs in scope (§3.5–3.6)
7. **Limits** block whenever any numeric cap is in the plan (§3.7)
8. **Required plan edits** — what was (or will be) written into the issue
9. **Update result** (default mode): issue number, URL, verified  
   — or explicit “no plan edits” when nothing to change
10. **Merge-gate residual risk** (one short paragraph)

Severity: **Blocker** > **Major** > **Minor** > **Nit**.  
Any **Blocker** ⇒ verdict cannot be `HANDOFF-READY`.

---

## 0.1 Default: apply recommended changes + update issue

**Whenever the review produces recommended plan changes** under default
**`mode=fix`**:

1. **Edit the issue body** so the plan itself embodies the fixes (not only chat).
2. **Preserve** user comments; only replace the **body** via `gh issue edit`.
3. **Verify** with `gh issue view`.
4. **Report** what changed + the update in the chat review.

Leaving fixes only in the chat reply is a **skill failure** unless the user set
`mode=review` / “don’t edit” / “chat only”.

### What gets written into the plan issue

| Change type | How to land it |
|-------------|----------------|
| Wrong baseline / API / order | Correct baseline table + design |
| Missing edge case | Add locked rule + test matrix row |
| Parent drift | Corrections/refinements vs parent table |
| Weak DoD / tests | Expand DoD + testing matrix |
| Layer mistakes | Layer placement table + forbidden wiring |
| Laptop-only / script-only Production ops | Lock **Cloud ops path** with GHA primary |
| Missing AGENTS/README/docs consideration | Fill **Living docs plan** table; forbid phase/issue docs |
| Missing or incomplete **Limits** table | Add/fill the **Limits** table; **never** by shrinking a number |
| Resolved open questions | Move into locked decisions |
| Status after review | Header Status + **Review notes** stamp |

Always add/update a top **Review notes (YYYY-MM-DD)** section (see
[references/output-format.md](references/output-format.md)).

### What does **not** get changed under this skill

- Application source (`app/`, `lib/`, `native/`, tests) — implement separately  
- Unrelated issues  
- Closing/opening issues unless Status COMPLETE and user asked  
- **Any numeric limit, downward.** You may **raise** a cap, **keep** a live
  value, or **add a missing Limits table** that records existing/proposed
  numbers. You may **not** lower a live cap, a parent lock, or a number the
  plan already chose. That edit is **caution theater** and a **skill failure**.
  Restore it if the draft already lowered one without an operator ask or a
  cited production/CI break.

### When **not** to edit the issue

| Situation | Action |
|-----------|--------|
| Verdict HANDOFF-READY and **zero** plan edits | No edit; say “no plan edits” |
| `mode=review` / “chat only” | Chat findings only |
| `mode=gate` | Scores + verdict only |
| Finding needs a **product decision** only the user can make | Edit everything else that is locked; leave **Open — needs user** row |
| BLOCKED because issue missing/unreadable | No edit |

### Update procedure (`gh` only)

```bash
# 0. gh gate already passed
gh issue view <N> --repo btipling/invincible --json body -q .body > /tmp/plan-issue.md

# 1. Produce the COMPLETE revised markdown body on disk
#    - Apply every required fix coherently
#    - Review notes table + Reviewed stamp
#    - Status line updated
#    - Limits table present; no row vs-live = lower

# 2. ONE issue update
gh issue edit <N> --repo btipling/invincible --body-file /tmp/plan-issue.md

# 3. Verify
gh issue view <N> --repo btipling/invincible --json body,url -q '{url,hasNotes: (.body | contains("Review notes"))}'

# 4. Chat summary: issue, what changed, verdict after edits
```

**Rules:**

- **Always `gh`** — never GitHub MCP  
- **One body replace** for this review unit (include parent issue edit in the same
  turn only when parent checklist alignment is required — still `gh issue edit`)  
- **No placeholders** in the body  
- If the plan is multi-issue (parent + phases), review the issue the user named;
  update parent links when phase review forces parent map fixes  

### Parent issue touch (when needed)

If a phase review requires parent checklist/status alignment, update the
**parent issue body** in the same review turn. Do not silently change unrelated
parent locks. Do **not** use a parent edit to sneak a lower cap into a phase.

---

## 1. Fetch order (never review from memory)

0. **Read `AGENTS.md` first** — project constitution (incl. cloud ops model).  
1. **Get the plan issue** body via `gh issue view`.  
2. **Parse header** for: Status, Parent, Phase N, Layers, Reusability, Production
   mutate, Cloud ops, Living docs.  
3. **Detect parent relationship** (§4). If `Parent: #N` or title says phase,
   **get the parent issue**.  
4. **Ground in live code** for every module the plan claims as baseline:
   - clone or `gh api` for cited paths on `main` (or named branch)
   - If ops: list `.github/workflows/*` and verify claims about existing GHA  
   - Do **not** invent bridge APIs, route shapes, or ownership  
5. **Load project constraints:** feature-divide, palette rules, infra “Done” table.  
6. **Inventory every numeric limit** in the plan and in live code it cites
   (bytes, chars, counts, timeouts, retries, slug/body/meta/payload/ring).
   Compare plan vs live vs parent. Score §3.7.  
7. Only then score. **If a cited baseline cannot be fetched, mark Unverified.**  
8. **Default `mode=fix`:** recommended changes → edit issue body before done.

---

## 2. Classify the plan

| Class | Signals | Extra axes |
|-------|---------|------------|
| **Parent / roadmap** | Type parent, multi-phase map, epic | Feasibility, phase cut, locked decisions |
| **Phase handoff** | Type phase N, Parent: #N, “Intent lock” | Parent adherence **required** |
| **UI / host shell** | nav, load chrome, status chips, layout, mobile | **Layout stability** (§5) |
| **Harness UX** | transcript, composer, canvas chrome, dvui | Harness UX + palette; no dual-chat |
| **Systems / pure** | bridge protocol, SessionStore, pure TS, no new look | Skip beauty; still score layers |
| **Backend / API** | `/api/*`, Gateway, secrets, rate limits | Security + reusability seams |
| **Ops / cutover** | migrate, seed, backfill, env flip, dual-store, GHA | **Cloud ops** (§3.5) **required** |
| **Docs / agent rules** | SECURITY, BYO, AGENTS, README | **Living docs** (§3.6) **required** |
| **Refactor** | move modules, no behavior change | Zero behavior drift |

A plan can combine classes (e.g. phase + backend + ops + docs). Any class that
names a numeric cap also requires §3.7.

---

## 3. Core review axes (always)

Score each 1–5. Detail: [references/rubric.md](references/rubric.md).

### 3.1 Correctness

- Claims match **live** code (APIs, bridge version, call order, types).
- Edge cases: empty session, Wasm load failure, API errors, refresh restore,
  mobile viewport, double-submit, protocol mismatch.
- Explicit **non-goals** and **forbidden wiring**.
- Protocol / state rules **locked**, not TBD for in-scope work.
- No contradictions (DoD vs out-of-scope, defaults vs tests).

### 3.2 Performance

- Poll / render loops bounded; no accidental tight loops without idle.
- Payload sizes and history fold strategy named when multi-turn grows.
- Wasm rebuild cost acknowledged when `native/harness` changes (CI path).
- Skip work when idle / no pending submit where relevant.
- Server route: no unbounded retries; no client key exposure.
- **Bounds ≠ Arduino caps.** A named bound can be large (MiB, minutes, thousands).
  Scoring “performance” by shrinking a body/meta/slug to 4–16 KiB “just in case”
  is **caution theater**, not a performance finding. Real perf issues are
  unbounded loops, N+1 storms, missing idle-skip — not “the AGENTS.md is 20 KiB.”

### 3.3 Architectural soundness

- Respects **layer ownership** (DOM vs harness vs Vercel backend) — see §5 and
  [references/layers.md](references/layers.md).
- **Wasm is the harness; DOM is host shell** — dual chat is a Blocker unless
  temporary exception is explicit with exit criteria.
- Secrets only on server; never in Wasm or client bundle.
- Zig compile only on configured runner; artifact → Vercel path intact.
- Import / module placement matches AGENTS “where to change” table.
- **Reusability:** plans must not cement single-owner hardcoding without a risk
  note and a seam (env / config). See AGENTS product intent.
- **Cloud-native:** ops/cutover designs must not assume a human laptop shell.

### 3.4 Testing

- Unit matrix covers pure helpers with **edge cases**.
- Bridge/protocol tests when message shapes change.
- API tests without real secrets.
- Operator checklist when UI is user-visible (host and/or canvas).
- Commands listed for **agent workspace or CI**: `npm test`, `npm run typecheck`,
  `npm run build`, and harness CI when Wasm changes — never “run on your laptop”
  as the human operator story.
- When GHA ships: dry_run / script unit tests / throwaway DB smoke named.
- Tests are **implementable** against the locked API.

### 3.5 Cloud ops (mandatory when Production mutate / cutover in scope)

Score **N/A** only when the plan truly has no Production data/secret/env mutate
and says so. Otherwise score 1–5.

| Must lock | Fail if |
|-----------|---------|
| **Primary** operator path is **GHA `workflow_dispatch`** (new or extend) | Only `npm run …` / script / “cloud agent someday” without a workflow |
| Workflow safety: confirm input, dry_run optional, ubuntu-latest for DB, no PR trigger | Self-hosted Production DB mutate without deliberate review |
| Dual-store secret **names**; GHA ≡ Vercel when required | Laptop `.env` as Production path |
| Explicit wrong-tool bans (seed ≠ backfill, etc.) | Ambiguous “re-run bootstrap” for a different op |
| Living docs describe Actions path **first** | Docs teach personal-machine npm as primary |

**Blocker:** Production mutate/cutover planned with **no** cloud primary path
(GHA or equivalent hosted dispatch), leaving only personal-machine or “hope an
agent is online” execution.

**Major:** Script exists in DoD but workflow deferred to “follow-up”; or AGENTS
sentence treated as sufficient operator UX.

**Historical pattern to reject:** document + `package.json` script for backfill
while origin Production still needs cutover and **no** Actions workflow ships.

### 3.6 Living docs (mandatory when product, ops, secrets, or agent rules change)

Score **N/A** only for pure internal refactors with zero user/operator/agent
surface change — and the plan must say why each surface is N/A.

| Must consider | Fail if |
|---------------|---------|
| `docs/*` for durable behavior/ops | Ops knowledge only in plan issue |
| `AGENTS.md` when infra Done table, skills, or agent rules change | Agents still get stale constitution |
| `README.md` when visitor entry or top links change | Front door wrong/missing |
| `SECURITY.md` / `.env.example` when secrets or crypto cutover change | Security table stale |
| Docs are **timeless** for newcomers | Docs narrate “phase 2”, “see issue #95”, handoff checklists |
| Process (phases, parent maps) stays in **issues** | Product guides become project-management logs |

**Major:** plan ships Production-facing ops with no docs plan, or docs planned as
“mention in AGENTS only.”  
**Major:** living docs will cite phases/issue numbers as the main explanation.  
**Blocker:** only if docs would instruct **secrets in git** or **laptop-only
Production mutate** as the official path.

### 3.7 Limits — generous; **never lower** (caution theater)

Score **N/A** only when the plan sets **no** numeric cap and says so. Otherwise
score 1–5. Full policy: [references/limits.md](references/limits.md).

This product is a **cloud harness on Vercel**, not a microcontroller. The
operator is tired of re-litigating Arduino-era numbers (4 KiB `meta`, 16 KiB
bodies, 32-char slugs, tiny retry loops) that reviewers invent “to be safe”
when **nothing has broken**. Those caps handicap authors, force a follow-up
plan to undo them, and waste the same argument again. That is **caution
theater**. Stop.

**Policy the operator locked:**

1. Limits ought to be **generous**. Size them for a real AGENTS.md, a real
   playbook, a real session — not a theoretical paste-bomb on an Arduino.
2. **We lower a limit when something actually breaks because of that limit.**
   Not before. Not “defense in depth.” Not “to match a sibling.”
3. **plan-review is not allowed to lower any limit.** Applying a downward
   number as a “fix” is a **skill failure**. Do not put it in Review notes.
   Do not put it in the issue body.
4. If the **draft already lowered** a live cap or a parent lock without an
   explicit operator ask **or** a cited production/CI break: that is a
   **Blocker**. Restore the live (or more generous) value.
5. Every numeric limit this plan sets, inherits, or copies **must** appear in
   a dedicated **Limits** table in the issue body (same shape as create-plan).
   Missing table when any cap exists = **Major** → add the table. Filling the
   table by inventing smaller numbers = **Blocker**.

| Must lock | Fail if |
|-----------|---------|
| **Limits** table in the issue (or explicit **N/A — no numeric limits**) | Caps buried only in prose / decisions / code-sketch comments |
| Each row: Limit · Value · Live on `main` · vs live · Enforced at · Why (not “safety”) · Lower only if | “16 KiB to be safe” / “match personas” as the Why |
| `vs live` is `raise` \| `keep` \| `new` | `lower` without operator ask or cited break |
| Reviewer edits never shrink a number | Review notes that “tighten the cap” |

**Blocker:** this review, or the plan as written, **lowers** a live or parent
limit without the operator asking or a cited break.

**Major:** numeric caps exist and there is no **Limits** table.

**Not a finding:** “this body could be 16 KiB like personas.” Copying a
**smaller** sibling cap onto a new surface is theater unless the **same
physical budget** is shared (e.g. persona snapshot really does sit inside
`HARNESS_SESSION_MAX_META_BYTES`). Skills bodies do **not** share that
budget — do not pretend they do.

---

## 4. Parent-plan adherence (phase issues — mandatory)

When the issue is a phase of a parent (`Parent: #N`, or title `phase N`):

### 4.1 Must verify

| Check | Fail if |
|-------|---------|
| Phase number matches parent phase map | Wrong phase deliverable |
| **In-scope** ⊆ parent phase deliverables | New subsystems not on parent roadmap |
| **Out-of-scope** does not re-open parent locks | Reopens locked decisions |
| Names / protocol / paths match parent | Silent divergence |
| DoD maps to parent checklist | Parent cannot be checked off |
| Depends on prior phases COMPLETE or assumed | Builds on unfinished work quietly |
| Next-phase preview does not leak into this scope | Scope bleed |
| Cloud ops / docs deferred incorrectly across phases | Mutate script in phase N, GHA “later” with no owner |
| Phase does not **lower** a parent-locked limit | “Tighten the parent cap in this phase” |

### 4.2 Allowed refinements

Phase plans **may** tighten parent sketches when live code forces a correction —
document in **Corrections / refinements vs parent**. Silent drift = **Major**.

**Tighten** here means correct a wrong API name or path — **not** shrink a
numeric limit. Raising a parent cap because live code or product use needs it
is an allowed refinement (document it). Lowering is not.

### 4.3 Parent adherence score

- **5** — Every parent lock cited; refinements table complete; no scope creep  
- **3** — Mostly aligned; 1–2 undocumented drifts  
- **1** — Wrong phase, reopened locks, or different feature  

---

## 5. Layer & UI review (when DOM / harness / layout in scope)

Detail prompts: [references/layers.md](references/layers.md).

### 5.1 Layer placement (mandatory when multiple layers or UX)

| Must lock | Fail if |
|-----------|---------|
| Each concern assigned DOM / harness / Vercel | “TBD layer” for in-scope work |
| Matches feature-divide ownership | Transcript/composer planned in React as product path |
| Secrets path is server-only | Key or Gateway in Wasm/client |
| Temporary exceptions listed with exit criteria | Silent dual-UI |

**Blocker:** primary agent UX planned as DOM chat while canvas is secondary.

### 5.2 Layout stability (host shell chrome)

When show/hide of host chrome can move primary actions:

| Must lock | Fail if |
|-----------|---------|
| Primary actions geometry stable across states | Buttons hop when status mounts/unmounts |
| Progress/status reserved height or always mounted | “Hide when ready” with reflow |
| Operator checklist includes no vertical jump | Only color checks |

Unmitigated primary-action layout shift = **Blocker**.

### 5.3 Harness UX quality (when canvas UX ships)

- Readable transcript hierarchy; composer always findable  
- Errors use EMBER; normal chrome TEAL; WARM only intentional accent  
- Mobile ~390px completable without “use the DOM chat instead”  
- Operator checklist: load → type → send → read → second turn → refresh  

### 5.4 Palette

Sources: `lib/palette.ts` + `native/harness/src/palette.zig`.  
No freehand hex; no pure blue/cyan; EMBER = danger only.  
“Pick nice colors in UI” without tokens = **Major**.

### 5.5 Reusability

| Must consider | Fail if |
|---------------|---------|
| Clone + own Vercel + own keys remains plausible | Hardcodes one prod host as architecture |
| Config seams for future sandbox/runner | Plan deepens single-tenant binds with no note |
| Language/platform-agnostic **target** projects | Assumes only this repo’s stack is ever driven |
| BYO ops via GHA/Vercel, not author laptop | Laptop-centric cutover as architecture |

Not every phase must implement multi-tenant; every phase must **avoid needless
anti-reuse** and document impact in the plan header.

---

## 6. Project hard constraints (auto-Blocker if violated)

1. Dual product chat (DOM transcript/composer as primary) without explicit temporary exception + exit  
2. Secrets / Gateway key in client or Wasm  
3. Gameplay-or-agent decisions that require server trust done only in the client without validation plan  
4. Edit paths that require Zig compile **off** the self-hosted runner as the only path  
5. Pure blue/cyan or freehand palette for product UI  
6. Phase ships layer ownership the parent forbade  
7. Missing tests for protocol/API changes that are in-scope  
8. Primary CTA / action layout shift across host states without mitigation  
9. Commit guidance that uses GitHub MCP or non-`btipling` author for this repo’s gates  
10. Plan re-opens “configure deploy hooks/tokens” as user todos when AGENTS marks them **Done** (unless log-proven regression)  
11. Architectural change with **no** decisions table and no explicit N/A justification  
12. **Production data/secret cutover with no GHA (or equivalent hosted) primary path** — script/`npm run` only, or “operator’s laptop”  
13. **Living docs planned to teach laptop-only Production ops** as the official path  
14. **Lowering a numeric limit** (live, parent-locked, or already chosen in this plan) without an explicit operator ask or a cited production/CI break caused **by that limit**. This includes “tighten to match sibling,” “16 KiB to be safe,” and review-notes that shrink a cap.  

---

## 7. Review workflow (agent steps)

```text
1. Parse user issue number/URL (mode defaults to fix)
2. Read AGENTS.md (+ feature-divide if UI/loop) — MANDATORY before scoring
3. Fetch plan issue body via gh
4. Classify (§2) — flag ops/docs classes
5. Fetch parent issue if phase
6. Fetch every cited baseline module (+ workflows if ops)
7. Inventory numeric limits (plan vs live vs parent)
8. Walk rubric axes (§3) + parent (§4) + layers/UI (§5)
   including Cloud ops (§3.5) + Living docs (§3.6) + Limits (§3.7)
9. Build findings; scores + verdict
10. DEFAULT mode=fix — if recommended plan changes:
     a. Write full revised body to disk
     b. Add Review notes + Status
     c. NEVER lower a limit in that body
     d. gh issue edit once; verify
11. Present verdict + findings + update result to user
```

---

## 8. Verdict criteria

| Verdict | When |
|---------|------|
| **HANDOFF-READY** | No Blockers; Majors fixed in plan (or user-waived); scores ≥ 4 on required axes; parent ≥ 4 when phase; layers sound; cloud ops + docs + limits sound or N/A — **after** edits if any |
| **NEEDS REVISION** | Material issues remain (user decision or incomplete baseline) |
| **BLOCKED** | Missing issue, cannot fetch critical baseline, or unsafe contradictions |

When `mode=fix` clears Blockers/Majors via issue edits, re-score and prefer
**HANDOFF-READY**.

A review that “fixed” a plan by shrinking a cap is **not** HANDOFF-READY —
revert that edit.

---

## 9. What “good” looks like

High-quality plan issues include:

- Header table (Status · Parent · Layers · Reusability · **Production mutate** ·
  **Cloud ops** · **Living docs**)  
- **Review notes** after team review  
- Intent lock (in / out / forbidden)  
- Goals & DoD + checkbox exit criteria (ops + docs checkboxes when relevant)  
- Live baseline table (workflows when ops)  
- Architectural decisions when warranted  
- Layer placement table  
- **Limits** table (or N/A — no numeric limits)  
- **Cloud ops path** section (or N/A)  
- **Living docs plan** table (AGENTS + README always considered)  
- Testing matrix with edges  
- Risks & mitigations (incl. missing-GHA risk when ops)  
- Parent alignment + refinements (phase)  
- Open questions empty for in-scope locks  

Missing sections that the phase needs → finding → pushed into issue under fix mode.

---

## 10. Anti-patterns (reviewer)

- Reviewing without reading `AGENTS.md` this session  
- Approving without live baseline files  
- “Looks fine” without a findings table  
- **Chat-only fixes when mode=fix** — **skill failure**  
- Using GitHub MCP instead of `gh`  
- Ignoring parent locks on phase issues  
- Rubber-stamping UI on palette alone while **actions hop**  
- Approving DOM dual-chat as “faster MVP” without exception  
- Approving **script-only Production cutover** because “AGENTS says cloud”  
- Approving docs that are **phase/issue process dumps**  
- Expanding scope during review  
- Implementing app code under the guise of review  
- **Lowering a limit “to be safe” / “to match personas” / “defense in depth”** — **skill failure**  
- Treating Vercel / Gateway / Redis as if they were 16 KiB platforms (they are not)  
- Inventing a 4 KiB / 16 KiB / 32-char cap because a sibling has one, when the
  physical budget is **not** shared  
- Scoring performance down because a playbook is allowed to be larger than 16 KiB  

---

## 11. Minimal checklist (copy into each review)

```text
[ ] gh present + authenticated (else refuse)
[ ] AGENTS.md read before scoring
[ ] Plan issue fetched via gh
[ ] Parent fetched if phase issue
[ ] Baseline modules verified against live code
[ ] Workflows verified if Production mutate
[ ] Correctness / performance / architecture / testing scored
[ ] Cloud ops scored (or N/A with reason)
[ ] Living docs scored (or N/A with reason) — AGENTS + README considered
[ ] Limits scored (or N/A — no numeric limits)
[ ] Limits table present in the issue when any cap exists
[ ] No limit lowered vs live / parent / this plan (unless operator asked or cited break)
[ ] Parent adherence scored (or N/A)
[ ] Layer placement + dual-chat check (or N/A)
[ ] Layout stability for host chrome (or N/A)
[ ] Palette / harness UX (or N/A)
[ ] Reusability impact sane
[ ] Verdict set; findings with fixes
[ ] Issue body updated (or explicit no-edit reason)
[ ] Remote verified via gh issue view
[ ] Chat reports verdict + update result
```
