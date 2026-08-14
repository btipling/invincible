---
name: create-plan
description: >
  Create an implementation plan as a GitHub issue (optional phase child issues
  that reference the parent). Use when the user says "create-plan", "use the
  create-plan skill", "plan this feature", "write a plan for", "phase plan",
  or wants a feature broken into HANDOFF-READY issues before coding.
  Requires gh. Plans live in issues, not docs/*.md. Enforces cloud-native ops
  (GHA / cloud agent — never laptop-only Production cutovers) and living docs
  updates (docs/, AGENTS.md, README.md) without phase/issue process artifacts.
  Never GitHub MCP.
metadata:
  short-description: "Write feature plans as GitHub issues (cloud ops + living docs)"
  version: "1.1"
  project: invincible
---

# create-plan — plan as GitHub issue(s)

Write a **concrete implementation plan** for Invincible and publish it as a
**GitHub issue**. Large work may be split into **phase issues** that each
reference a **parent** issue.

**Default repo:** `btipling/invincible`  
**Related:** `plan-review` (critique + edit issue bodies) after drafting.

This skill **does not implement code**. It produces reviewable plans only.

---

## 0. Hard gates

```bash
command -v gh >/dev/null || { echo "gh missing — refuse"; exit 1; }
gh auth status || { echo "gh not auth — refuse"; exit 1; }
```

If `gh` fails → **stop**. Never use GitHub MCP (`github___*`).

**Before drafting:**

1. Read root **`AGENTS.md`** (main, or the branch the user named) — especially
   **Operator & agent model** and **Infrastructure already configured**.
2. Read **`docs/feature-divide.md`** (DOM vs Wasm ownership).
3. Ground claims in **live code** on the branch you plan against (usually `main`).
4. Skim relevant prior COMPLETE plans / epics if the feature continues them.
5. If the work mutates Production data, secrets, deploy, or env cutover: list
   existing **GHA workflows** under `.github/workflows/` and decide whether to
   **extend** one or **add** a dispatch-only job (see §1.1).

Commit author for any git work that accompanies the plan:

```bash
git config user.name "btipling"
git config user.email "btipling@users.noreply.github.com"
```

Issue creation uses `gh issue create` / `gh issue edit` (no git required for the
plan body itself).

---

## 1. Product context (always respect)

### Reusable product (not a one-off)

Invincible is **intended to be reusable**: anyone should eventually be able to
**clone this repo**, attach **their own Vercel project**, and (when built) their
own **sandbox / runner environment**, then run the harness against **their**
work — **regardless of language or platform** of the target project.

The codebase may **not yet implement** multi-tenant / bring-your-own-infra
fully. Plans must still:

- Prefer designs that **do not hard-bind** product logic to a single owner's
  Vercel project, droplet, or model vendor.
- Call out **config seams** (env, project IDs, runner labels) instead of
  hardcoding one deployment.
- Avoid “works only for this author’s prod URL” as a permanent architecture.
- If a plan **blocks** reusability, say so under **Risks** and prefer a path
  that keeps the door open.

### 1.1 Cloud-native development & ops (mandatory — not optional color)

There is **no personal laptop/desktop as a product shell**. Humans use browser +
Vercel + GitHub UI. Agents and CI run in **cloud workspaces** / **GitHub Actions**.
A note in `AGENTS.md` is **not** enough — **plans must ship cloud operator paths**.

| Who | Where work runs |
|-----|-----------------|
| Human operator | Vercel dashboard, GitHub Actions **Run workflow**, hosted admin UI, browser |
| Implementer agent | Remote agent workspace (`gh` + `git` + `npm` **there**) |
| Trusted automation | GitHub Actions (`ubuntu-latest` for DB/secrets jobs; self-hosted only for Zig) |

**“Local” in plans means the agent/CI checkout**, never “clone on the maintainer’s Mac.”

#### When the plan mutates Production / shared state

If the design needs **any** of: migrate, seed, backfill, re-encrypt, one-shot data
repair, dual-store secret cutover, env flip that requires a coordinated script,
or other **ops that are not pure Vercel env UI**:

| Required in the plan | Fail if missing |
|----------------------|-----------------|
| **Primary path = GHA `workflow_dispatch`** (new workflow or extend existing) | Only “run `npm run …`” / script path with no Actions entry |
| Confirm / dry-run guards, ubuntu-latest (no self-hosted for untrusted DB ops) | Self-hosted runner for Production DB mutate without explicit design review |
| Dual-store secrets named by **secret name only** (GHA ≡ Vercel when required) | Invented laptop `.env` as the Production path |
| Living docs describe the **Actions button** path first | Docs that teach personal-machine npm as primary |
| Explicit **do not** use wrong tools (e.g. seed ≠ backfill) | Ambiguous “re-run bootstrap” for a different cutover |

**Script + `package.json` script** is fine as the **implementation** the workflow
runs — it is **not** a complete operator story by itself.

**Historical failure mode (do not repeat):** shipping `npm run db:backfill-deks`
+ docs while Production still needed cutover, with **no** `workflow_dispatch`
GHA — leaves origin in a bind because humans have no laptop shell and agents
are not always mid-session when cutover is due.

#### When pure code is enough

UI/lib/Wasm-only changes with **no** Production data/secret mutate may mark
**Cloud ops path: N/A — no Production mutate** (one line). Still never document
laptop-only steps for humans.

### 1.2 Living docs (mandatory when product, ops, or agent rules change)

Plans live in **GitHub issues**. **Durable truth** for new people and agents is:

| Surface | Audience | Update when |
|---------|----------|-------------|
| **`docs/*`** | Operators + implementers | Behavior, cutover order, BYO, sandbox, runner, limits |
| **`AGENTS.md`** | Agents (+ humans) | Infra Done/Not Done, skills index, hard constraints, “where to change” |
| **`README.md`** | New visitors | Front door, how to try the product, pointers to living docs |
| **`SECURITY.md`** | Security / operators | Secrets table, runner policy, tenancy/crypto rules |
| **`.env.example`** | Config seams | New/changed env names (comments only; never values) |

#### Always consider (checklist in every plan)

```text
[ ] docs/* — new or existing guide needs a section?
[ ] AGENTS.md — infra table, agent rules, skills, ownership table?
[ ] README.md — visitor-facing entry or link table?
[ ] SECURITY.md — secrets, trust boundaries, cutover?
[ ] .env.example — new env or operator comment?
[ ] Explicit N/A for each skipped surface with one-line why
```

DoD **must** include concrete doc paths when any box is yes. “Docs if needed”
without naming files is a skill failure.

#### What living docs must **not** contain

Product/ops docs are for **someone new to the repo with zero issue history**:

| Forbidden in `docs/*`, README, SECURITY (and prefer avoid in AGENTS) | Put instead |
|---------------------------------------------------------------------|-------------|
| “Phase 2”, “phase 3 of the epic”, implementation roadmaps | Timeless behavior: *what the system does now* and *how to operate it* |
| “See GitHub issue #92 / plan #95” as the main explanation | Self-contained procedure + code paths |
| Handoff theater, parent/child phase checklists | Keep process only in **plan issues** |
| Laptop-primary ops (`cd ~/…`, “on your machine”) | GHA / Vercel / cloud agent |
| Secret values, host inventory, private IPs | Names of secrets and abstract topology only |

**OK in plan issues only:** phase maps, parent links, “implements #N”, review notes.

**OK in living docs:** current architecture, cutover **order**, workflow **names**,
env **names**, failure modes, links between durable guides.

### Layer ownership (DOM · harness · Vercel backend)

Every plan that touches UX or I/O **must** state where work lands. Source of
truth for UI ownership: [`docs/feature-divide.md`](../../../docs/feature-divide.md).

| Layer | Lives in | Owns | Never owns |
|-------|----------|------|------------|
| **DOM host shell** | `app/*`, `lib/*` (TS), Next routes | Route `/harness`, nav, load Wasm, bridge glue, poll submit, SessionStore, thin status chips, host error for *load* failures | Primary transcript, primary composer, dual React chat panel |
| **Harness (Wasm)** | `native/harness/**` (Zig + dvui) | Transcript, composer, agent chrome, turn busy/error UX, onboarding copy in-canvas | Gateway secrets, raw network to inference, durable multi-device session server |
| **Vercel backend** | `app/api/**`, server-only `lib/*` | `POST /api/chat` (and future server routes), AI Gateway, secrets, any server validation | Client-visible secrets; putting keys in Wasm |

**Data-flow template (default agent turn):**

```text
User types in Wasm composer
  → pending submit (host polls bridge)
  → host folds SessionStore + POST /api/chat
  → host pushes assistant/error into Wasm
  → user reads reply in Wasm transcript
```

Plans that invert this (DOM as primary chat) require an **explicit, temporary
exception** tracked in the issue — default is **forbidden**.

### Palette

`lib/palette.ts` (DOM) ↔ `native/harness/src/palette.zig` (Wasm) — TEAL / WARM /
EMBER. No freehand hex, no pure blue/cyan, EMBER = danger only.

### Infra already configured

Do **not** invent “setup Vercel / deploy hook / tokens” todos. See AGENTS.md
**Infrastructure already configured**. Plans may *use* those seams; they must
not re-ask the user to create them unless a log proves regression.

---

## 2. When to use parent + phases

| Shape | Use when |
|-------|----------|
| **Single issue plan** | One coherent slice, ≤ ~1–2 days implement, no hard phase boundaries |
| **Parent + phase issues** | Multi-step roadmap, distinct pure/wire/UI/docs gates, or risk of scope bleed |

**Parent issue** = epic / Phase 0: goals, locks, phase table, non-goals, risks.  
**Phase issues** = implementable handoffs: intent lock, baseline, design, tests, DoD.

Create the **parent first**, then phases that **link back** (see §5).

Phase numbers belong in **issues only** — never as the primary structure of
living product docs shipped by the same work.

---

## 3. Required plan format (issue body)

Use this structure. Omit a section only if truly N/A (state N/A explicitly).

```markdown
## Plan header

| Field | Value |
|-------|--------|
| **Status** | DRAFT \| HANDOFF-READY \| IN PROGRESS \| COMPLETE \| BLOCKED |
| **Date** | YYYY-MM-DD |
| **Type** | parent \| phase N |
| **Parent** | #NN (or N/A for parent) |
| **Branch** | plan/<slug> or main (implementation branch if known) |
| **Layers** | DOM \| harness \| Vercel backend (list all that apply) |
| **Reusability impact** | none \| config-only \| architectural (explain) |
| **Production mutate?** | no \| yes — summarize (migrate / backfill / seed / env cutover / …) |
| **Cloud ops path** | N/A \| GHA workflow name(s) to add/extend |
| **Living docs** | paths to touch, or N/A with why |

## Summary

One short paragraph: what ships and why.

## Goals

| # | Goal | Success signal |
|---|------|----------------|
| 1 | … | … |

## Non-goals / out of scope

- …
- **Forbidden wiring:** … (e.g. dual DOM chat, secrets in Wasm, laptop-only ops)

## Architectural decisions

> Required when the work changes ownership, protocols, data flow, deploy path,
> persistence, multi-tenant/reuse seams, or **Production ops path**. For pure
> polish with no ops/docs, write **N/A — no new decisions** and one line why.

| Decision | Options considered | Choice | Why |
|----------|--------------------|--------|-----|
| … | A / B | B | … |

### Layer placement

| Concern | Layer | Path(s) | Rationale |
|---------|-------|---------|-----------|
| … | DOM / harness / Vercel | `…` | … |

## Current baseline (live code)

| Claim | Path / symbol | Notes |
|-------|---------------|-------|
| … | `lib/…` @ main | verified |
| Existing GHA (if ops) | `.github/workflows/…` | verified |

Do **not** invent APIs. Unverified → mark **Unverified** and either verify or
narrow scope.

## Design

- Behavior, protocol versions, state machines, error paths
- Insertion points (which module owns the new field / message type)
- Edge cases: empty session, Wasm load fail, API 4xx/5xx, mobile ~390px, refresh
- Performance notes when relevant (poll rates, payload size, Wasm rebuild need)

## Cloud ops path

> Required when **Production mutate?** is yes. Else: **N/A — no Production mutate**.

| Item | Lock |
|------|------|
| Primary operator surface | GitHub Actions → **workflow name** → Run workflow (inputs…) |
| Workflow to add/extend | `.github/workflows/….yml` |
| What the job runs | e.g. script X / `npm run …` **inside the job** |
| Secrets (names only) | `DATABASE_URL`, … — dual-store with Vercel when required |
| Guards | confirm string, dry_run, concurrency group, ubuntu-latest |
| Explicit non-paths | e.g. **not** seed; **not** personal laptop npm |
| After job | Vercel env flip / smoke / verify steps (UI or public smoke) |

## Living docs plan

> Always fill. Use N/A per row with why — do not omit the table.

| Surface | Change | Notes |
|---------|--------|-------|
| `docs/…` | add/update section … | timeless; **no** phase/issue process artifacts |
| `AGENTS.md` | infra table / rules / skills | |
| `README.md` | visitor pointer / no change | |
| `SECURITY.md` | … / N/A | |
| `.env.example` | … / N/A | |

## Implementation order

1. …
2. … (include workflow + docs in the same epic/phase that needs them — do not
   defer cloud ops to “later docs-only”)
3. …

## Testing

| # | Case | Layer | Type | Command / method |
|---|------|-------|------|------------------|
| 1 | … | DOM / harness / API / GHA | unit / integration / operator | agent workspace or CI |

**Minimum locked** rows (must pass for DoD) vs full matrix.

Always include:

- Unit tests for pure TS helpers (`lib/*.test.ts`) when logic is non-trivial
- Bridge / protocol cases when message shapes change
- Server route cases when `/api/*` changes (no real key in tests)
- Operator checklist when UI is play-visible (host shell and/or canvas)
- Build gates run in **agent workspace or CI**: `npm test`, `npm run typecheck`,
  `npm run build` (harness artifact / DO runner when Wasm changes)
- When cloud ops ships: how the workflow is validated (dry_run, unit tests for
  scripts, or documented dispatch smoke on throwaway DB)

## Definition of done

- [ ] …
- [ ] Tests green (commands listed; cloud agent/CI — not human laptop)
- [ ] No dual-chat regression (if UI)
- [ ] **Cloud ops:** GHA primary path shipped or explicit N/A
- [ ] **Living docs:** listed surfaces updated (timeless; no phase/issue theater)
- [ ] AGENTS.md / README.md considered (updated or N/A justified)
- [ ] Parent checklist items mappable (phase plans)

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| … | … |
| Laptop-only cutover / missing GHA | … |

## Open questions

Only **user** decisions. In-scope engineering choices must be **locked** above,
not left open.

## Phase map (parent plans only)

| Phase | Issue | Deliverable | Depends on |
|------:|-------|-------------|------------|
| 1 | (create then fill) | … | — |
| 2 | … | … | Phase 1 |

## References

- Related issues, docs, prior handoffs (**issues only** — do not copy this list
  into product docs as the explanation of the feature)
```

### Caps table — mandatory for every cap/limit/budget

Any cap, limit, or budget the plan adds **or** changes (value + rationale + code
location) MUST appear in a dedicated **Caps table**. Do not bury a new cap in
prose. Generous default for **NEW** caps/ceilings (no cap / the real transport
ceiling) — a brand-new cap is not a "change" and is not itself a blocker, but
still goes in the table. **Any change to an existing cap — a raise OR a
lowering — is a BLOCK + human decision** (see plan-review): plan-review may
**suggest** it, the implement-plan agent may **decide** it is warranted, but
only a **human** **approves**, on the plan's explicit justification / defense.
The defense must always account the budget against the **inviolable transport
ceiling of the wire that carries it** (Function request/response, server action,
Blob object, Redis, …) and state residual risk — even a **raise** can exceed
that ceiling (the #511/#525 Function-body class) and must die at the human gate.

```markdown
## Caps table

| Cap / ceiling | Value | Rationale | Code location |
|---------------|-------|-----------|---------------|
| … | … | why this value | `…` |

## Caps table — worked example (good raise vs blocked lower vs blocked over-ceiling raise)

| Cap / ceiling | Value | Wire & its ceiling | Defense | Verdict |
|---------------|-------|--------------------|---------|---------|
| NEW `HARNESS_SESSION_MAX_BODY_BYTES` | 8 MiB | Blob object — client→Blob presigned PUT, not a Function body | generous default for a NEW cap on a Blob carrier below its ceiling | **OK** — not a change; in table |
| lower `HARNESS_SESSION_MAX_ATTACHED_BODY_BYTES` 256 KiB → 128 KiB | 128 KiB | Function prompt/system payload | measured budget drop + budget-vs-transport-ceiling accounting + residual risk | **BLOCK → human decision** |
| raise `HARNESS_SESSION_MAX_FUNCTION_BODY_BYTES` 2 MiB → 8 MiB | 8 MiB | Function request — Vercel ceiling 4.5 MB | **above** the 4.5 MB Function ceiling; cannot safely reach | **BLOCK → human decision** (over-ceiling raise) |
```

A **good raise** keeps the value ≤ the transport ceiling of its carrier and is
tabled — yet **any** change to an existing cap still routes to a human. A
**blocked lower** ships without a human decision + defense. A **blocked
over-ceiling raise** bumps a function-carried cap above its inviolable ceiling
(the #511/#525 class).

### Architectural decisions — when mandatory

Create a non-empty **Architectural decisions** table if any of:

- New bridge protocol field / version bump  
- Moving ownership across DOM ↔ harness ↔ backend  
- New persistence, auth, or multi-user model  
- New deploy / artifact / runner requirement  
- **New or changed Production mutate / cutover path** (GHA vs script-only)  
- Anything that affects **clone-and-run-for-your-own-project** reusability  
- Public API shape for `/api/*`

---

## 4. Quality bar (self-check before filing)

```text
[ ] AGENTS.md + feature-divide read this session
[ ] Baseline table grounded in live files (+ workflows if ops)
[ ] **Caps table** present for every cap/limit/budget (value + rationale + location); generous default for NEW caps; any **change** to an existing cap (raise or lower) carries a wire/ceiling justification for the human gate
[ ] Layers table filled; no forbidden dual-UI
[ ] Architectural decisions present or explicit N/A
[ ] Cloud ops path: GHA primary if Production mutate; else explicit N/A
[ ] Living docs table filled; AGENTS + README considered
[ ] No plan to put phase/issue process artifacts into docs/*
[ ] Tests matrix has edge cases, not only happy path
[ ] DoD checkboxes prove the goals (including ops + docs)
[ ] Secrets stay server-side
[ ] Zig-only-on-runner constraint respected if harness changes
[ ] Reusability: no hardcoding single-tenant forever without note
[ ] Open questions empty for in-scope locks
```

---

## 5. Publish with `gh` (issues)

### Labels / milestones (optional)

Use existing repo labels/milestones when present. Do not invent a label taxonomy
unless the user asks.

### Create parent (or single) plan

```bash
OWNER=btipling
REPO=invincible

gh issue create \
  --repo "$OWNER/$REPO" \
  --title "plan: <short topic>" \
  --body-file /tmp/plan-body.md
# capture URL / number from output
```

Title conventions:

| Kind | Title pattern |
|------|----------------|
| Parent | `plan: <topic>` or `plan: <topic> (parent)` |
| Phase | `plan: <topic> — phase N — <slice>` |
| Single | `plan: <topic>` |

### Create phase issues (optional)

After parent `#P` exists:

```bash
# body MUST include: Parent: #P  (and the full phase plan format)
gh issue create \
  --repo "$OWNER/$REPO" \
  --title "plan: <topic> — phase N — <slice>" \
  --body-file /tmp/phase-N-body.md
```

**Required cross-links:**

1. Each phase body header: **`Parent: #P`**
2. Parent body **Phase map** table: link each phase issue number once known  
   (`gh issue edit P --body-file …` after phases exist)
3. Optional GitHub sub-issue / tasklist in parent:

   ```markdown
   ## Phase issues
   - [ ] #101 Phase 1 — …
   - [ ] #102 Phase 2 — …
   ```

### Update after plan-review

Default: plan-review edits the **same issue body** (Status, Review notes, locks).
Do not fork a second “reviewed” issue unless the user asks.

### Branch naming (optional)

If implementation will use a feature branch, record it in the header:

`plan/<topic-slug>` or `feat/<topic-slug>` — do not create the branch unless
useful for accompanying docs; **the plan of record is the issue**.

---

## 6. Chat output after filing

Report to the user:

1. Parent (or single) issue URL + number  
2. Phase issue URLs (if any)  
3. One-line summary of scope + layers + **ops/docs** (GHA? which docs?)  
4. Suggested next step: **plan-review** on the issue(s), then implement  

Do **not** start coding unless the user explicitly asks.

---

## 7. Anti-patterns

- Plan only in chat / local markdown with no GitHub issue  
- Phase issues with **no parent link**  
- “Add tests later” with empty matrix  
- Architectural change with no decisions table  
- DOM dual chat “just for MVP” without exception + exit criteria  
- Secrets or Gateway calls from Wasm  
- Re-asking user to configure already-**Done** infra  
- Mentioning unrelated products / engines in the plan body  
- Placeholder issue bodies (`TODO`, `TBD` for in-scope locks)  
- **Production cutover as “run npm on a machine” with no GHA**  
- **Script-only ops** documented as the primary human path  
- **Living docs that narrate phases / issue numbers** instead of current system  
- Deferring “we’ll add the workflow later” while shipping the mutate script  
- Treating an AGENTS.md sentence as a substitute for a real operator path  

---

## 8. Minimal checklist

```text
[ ] gh auth OK
[ ] AGENTS.md + feature-divide + live baseline (+ workflows if ops)
[ ] Format §3 complete (incl. Cloud ops path + Living docs plan)
[ ] Parent issue created (or single)
[ ] Phase issues created with Parent: #N
[ ] Parent phase map updated with numbers
[ ] User given URLs + next step (plan-review)
```
