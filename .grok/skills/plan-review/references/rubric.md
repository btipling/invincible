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
| 5 | Layer ownership perfect; reusability-aware; cloud-native ops; phase cut clean |
| 4 | Fits project; minor placement nits |
| 3 | Works but blurs DOM/harness/backend or soft on ops shell |
| 2 | Fights AGENTS.md / feature-divide / laptop-centric ops |
| 1 | Dual state / secret leakage / anti-reuse hardcoding |

### Prompt questions

- Who owns transcript? Composer? Gateway call? Session durability?  
- Does the plan reintroduce dual chat?  
- Are secrets server-only?  
- Config seams for clone + own Vercel?  
- Zig-only-on-runner respected?  
- Does any Production path assume a human laptop checkout?  

---

## Testing (1–5)

| Score | Meaning |
|-------|---------|
| 5 | Edge-rich matrix; operator checklist if UI; commands for agent/CI; GHA dry_run if ops; generator table if two producers |
| 4 | Strong unit coverage; small gaps |
| 3 | Happy-path only or missing integration where wiring lands |
| 2 | Vague “add tests” without cases, **or** two-producer persist/merge/adopt with no generator table |
| 1 | No test plan for non-trivial logic |

### Prompt questions

- Cases numbered and mapped to DoD?  
- Bridge tests for new message types?  
- API tests without real keys?  
- Operator path: load → send → read → multi-turn → mobile?  
- `npm test` / typecheck / build / harness CI listed for **agent/CI**, not human laptop?  
- If workflow ships: dry_run or script tests named?  
- If two producers write the same session/transcript/envelope/blob: is there a **generator table** (this producer's live reconstruction × the other's live persist points → expected body), not a hand-built `[user, tool, assistant]` or last-adversarial-review fixture?  
- Is `--changed` green on parse/clock/role-map claimed as merge/adopt DoD? (fail that claim)

### Common failure modes

- “Add tests later” / happy-path only  
- Shared-record write with tests that only prove parse + clock (named: #864 / PR #868 — five CONCERNS rounds)  
- Fixture copied from the last review finding instead of `runTurnLoop` reconstruction × host persist points  

### Score cap

- Two-producer persist / merge / LWW-adopt / parse in scope without a generator table: testing **≤ 2**, **Major**  

---

## Cloud ops (when Production mutate / cutover — else N/A)

| Score | Meaning |
|-------|---------|
| 5 | GHA primary path locked (name, inputs, secrets names, guards); wrong-tool bans; docs match |
| 4 | Solid GHA plan; minor input/docs polish |
| 3 | Script + vague “run in cloud” without concrete workflow |
| 2 | npm/script primary; GHA optional/deferred |
| 1 | Laptop-only or missing operator path for a required mutate |

### Prompt questions

- Is **workflow_dispatch** the primary human/operator surface?  
- Extend existing workflow or new file under `.github/workflows/`?  
- ubuntu-latest for DB/secrets? No PR trigger on mutate jobs?  
- Confirm + dry_run guards?  
- Dual-store: which secrets must match Vercel Production?  
- Seed vs backfill vs migrate: which is forbidden for this op?  
- Does DoD ship the workflow in the **same** phase as the script?  

### Common failure modes

- “Document `npm run db:…`” with no Actions job  
- “Cloud agent can run it” without a durable dispatch entrypoint  
- Re-using seed bootstrap for a non-seed cutover  
- Self-hosted runner for Production DB without design review  

---

## Living docs (when product/ops/agent surface changes — else N/A)

| Score | Meaning |
|-------|---------|
| 5 | docs + AGENTS + README (+ SECURITY/env as needed) planned; timeless; no process theater |
| 4 | Right surfaces named; small gaps |
| 3 | “Update docs if needed” without paths |
| 2 | Only plan-issue knowledge; or docs will be phase/issue narrative |
| 1 | Docs teach secrets/laptop-only Production ops |

### Prompt questions

- Which of `docs/*`, `AGENTS.md`, `README.md`, `SECURITY.md`, `.env.example` change?  
- Explicit N/A per skipped surface?  
- Will a **new** reader understand without issue history?  
- Forbidden: phase numbers, “see #95”, handoff checklists in product docs?  
- Ops steps lead with **Actions / Vercel UI**, not personal npm?  

---

## Cap governance (when the plan adds or changes any cap/ceiling/value)

Governs every plan that introduces or changes a cap, limit, or budget (request
size, message length, count bounds, meta ceilings, skill-body caps, etc.).

| Score | Meaning |
|-------|---------|
| 5 | Every cap in a **Caps table** (value + rationale + location); generous default for NEW caps; any change to an existing cap — raise OR lower — is a BLOCK routed to a **human** with the plan's explicit justification/defense (budget accounting vs the inviolable transport ceiling of the wire that carries the value + residual risk); a raise above that ceiling is blocked, not waived |
| 4 | Caps table present; minor gaps in the cap-change defense or one un-tabled value |
| 3 | New cap present but value not justified vs the transport ceiling, or a change to an existing cap ships without a real justification |
| 2 | Caps table missing / new cap buried in prose; a change to an existing cap proposed with no human-gate framing |
| 1 | A cap is silently changed (raised or lowered), or a new cap invented small, with no table, no human decision, and no defense |

### Prompt questions

- Does every added/changed cap appear in a dedicated **Caps table**?  
- Is the value **generous by default** for NEW caps (no cap / the real transport ceiling), and explained?  
- Does the plan **add** a cap (generous default, tabled) vs **change an existing cap** (raise OR lower → must be BLOCK + human decision)?  
- If any existing-cap change is present: is the plan carrying the explicit justification/defense — measured budget delta, budget-vs-transport-ceiling accounting incl. the ceiling of the wire that carries the value, residual risk?  
- Does a **raise** keep the value ≤ the inviolable ceiling of its carrier, or does it push over it (the #511/#525 Function-body class → Block)?  
- Who decides? plan-review **suggests** only; a decided-or-suggested change to an existing cap ⇒ **BLOCK**; only a **human** approves a raised or lowered cap.  

### Score cap / auto-Blocker

- A plan that **changes an existing cap** (raise OR lower) — whether suggested by
  plan-review or decided by the implement-plan agent — without an explicit human
  decision + justification/defense is a **Block** (constraint #14). Generous
  default is for NEW caps only. **No cap change is "never a blocker":** a raise
  above the transport ceiling of its carrier is the #511/#525 Function-body
  class and is also a Block.

---

## Parent adherence (phase only)

- Parent locked decisions: any reopened cell?  
- Parent phase checklist: 1:1 map from this DoD?  
- Prior phase COMPLETE or explicitly assumed?  
- Refinements table present when names/constants tighten?  
- Ops/docs split across phases without a owning phase for GHA?  

---

## Depth vs plan type

| Type | Expected depth |
|------|----------------|
| Parent roadmap | Locks, phases, non-goals, feasibility, ops/docs ownership — less code sketch |
| Pure / lib phase | Types, algorithms, test matrix heavy |
| Wire / bridge phase | Message shapes, poll order, host call sites |
| UI phase | Layout stability, palette, operator checklist |
| Backend phase | Authz, env, error contracts, no secret leakage |
| Ops / cutover phase | **GHA workflow design**, secret names, dual-store, smoke |
| Docs phase | Timeless guides; AGENTS/README; no issue archaeology |

Do **not** fail a parent roadmap for missing line-level code.  
**Do** fail a bridge phase with no message schema.  
**Do** fail an ops phase with no workflow.

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
- Laptop-only Production mutate: cloud ops **≤ 2**, **Blocker**  
