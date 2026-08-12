# Invincible adversarial checklist

Companion to `adversarial-review`. Use as attack prompts — not a script to
rubber-stamp “N/A” on everything.

---

## Path → lens map

| Paths in diff | Lenses |
|---------------|--------|
| `app/api/**`, `lib/chatServer*`, `lib/chatApi*`, `lib/model*` | L1, L2, L5, L6 |
| `lib/harnessBridge*`, `native/harness/src/bridge.zig` | L1, L2, L3, L5, L6 |
| `app/harness/**`, `native/harness/src/ui.zig`, `main.zig` | L1, L3, L5, L8, L9 |
| `lib/sessionStore*` | L1, L2, L5, L6 |
| `lib/palette*`, `native/harness/src/palette.zig` | L8, L9 |
| `.github/workflows/**`, `scripts/*runner*`, `scripts/fetch-harness*` | L2, L4, L7 |
| `docs/**`, `AGENTS.md`, `SECURITY.md`, `.grok/skills/**` | L7, L8 (accuracy, no secret leak in docs) |
| `public/harness/**` | L2, L4 — wasm/js must stay gitignored |

---

## L1 Correctness — prompts

- What is the worst `prompt` / pending-submit string? Empty? 10MB? Invalid UTF-8?  
- Double Send before ack — duplicate turns? Stuck Busy?  
- Protocol version skew TS vs Zig — does host fail closed?  
- `inv_*_copy` with `maxLen` < actual — truncation? panic? silent corrupt?  
- Refresh mid-flight — session vs Wasm transcript divergence?  
- Gateway returns empty / 502 — does UI show EMBER error in **harness**?  
- Lifecycle Boot→Ready→Busy→Error transitions illegal?  

## L2 Security — prompts

- Can `AI_GATEWAY_API_KEY` appear in client bundle, Wasm, network waterfall from browser, or error JSON?  
- New env vars: server-only or accidentally `NEXT_PUBLIC_`?  
- Workflow: any `pull_request` / `pull_request_target` on self-hosted?  
- `actions/checkout` of fork PR on DO runner?  
- Secrets printed in `echo` / debug logs?  
- Artifact token: least privilege? written to logs?  
- User content reflected into HTML without escape (DOM or future)?  
- SSRF / path traversal if scripts gain network or filesystem powers?  

## L3 Feature divide — prompts

- Does the PR add a React chat panel users will prefer over canvas?  
- Is transcript still **read** in Wasm? Composer still **typed** in Wasm?  
- “Temporary DOM fallback” without issue link + exit criteria?  
- Host status chips replacing in-canvas status?  

## L4 Deploy / CI — prompts

- Path filters miss a native change that must rebuild wasm?  
- Job `if:` still blocks non-main / PR?  
- Artifact name / SHA wait still correct after script edit?  
- Committed `*.wasm` / `web.js`?  
- Deploy hook still non-nag; regression if removed?  

## L5 Performance / abuse — prompts

- Poll interval under load?  
- History fold unbounded?  
- API body size limits?  
- Synchronous heavy work on main thread / render loop?  

## L6 Tests — prompts

- New branch logic without unit tests?  
- Bridge protocol tests for new exports?  
- chatServer parse/validation cases?  
- “Tests pass” only because assertions are vacuous?  
- **Test cost + DI in changed tests** (`lib/tenancy/*`, `lib/di/*`, `app/api`):
  - **Automatic fail:** changed/new tests construct a real expensive dep (PGlite, `createDbConnection`, bcrypt in setup, live Redis/HTTP) **or repeat that cost per test/file** instead of injecting via the module’s `db`/`connect`/factory seam, sharing one helper (`#431`), or fully mocking. `new PGlite()` outside the one shared helper is the named case — same rule for any slow dep DI already replaced.
  - Migrations re-applied per test / one chunk at a time? (apply once per file, batched)
  - `beforeEach` deleting N tables + re-seeding a DEK baseline every test? (one-time baseline + rollback if the surface allows — note PGlite’s single-connection mutex breaks raw SAVEPOINT / `db.transaction` straddling the shared `db`)
  - Do `dekVersion`/`kekVersion` counters rise across tests (isolation leaked)?
  - Vitest full-run change responsible for >+X% wall time — is `npm test`/`npm run test:changed` green and wrapper-free?  

## L7 Reusability — prompts

- Hardcoded `invincible-dun-ten` or single project id in runtime logic?  
- New infra that only works on one droplet without config?  
- Docs instructing others to copy private host inventory?  

## L8 Maintainability — prompts

- Protocol change without README / AGENTS note?  
- Palette.zig and palette.ts desynced?  
- Unnamed constants at trust boundaries?  

## L9 UX / palette — prompts

- Freehand hex? Tailwind default blue?  
- EMBER for non-errors?  
- Host layout shift moving primary actions?  
- Mobile ~390px broken by the change?  

---

## High-signal Blockers (auto-raise if present)

1. Secret or Gateway key in client, Wasm, or committed files  
2. Self-hosted workflow runnable from untrusted PR  
3. Dual product chat regression without explicit temporary exception  
4. Unbounded write into Wasm memory from untrusted length  
5. Production deploy can ship mismatched harness SHA with no wait/fail  

---

## Evidence quality

| Confidence | When |
|------------|------|
| high | Traced code path; reproduced logically; test gap proven |
| medium | Likely from pattern; full runtime not executed |
| low | Speculative; prefer drop or Nit unless security-adjacent |

Prefer fewer high-quality findings over a laundry list of nits.
