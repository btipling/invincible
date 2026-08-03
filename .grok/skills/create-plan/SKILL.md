---
name: create-plan
description: >
  Create an implementation plan as a GitHub issue (optional phase child issues
  that reference the parent). Use when the user says "create-plan", "use the
  create-plan skill", "plan this feature", "write a plan for", "phase plan",
  or wants a feature broken into HANDOFF-READY issues before coding.
  Requires gh. Plans live in issues, not docs/*.md. Never GitHub MCP.
metadata:
  short-description: "Write feature plans as GitHub issues (parent + optional phase issues)"
  version: "1.0"
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

1. Read root **`AGENTS.md`** (main, or the branch the user named).
2. Read **`docs/feature-divide.md`** (DOM vs Wasm ownership).
3. Ground claims in **live code** on the branch you plan against (usually `main`).
4. Skim relevant prior COMPLETE plans / epics if the feature continues them.

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

## Summary

One short paragraph: what ships and why.

## Goals

| # | Goal | Success signal |
|---|------|----------------|
| 1 | … | … |

## Non-goals / out of scope

- …
- **Forbidden wiring:** … (e.g. dual DOM chat, secrets in Wasm)

## Architectural decisions

> Required when the work changes ownership, protocols, data flow, deploy path,
> persistence, or multi-tenant/reuse seams. For pure local polish, write
> **N/A — no new decisions** and one line why.

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

Do **not** invent APIs. Unverified → mark **Unverified** and either verify or
narrow scope.

## Design

- Behavior, protocol versions, state machines, error paths
- Insertion points (which module owns the new field / message type)
- Edge cases: empty session, Wasm load fail, API 4xx/5xx, mobile ~390px, refresh
- Performance notes when relevant (poll rates, payload size, Wasm rebuild need)

## Implementation order

1. …
2. …
3. …

## Testing

| # | Case | Layer | Type | Command / method |
|---|------|-------|------|------------------|
| 1 | … | DOM / harness / API | unit / integration / operator | `npm test` / manual |

**Minimum locked** rows (must pass for DoD) vs full matrix.

Always include:

- Unit tests for pure TS helpers (`lib/*.test.ts`) when logic is non-trivial
- Bridge / protocol cases when message shapes change
- Server route cases when `/api/*` changes (no real key in tests)
- Operator checklist when UI is play-visible (host shell and/or canvas)
- Build gates: `npm test`, `npm run typecheck`, `npm run build` (note harness
  artifact requirement if Wasm changes → DO runner / `build-harness`)

## Definition of done

- [ ] …
- [ ] Tests green (commands listed)
- [ ] No dual-chat regression (if UI)
- [ ] Docs / AGENTS updated if ownership or ops change
- [ ] Parent checklist items mappable (phase plans)

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| … | … |

## Open questions

Only **user** decisions. In-scope engineering choices must be **locked** above,
not left open.

## Phase map (parent plans only)

| Phase | Issue | Deliverable | Depends on |
|------:|-------|-------------|------------|
| 1 | (create then fill) | … | — |
| 2 | … | … | Phase 1 |

## References

- Related issues, docs, prior handoffs
```

### Architectural decisions — when mandatory

Create a non-empty **Architectural decisions** table if any of:

- New bridge protocol field / version bump  
- Moving ownership across DOM ↔ harness ↔ backend  
- New persistence, auth, or multi-user model  
- New deploy / artifact / runner requirement  
- Anything that affects **clone-and-run-for-your-own-project** reusability  
- Public API shape for `/api/*`

---

## 4. Quality bar (self-check before filing)

```text
[ ] AGENTS.md + feature-divide read this session
[ ] Baseline table grounded in live files
[ ] Layers table filled; no forbidden dual-UI
[ ] Architectural decisions present or explicit N/A
[ ] Tests matrix has edge cases, not only happy path
[ ] DoD checkboxes prove the goals
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
3. One-line summary of scope + layers  
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

---

## 8. Minimal checklist

```text
[ ] gh auth OK
[ ] AGENTS.md + feature-divide + live baseline
[ ] Format §3 complete
[ ] Parent issue created (or single)
[ ] Phase issues created with Parent: #N
[ ] Parent phase map updated with numbers
[ ] User given URLs + next step (plan-review)
```
