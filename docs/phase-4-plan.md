# Phase 4 plan — Wasm-first harness MVP

**Status:** active · **4.1 product contract landed** · Phase 3 = pipeline PoC only

| | |
|--|--|
| **Epic** | [#27](https://github.com/btipling/invincible/issues/27) |
| **Milestone** | [Phase 4 — Wasm-first harness MVP](https://github.com/btipling/invincible/milestone/4) |
| **Feature divide** | **[feature-divide.md](feature-divide.md)** (source of truth) |
| **Prod** | https://invincible-dun-ten.vercel.app/harness |
| **Repo** | https://github.com/btipling/invincible |

## Why this phase exists

Phase 3 proved: DO Zig build → artifact → Vercel → bridge → optional canvas.

It did **not** ship a harness MVP. Chat UX was React; Wasm was a side panel. **That is a proof of concept, not the product.**

**Phase 4 makes Wasm the harness.** DOM is host shell only (load module, secrets, session storage, `POST /api/chat`).

## Product rule (non-negotiable)

1. **Wasm is the harness** — transcript, composer, agent chrome live in dvui.  
2. **DOM is the host shell** — nav, load/error, bridge, network, SessionStore.  
3. **No dual chat** — no competing React agent panel for core path.  
4. **MVP acceptance:** multi-turn session completable **only** in Wasm UI.

Full table: [feature-divide.md](feature-divide.md).

## Issue map (execution order)

| Order | Issue | Title | Status |
|------:|-------|--------|--------|
| 1 | [#28](https://github.com/btipling/invincible/issues/28) | 4.1 Product contract | **Done** (this contract) |
| 2 | [#29](https://github.com/btipling/invincible/issues/29) | 4.2 Host shell: demote DOM panel | next |
| 3 | [#30](https://github.com/btipling/invincible/issues/30) | 4.3 dvui transcript + composer | |
| 4 | [#31](https://github.com/btipling/invincible/issues/31) | 4.4 Bridge v2 session sync | |
| 5 | [#32](https://github.com/btipling/invincible/issues/32) | 4.5 Wire Wasm-primary loop | |
| 6 | [#33](https://github.com/btipling/invincible/issues/33) | 4.6 Session restore into Wasm | |
| 7 | [#34](https://github.com/btipling/invincible/issues/34) | 4.7 dvui UX polish | |
| 8 | [#35](https://github.com/btipling/invincible/issues/35) | 4.8 Phase 4 docs handoff | |

## Definition of done (phase)

- [ ] User completes multi-turn agent session **in Wasm** without DOM transcript  
- [ ] DOM is shell/chrome only (no competing chat panel)  
- [ ] Host still owns Gateway + SessionStore  
- [ ] Build/ship path unchanged (DO + option B)  
- [ ] Docs + AGENTS feature divide updated  

### MVP-not-PoC checklist (user-visible)

| Check | Fail if… |
|-------|----------|
| Open `/harness` | First useful surface is a React chat card |
| Type + send | Must use DOM textarea as primary |
| Read reply | Reply only appears in DOM bubbles |
| Second turn | Context/history only visible in React |
| Mobile ~390px | Canvas hidden behind “Show Wasm” |

## Constraints (unchanged)

1. Zig only on `invincible-do-1`  
2. No Gateway secrets in client/Wasm  
3. Asteronica TEAL / WARM / EMBER (`lib/palette.ts` + `native/harness/src/palette.zig`)  
4. Option B artifacts (no MB Wasm in git)  
5. Do not nag about already-configured deploy hook / tokens ([AGENTS.md](../AGENTS.md))  

## Suggested first message

> Continue Invincible Phase 4 from `docs/phase-4-plan.md` and epic #27. Wasm-primary harness MVP. 4.1 done — continue at #29 (host shell) / #30 (dvui workspace). Repo: btipling/invincible. Prod: https://invincible-dun-ten.vercel.app. Do not re-do Phase 1–3.
