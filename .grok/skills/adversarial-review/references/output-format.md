# Adversarial review output format

Use this shape in chat and (default) as the PR comment body.

---

## Template

```markdown
# Adversarial review — PR #<N>

**Verdict:** BLOCK | CONCERNS | PASS WITH NOTES | INCOMPLETE
**Repo:** `btipling/invincible`
**Scope:** base ← head · N files · short change type
**Lenses run:** L1 … (skip: … with reason)
**AGENTS.md read:** yes

## Findings

| Sev | Lens | Finding | Break scenario | Refutation attempt | Confidence |
|-----|------|---------|----------------|--------------------|------------|
| Blocker | L2 | … | … | … | high |
| Major | L3 | … | … | … | high |
| Minor | L6 | … | … | … | medium |

## Residual risk

What could still go wrong even if every finding is fixed / if attack did not
breach — one short paragraph.

## Merge guidance

- BLOCK: do not merge until Blockers addressed (list owners/paths)
- CONCERNS: merge only with explicit accept of Majors
- PASS WITH NOTES: safe to merge from this attack; nits optional
- INCOMPLETE: re-run after providing PR access / fixing fetch

## What was not attacked

List out-of-diff systems not exercised (e.g. live DO runner, prod Gateway).
```

---

## Finding quality bar

Each row **must** include:

1. **Break scenario** — concrete steps or input that fails (not “might be wrong”).  
2. **Refutation attempt** — why a defender might dismiss it, and why that fails.  
3. **Path/symbol** in the Finding text when possible (`lib/foo.ts` · `parseChatBody`).  

Drop findings that cannot meet the bar.

---

## Tone

- Direct, specific, no hedging theater  
- No “great work!” preamble  
- No restating the PR description as a finding  
- Prefer tables over essays  

---

## Severity reminder

| Sev | Merge |
|-----|-------|
| Blocker | BLOCK |
| Major | CONCERNS (unless user accepts) |
| Minor / Nit | PASS WITH NOTES if no higher |
