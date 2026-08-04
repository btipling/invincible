# Plan review output format

Use this shape in the chat response. Under default **`mode=fix`**, also mirror
fixes into the **GitHub issue body** before finishing.

---

## Template

```markdown
# Plan review — issue #<N>

**Verdict:** HANDOFF-READY | NEEDS REVISION | BLOCKED
**Repo:** `owner/repo`
**URL:** https://github.com/…/issues/N
**Class:** parent | phase N | UI | harness | backend | ops | docs | systems | refactor
**Parent:** #M (or N/A)
**Update:** issue body edited | no plan edits | skipped (mode=review)

## Scores

| Axis | Score (1–5) | Notes |
|------|-------------|-------|
| Correctness | | |
| Performance | | |
| Architecture | | |
| Testing | | |
| Cloud ops | | or N/A — no Production mutate |
| Living docs | | or N/A — no user/operator/agent surface change |
| Parent adherence | | or N/A |
| Layer placement | | or N/A |
| UI / harness UX | | or N/A |

## Findings

| Sev | Axis | Issue | Required fix | Landed in plan? |
|-----|------|-------|--------------|-----------------|
| Blocker | … | … | … | yes / deferred (reason) |
| Major | … | … | … | |
| Minor | … | … | … | |
| Nit | … | … | … | |

## Parent adherence

(If phase)

- Parent locks honored: …
- Refinements needed/documented: …
- Scope creep: none | list

## Layers / UI

- DOM / harness / Vercel assignment: …
- Dual-chat risk: none | mitigated | **Blocker**
- Layout stability: …
- Palette: …

## Cloud ops

- Production mutate: yes/no
- Primary path: GHA `…` | N/A | **missing**
- Script-only / laptop-only risk: none | mitigated | **Blocker**

## Living docs

- Surfaces: docs / AGENTS / README / SECURITY / .env.example
- Timeless (no phase/issue process artifacts): yes/no
- Gaps: …

## Baseline verification

| Claim in plan | Live check | Result |
|---------------|------------|--------|
| … | `path` @ main | OK / mismatch |
| Existing GHA (if ops) | `.github/workflows/…` | OK / missing |

## Plan edits applied

1. …
2. …

(Or: “None — HANDOFF-READY as written.”)

## Issue update

- Number: `#…`
- Full body update verified: yes (Review notes date / unique marker)
- Parent also updated: yes/no/n/a

## Residual risk

One short paragraph: what could still go wrong in implementation even if the
plan is followed (include missing-GHA residual if ops were soft).

## Next step

- If HANDOFF-READY: implement against the issue (follow plan order; ship GHA +
  docs in the same unit that needs them).
- If NEEDS REVISION with user decisions open: list only those questions.
- Do **not** end on “suggested edits” without updating the issue when mode=fix.
```

---

## Severity definitions

| Sev | Meaning | Verdict impact |
|-----|---------|----------------|
| **Blocker** | Would ship bugs, break feature-divide, leak secrets, dual-chat, or **laptop/script-only Production cutover** | Cannot be HANDOFF-READY until fixed **in the issue** |
| **Major** | Likely bug, parent drift, weak tests, layer blur, missing docs plan, phase/issue theater in product docs | Must be fixed in issue under mode=fix |
| **Minor** | Real improvement | Push into issue under mode=fix |
| **Nit** | Wording / optional | Optional lock |

---

## Fix-mode plan stamp (required when editing)

Near the top of the issue body:

```markdown
## Review notes (YYYY-MM-DD)

Reviewed issue `#…` for correctness / performance / architecture / testing
[/ cloud ops] [/ living docs] [/ parent adherence] [/ layers / UI].

| Issue | Severity | Resolution |
|-------|----------|------------|
| … | Major | Locked: … |

**Status:** HANDOFF-READY | NEEDS REVISION (remaining: …)
**Reviewed:** YYYY-MM-DD (axes…)
```

Keep the rest of the plan coherent with resolutions. Update the **entire** body
on the **same issue**. Prefer adding **Cloud ops path** and **Living docs plan**
sections when missing rather than burying fixes only in Review notes.

### Update anti-patterns

- Chat-only “you should change X” while the issue body is unchanged  
- Truncated / partial body  
- `PLACEHOLDER` / `TODO` for in-scope locks  
- Creating a new issue instead of editing the reviewed one (unless user asks)  
- Leaving Production mutate as npm-only after review  
