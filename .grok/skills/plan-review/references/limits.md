# Limits — generous; never lower (caution theater)

Shared policy for **create-plan** and **plan-review**. This is an operator
lock, not a suggestion.

---

## Why this exists (read this)

The operator has had this conversation too many times and is done having it.

Reviewers and planners keep inventing **Arduino-era caps** — 4 KiB session
`meta`, 16 KiB persona/skill bodies, 32-character slugs, tiny retry loops —
and calling it “safety,” “defense in depth,” or “matching personas.”

**Nothing has broken.** This product is a **cloud harness on Vercel**. Request
bodies are megabytes. Redis values are megabytes. Session messages here already
go to 256 KiB. Prompt validation allows millions of characters. There is no
Vercel AI Gateway, Vercel function, or Upstash limit that forces 16 KiB of
user text.

Those tiny numbers are **caution theater**. They handicap anyone writing a
real AGENTS.md-style persona or playbook. They force a follow-up plan to undo
the cap. They waste the same argument again.

**Policy:**

- Limits ought to be **generous**.
- **We lower them when something actually breaks because of the limit.**
- Not before. Not “just in case.” Not “to match a sibling.”
- **plan-review is not allowed to lower any limit.** Doing so is a skill
  failure. Restore the number instead.

A named bound is fine. A generous bound is required. A handicapping bound
invented in review is forbidden.

---

## What counts as a limit

Any numeric cap the plan sets, inherits, copies, or changes:

bytes · chars · counts · timeouts · retries · attempt loops · slug / name /
description / body / meta / payload / ring / snapshot sizes · max attachments ·
max rows returned · poll intervals used as ceilings

Not a “limit” for this table: palette tokens, protocol version integers,
HTTP status codes.

---

## Required issue table

Every plan issue (parent, phase, or single) that touches a numeric cap **must**
include this section in the **GitHub issue body**. create-plan writes it.
plan-review requires it and **must not shrink any Value**.

If the plan truly has none:

```markdown
## Limits

N/A — no numeric limits.
```

Otherwise:

```markdown
## Limits

| Limit | Value | Live on `main` | vs live | Enforced at | Why this number (not "to be safe") | Lower only if |
|-------|-------|----------------|---------|-------------|-------------------------------------|---------------|
| persona body / snapshot | 64 KiB | 16 KiB | **raise** | `lib/tenancy/userPersonas.ts`, `lib/sessionCloudCaps.ts` | real AGENTS.md length; meta budget raised to match | this exact cap caused a prod/CI break (cite) |
| skill body | 64 KiB | 16 KiB | **raise** | `lib/tenancy/userSkills.ts` | playbook text; **not** in session meta | inject/OOM actually fails in prod (cite) |
```

| Column | Rule |
|--------|------|
| **Limit** | Human name of the cap |
| **Value** | What **this plan** ships |
| **Live on `main`** | Current constant / N/A if new |
| **vs live** | `raise` \| `keep` \| `new` — **`lower` is forbidden** unless the operator explicitly asked **or** that limit already broke production/CI (cite in Why) |
| **Enforced at** | File/symbol that will reject oversize |
| **Why** | Product reason. **Banned phrases:** “to be safe,” “defense in depth,” “match personas,” “caution,” “Arduino,” “just in case,” “Gateway limit” (unless you cite a real platform doc that actually imposes it — Vercel function bodies are megabytes; they do not) |
| **Lower only if** | The break that would justify shrinking later. Must be a **real failure mode**, not a vibe |

---

## plan-review — forbidden edits

| You may | You may not |
|---------|-------------|
| Add a missing **Limits** table that records existing or proposed numbers | Fill that table by inventing **smaller** numbers |
| **Raise** a cap and raise any coupled budget (e.g. persona snapshot **and** `HARNESS_SESSION_MAX_META_BYTES`) | Lower a live cap, a parent lock, or a number the plan already chose |
| Keep a live value (`vs live = keep`) | “Tighten to 16 KiB to match personas” when the physical budget is **not** shared |
| Restore a draft that already lowered a cap | Put a downward number in Review notes and call it a fix |

If you are tempted to shrink a number: **stop**. That feeling is the theater
this policy exists to kill. Either leave it or raise it.

### Shared-budget exception (the only honest coupling)

A smaller number is justified only when the value **literally sits inside**
another capped blob **and** that outer cap is named in the same table.

Example that is real: `meta.personaSnapshot` lives inside
`HARNESS_SESSION_MAX_META_BYTES`. If you raise the snapshot, raise whole-`meta`
in the same row set.

Example that is **not** real: skill bodies are **not** snapshotted into `meta`
(only slugs). Copying the persona 16 KiB onto skills is sibling-matching
theater.

### Platform limits (do not invent)

Do **not** claim Vercel AI Gateway, Vercel serverless, or Redis force 16 KiB
of user text. They do not. If a platform cap is real, cite the vendor doc
and the number **they** publish, then size ours **under that published number
with headroom** — still generous relative to user content.

---

## Scoring (plan-review)

| Score | Meaning |
|-------|---------|
| 5 | Limits table complete; values generous or honestly coupled; no downward vs live/parent |
| 4 | Table present; one soft Why-column nit |
| 3 | Caps exist but table missing or Why is “safety” |
| 2 | Plan or review lowers a cap without operator ask / cited break |
| 1 | Systematic Arduino-capping; review itself introduced the shrink |

**Blocker:** any downward change without operator ask or cited break.  
**Major:** caps exist, no Limits table.

---

## create-plan — authoring rules

- Prefer **raising** a stale tiny cap when the new work will actually use the
  room (personas, skills, session meta, playbooks).
- If you keep a live tiny cap, the Why column must say **why we are not
  raising it this time** (out of scope), not why the tiny number is virtuous.
- Never introduce a new cap smaller than the live sibling **unless** they
  share a physical budget named in the table.
- Never cite “plan-review will want it smaller.” plan-review is forbidden
  from wanting that.
