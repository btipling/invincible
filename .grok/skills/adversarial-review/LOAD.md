# adversarial-review — load card (zero search)

When the user says “adversarial-review” / “red-team this PR” / “hostile review”:

## Hard gate

```bash
command -v gh >/dev/null && gh auth status
```

Refuse if that fails. Never GitHub MCP.

## FIRST — AGENTS.md

```bash
gh api "repos/btipling/invincible/contents/AGENTS.md?ref=main" --jq .content | base64 -d
```

Also load when relevant: `docs/feature-divide.md`, `SECURITY.md`.

## Load skill

```bash
gh repo clone btipling/invincible /tmp/invincible -- --depth 1
# .grok/skills/adversarial-review/SKILL.md
# .grok/skills/adversarial-review/references/checklist.md
# .grok/skills/adversarial-review/references/output-format.md
```

## Load PR

```bash
gh pr view <N> --repo btipling/invincible --json title,body,baseRefName,headRefName,files,url
gh pr diff <N> --repo btipling/invincible
```

## Then

1. Attack with lenses (checklist)  
2. Self-refute every candidate finding  
3. Report with verdict  
4. Default: post to PR via `gh pr review` / `gh pr comment`  
5. Do not implement fixes unless asked  
