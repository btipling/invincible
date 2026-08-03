# Phase 4 plan — Wasm-first harness MVP

**Status:** open · Phase 3 = pipeline PoC only

| | |
|--|--|
| **Epic** | [#27](https://github.com/btipling/invincible/issues/27) |
| **Milestone** | [Phase 4 — Wasm-first harness MVP](https://github.com/btipling/invincible/milestone/4) |
| **Prod** | https://invincible-dun-ten.vercel.app/harness |
| **Repo** | https://github.com/btipling/invincible |

## Why this phase exists

Phase 3 proved: DO Zig build → artifact → Vercel → bridge → optional canvas.

It did **not** ship a harness MVP. Chat UX is React; Wasm is a side panel. That is a proof of concept, not the product.

**Phase 4 makes Wasm the harness.** DOM is host shell only (load module, secrets, session storage, `POST /api/chat`).

## Issue map (execution order)

| Order | Issue | Title |
|------:|-------|--------|
| 1 | [#28](https://github.com/btipling/invincible/issues/28) | 4.1 Product contract: Wasm-primary (kill dual-chat) |
| 2 | [#29](https://github.com/btipling/invincible/issues/29) | 4.2 Host shell: demote DOM agent panel |
| 3 | [#30](https://github.com/btipling/invincible/issues/30) | 4.3 dvui agent workspace: transcript + composer |
| 4 | [#31](https://github.com/btipling/invincible/issues/31) | 4.4 Bridge v2: session sync |
| 5 | [#32](https://github.com/btipling/invincible/issues/32) | 4.5 Wire Wasm-primary loop via `/api/chat` |
| 6 | [#33](https://github.com/btipling/invincible/issues/33) | 4.6 Session restore into Wasm |
| 7 | [#34](https://github.com/btipling/invincible/issues/34) | 4.7 dvui UX polish |
| 8 | [#35](https://github.com/btipling/invincible/issues/35) | 4.8 Phase 4 docs + handoff |

## Target feature divide

| DOM (host shell) | Wasm (harness product) |
|------------------|-------------------------|
| Route `/harness`, nav | Full agent workspace |
| Load `web.js` + `harness.wasm` | Transcript UI |
| Bridge glue + poll submit | Composer + Send / smoke |
| `POST /api/chat` (secrets) | Busy / error chrome |
| `SessionStore` persist | Display hydrated session |
| Thin status chips (optional) | Primary keyboard/pointer UX |

## Definition of done

- [ ] User completes multi-turn agent session **in Wasm** without DOM transcript
- [ ] DOM is shell/chrome only (no competing chat panel)
- [ ] Host still owns Gateway + SessionStore
- [ ] Build/ship path unchanged (DO + option B)
- [ ] Docs + AGENTS feature divide updated

## Constraints (unchanged)

1. Zig only on `invincible-do-1`
2. No Gateway secrets in client/Wasm
3. Asteronica TEAL / WARM / EMBER
4. Option B artifacts (no MB Wasm in git)
5. Do not nag about already-configured deploy hook / tokens ([AGENTS.md](../AGENTS.md))

## Suggested first message

> Continue Invincible Phase 4 from `docs/phase-4-plan.md` and epic #27. Wasm-primary harness MVP. Start at #28 (4.1). Repo: btipling/invincible. Prod: https://invincible-dun-ten.vercel.app. Do not re-do Phase 1–3.
