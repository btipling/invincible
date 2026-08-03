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

## Summary

…

## Goals

| # | Goal | Success signal |
|---|------|----------------|
| 1 | | |

## Non-goals / out of scope

- 

## Architectural decisions

| Decision | Options considered | Choice | Why |
|----------|--------------------|--------|-----|
| | | | |

### Layer placement

| Concern | Layer | Path(s) | Rationale |
|---------|-------|---------|-----------|
| | | | |

## Phase map

| Phase | Issue | Deliverable | Depends on |
|------:|-------|-------------|------------|
| 1 | TBD | | — |

## Testing

| # | Case | Layer | Type | Command / method |
|---|------|-------|------|------------------|
| 1 | | | | |

## Definition of done

- [ ] 

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

## Intent lock

**In scope:** …
**Out of scope:** …
**Forbidden:** dual DOM chat · secrets in Wasm · …

## Current baseline (live code)

| Claim | Path / symbol | Notes |
|-------|---------------|-------|
| | | |

## Design

…

## Implementation order

1. 

## Testing

| # | Case | Layer | Type | Command / method |
|---|------|-------|------|------------------|
| 1 | | | | |

## Definition of done

- [ ] Maps to parent checklist item: …

## Corrections / refinements vs parent

| Topic | Parent said | This phase locks |
|-------|-------------|------------------|
| | | |
```
