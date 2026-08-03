# Plan review rubric (detail)

Companion to `plan-review/SKILL.md`. Use these prompts while scoring.

---

## Correctness (1–5)

| Score | Meaning |
|-------|---------|
| 5 | Every critical claim verified against live code; edges locked; no internal contradictions |
| 4 | Solid; minor unverified corners or small doc nits |
| 3 | Plausible but several baseline mismatches or missing edges |
| 2 | Significant wrong APIs / order / ownership |
| 1 | Unsafe to implement; invents architecture |

### Prompt questions

- Does each baseline row match the file on `main` (or named branch)?
- Bridge protocol version / message shapes accurate?
- Empty session, failed Wasm load, API 4xx/5xx, refresh: behavior defined?
- Double-submit / busy state locked?
- Do DoD checkboxes actually prove the goals table?
- Open questions for **in-scope** work resolved?

### Common failure modes

- Plan cites bridge fields that do not exist on live protocol version  
- Session restore described without SessionStore API  
- “Temporary DOM chat” without exit criteria  
- API error shape wrong vs `lib/chatServer` / route  

---

## Performance (1–5)

| Score | Meaning |
|-------|---------|
| 5 | Hot path bounded; idle skip; costs named |
| 4 | Good; one soft spot documented |
| 3 | Acceptable but missing bounds |
| 2 | Likely hitch / unbounded work |
| 1 | Unsafe loops or payload blowups |

### Prompt questions

- Poll interval / rAF work bounded?  
- History fold grows without cap strategy?  
- Wasm rebuild + artifact race acknowledged when native changes?  
- Server retries stormy?  

---

## Architectural soundness (1–5)

| Score | Meaning |
|-------|---------|
| 5 | Layer ownership perfect; reusability-aware; phase cut clean |
| 4 | Fits project; minor placement nits |
| 3 | Works but blurs DOM/harness/backend |
| 2 | Fights AGENTS.md / feature-divide |
| 1 | Dual state / secret leakage / anti-reuse hardcoding |

### Prompt questions

- Who owns transcript? Composer? Gateway call? Session durability?  
- Does the plan reintroduce dual chat?  
- Are secrets server-only?  
- Config seams for clone + own Vercel?  
- Zig-only-on-runner respected?  

---

## Testing (1–5)

| Score | Meaning |
|-------|---------|
| 5 | Edge-rich matrix; operator checklist if UI; commands listed |
| 4 | Strong unit coverage; small gaps |
| 3 | Happy-path only or missing integration where wiring lands |
| 2 | Vague “add tests” without cases |
| 1 | No test plan for non-trivial logic |

### Prompt questions

- Cases numbered and mapped to DoD?  
- Bridge tests for new message types?  
- API tests without real keys?  
- Operator path: load → send → read → multi-turn → mobile?  
- `npm test` / typecheck / build / harness CI listed when relevant?  

---

## Parent adherence (phase only)

- Parent locked decisions: any reopened cell?  
- Parent phase checklist: 1:1 map from this DoD?  
- Prior phase COMPLETE or explicitly assumed?  
- Refinements table present when names/constants tighten?  

---

## Depth vs plan type

| Type | Expected depth |
|------|----------------|
| Parent roadmap | Locks, phases, non-goals, feasibility — less code sketch |
| Pure / lib phase | Types, algorithms, test matrix heavy |
| Wire / bridge phase | Message shapes, poll order, host call sites |
| UI phase | Layout stability, palette, operator checklist |
| Backend phase | Authz, env, error contracts, no secret leakage |

Do **not** fail a parent roadmap for missing line-level code.  
**Do** fail a bridge phase with no message schema.

---

## Layers & layout (when in scope)

### Prompt questions

- Is primary multi-turn UX in Wasm?  
- Any React chat panel competing?  
- Does host chrome mount/unmount move primary actions?  
- Reserved height for status/progress?  
- Mobile completable in harness?  

### Score cap

- Dual product chat unmitigated: architecture **≤ 2**, **Blocker**  
- Primary action reflow unmitigated: UI axis **≤ 2**, **Blocker**  
