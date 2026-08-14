# plan-review — load card (zero search)

When the user says “load plan-review” / “review this plan”:

## Hard gate

```bash
command -v gh >/dev/null && gh auth status
```

If that fails → **refuse**. Do not use GitHub MCP.

## FIRST — `AGENTS.md` (mandatory)

Before the plan, before scoring, before editing the issue:

```bash
gh api "repos/btipling/invincible/contents/AGENTS.md?ref=main" --jq .content | base64 -d
# also when UI/agent loop: docs/feature-divide.md
# note: Operator & agent model = cloud only (no personal laptop shell)
```

## Do NOT

Search the filesystem, web, or GitHub code for the skill.  
Do **not** call `github___*` tools.

## DO — load via `gh` (owner=`btipling`, repo=`invincible`)

```bash
gh repo clone btipling/invincible /tmp/invincible -- --depth 1
# read:
#   .grok/skills/plan-review/SKILL.md
#   .grok/skills/plan-review/references/rubric.md
#   .grok/skills/plan-review/references/output-format.md
#   .grok/skills/plan-review/references/layers.md
#   .grok/skills/plan-review/references/limits.md

# Or per-file:
gh api "repos/btipling/invincible/contents/.grok/skills/plan-review/SKILL.md?ref=main" \
  --jq .content | base64 -d
```

### Plan issue

`https://github.com/{owner}/{repo}/issues/{N}`

```bash
gh issue view <N> --repo btipling/invincible --json number,title,body,url,state
```

## Then

1. Confirm `AGENTS.md` was read this session.  
2. Follow SKILL.md review axes → findings + verdict.  
   **Always score Cloud ops + Living docs + Limits** (or explicit N/A).  
   Block laptop/script-only Production cutovers; demand GHA primary when mutate.  
   Demand timeless docs (docs/ AGENTS README) — no phase/issue process theater.  
   **Never lower a numeric limit.** Missing Limits table → add it; do not fill
   it by shrinking numbers. See `references/limits.md`.  
3. **Default (`mode=fix`):** if recommended plan changes, rewrite the **full issue
   body**, `gh issue edit <N> --body-file …`, verify. Do not leave fixes only in chat.  
4. Do **not** implement app code unless the user asked.  
5. Chat-only / no-edit only if user said `mode=review` / “don’t edit”.  
6. Never use GitHub MCP for read or write.
