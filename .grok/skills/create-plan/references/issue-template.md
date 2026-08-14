# Copy-paste skeletons

## Parent issue title

`plan: <topic> (parent)`

## Phase issue title

`plan: <topic> — phase <N> — <slice>`

## Minimal parent body (expand to full skill format)

```markdown
## Plan header

| Field | Value |
|-------|--------|
| **Status** | DRAFT |
| **Date** | YYYY-MM-DD |
| **Type** | parent |
| **Parent** | N/A |
| **Layers** | DOM, harness, Vercel backend |
| **Reusability impact** | … |
| **Production mutate?** | no \| yes — … |
| **Cloud ops path** | N/A \| GHA … |
| **Living docs** | paths or N/A |

## Summary

…

## Goals

| # | Goal | Success signal |
|---|------|----------------|
| 1 | | |

## Non-goals / out of scope

- 
- **Forbidden wiring:** dual DOM chat · secrets in Wasm · laptop-only Production ops

## Architectural decisions

| Decision | Options considered | Choice | Why |
|----------|--------------------|--------|-----|
| | | | |

### Layer placement

| Concern | Layer | Path(s) | Rationale |
|---------|-------|---------|-----------|
| | | | |

## Cloud ops path

N/A — no Production mutate.

<!-- or: GHA workflow name, inputs, secret names, guards, wrong-tool bans -->

## Living docs plan

| Surface | Change | Notes |
|---------|--------|-------|
| `docs/…` | | timeless; no phase/issue process artifacts |
| `AGENTS.md` | | |
| `README.md` | | |
| `SECURITY.md` | | |
| `.env.example` | | |

## Limits

N/A — no numeric limits.

<!-- or fill every cap this plan sets/inherits. vs live = raise | keep | new.
     lower is forbidden unless the operator asked or that limit already broke
     prod/CI (cite). Why must not be "to be safe" / "match personas" / "Gateway".
     We lower limits when something actually breaks because of them — not before. -->

| Limit | Value | Live on `main` | vs live | Enforced at | Why this number (not "to be safe") | Lower only if |
|-------|-------|----------------|---------|-------------|-------------------------------------|---------------|
| | | | | | | |

## Phase map

| Phase | Issue | Deliverable | Depends on |
|------:|-------|-------------|------------|
| 1 | TBD | | — |

## Testing

| # | Case | Layer | Type | Command / method |
|---|------|-------|------|------------------|
| 1 | | | | agent workspace / CI / GHA dry_run |

## Definition of done

- [ ] 
- [ ] Cloud ops: GHA primary path or N/A
- [ ] Living docs: listed surfaces updated (timeless)
- [ ] Limits: table filled or N/A — no numeric limits; no downward vs live

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| | |

## Open questions

- 
```

## Minimal phase body

```markdown
## Plan header

| Field | Value |
|-------|--------|
| **Status** | DRAFT |
| **Date** | YYYY-MM-DD |
| **Type** | phase N |
| **Parent** | #NN |
| **Layers** | … |
| **Reusability impact** | … |
| **Production mutate?** | no \| yes |
| **Cloud ops path** | N/A \| GHA … |
| **Living docs** | paths or N/A |

## Intent lock

**In scope:** …
**Out of scope:** …
**Forbidden:** dual DOM chat · secrets in Wasm · laptop-only Production ops · phase/issue theater in product docs · lowering a parent/live limit without operator ask or cited break

## Current baseline (live code)

| Claim | Path / symbol | Notes |
|-------|---------------|-------|
| | | |
| Existing GHA (if ops) | `.github/workflows/…` | |

## Design

…

## Cloud ops path

N/A — no Production mutate.

## Living docs plan

| Surface | Change | Notes |
|---------|--------|-------|
| `docs/…` | | |
| `AGENTS.md` | | |
| `README.md` | | |
| `SECURITY.md` | | |
| `.env.example` | | |

## Limits

N/A — no numeric limits.

| Limit | Value | Live on `main` | vs live | Enforced at | Why this number (not "to be safe") | Lower only if |
|-------|-------|----------------|---------|-------------|-------------------------------------|---------------|
| | | | | | | |

## Implementation order

1. 

## Testing

| # | Case | Layer | Type | Command / method |
|---|------|-------|------|------------------|
| 1 | | | | |

## Definition of done

- [ ] Maps to parent checklist item: …
- [ ] Cloud ops: GHA primary or N/A
- [ ] Living docs: timeless updates or N/A
- [ ] Limits: table filled or N/A; none lowered vs parent/live

## Corrections / refinements vs parent

| Topic | Parent said | This phase locks |
|-------|-------------|------------------|
| | | |
```
