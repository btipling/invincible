# Phase 4 plan — Wasm-first harness MVP

**Status: complete** (issues 4.1–4.8). Operator handoff: **[phase-4-handoff.md](phase-4-handoff.md)**.

| | |
|--|--|
| **Epic** | [#27](https://github.com/btipling/invincible/issues/27) |
| **Milestone** | [Phase 4 — Wasm-first harness MVP](https://github.com/btipling/invincible/milestone/4) |
| **Feature divide** | **[feature-divide.md](feature-divide.md)** |
| **Prod** | https://invincible-dun-ten.vercel.app/harness |
| **Repo** | https://github.com/btipling/invincible |

## Why this phase existed

Phase 3 proved the pipeline (DO → artifact → Vercel → bridge) but left **DOM as chat** and Wasm as a companion. That was a PoC, not a harness MVP.

**Phase 4 made Wasm the harness.** DOM is host shell only.

## Product rule (non-negotiable)

1. **Wasm is the harness** — transcript, composer, agent chrome in dvui.  
2. **DOM is the host shell** — nav, load/error, bridge, network, SessionStore.  
3. **No dual chat.**  
4. Multi-turn session completable **only** in Wasm UI.

## Issue map

| Order | Issue | Title | Status |
|------:|-------|--------|--------|
| 1 | [#28](https://github.com/btipling/invincible/issues/28) | 4.1 Product contract | **Done** |
| 2 | [#29](https://github.com/btipling/invincible/issues/29) | 4.2 Host shell demote DOM | **Done** |
| 3 | [#30](https://github.com/btipling/invincible/issues/30) | 4.3 dvui transcript + composer | **Done** |
| 4 | [#31](https://github.com/btipling/invincible/issues/31) | 4.4 Bridge v2 | **Done** |
| 5 | [#32](https://github.com/btipling/invincible/issues/32) | 4.5 Wire Wasm-primary loop | **Done** |
| 6 | [#33](https://github.com/btipling/invincible/issues/33) | 4.6 Session restore | **Done** |
| 7 | [#34](https://github.com/btipling/invincible/issues/34) | 4.7 UX polish | **Done** |
| 8 | [#35](https://github.com/btipling/invincible/issues/35) | 4.8 Docs handoff | **Done** |

## Definition of done (phase)

- [x] Multi-turn agent session **in Wasm** without DOM transcript  
- [x] DOM is shell/chrome only  
- [x] Host owns Gateway + SessionStore  
- [x] Build/ship path unchanged (DO + option B)  
- [x] Docs + AGENTS feature divide updated  

### MVP-not-PoC checklist

| Check | Pass criteria |
|-------|----------------|
| Open `/harness` | Full-bleed canvas is the workspace |
| Type + send | Canvas composer (Enter/Send) |
| Read reply | Assistant line in Wasm |
| Second turn | History in Wasm + host fold |
| Mobile ~390px | Completable without “Show Wasm” |

## Constraints

1. Zig only on `invincible-do-1`  
2. No Gateway secrets in client/Wasm  
3. Asteronica TEAL / WARM / EMBER  
4. Option B artifacts  
5. Do not nag about configured secrets ([AGENTS.md](../AGENTS.md))  

## Protocol

Host `HARNESS_PROTOCOL_VERSION` ↔ Wasm `PROTOCOL_VERSION` = **2**  
(hydrate batch, lifecycle read, message count).

## Suggested first message (after Phase 4)

> Continue Invincible from `docs/phase-4-handoff.md` and `AGENTS.md`. Phase 4 complete. Repo: btipling/invincible. Prod: https://invincible-dun-ten.vercel.app. Do not re-do Phase 1–4 or restore DOM dual-chat.

## References

- Handoff: [phase-4-handoff.md](phase-4-handoff.md)  
- Feature divide: [feature-divide.md](feature-divide.md)  
- Limits: [harness-limits.md](harness-limits.md)  
- Pipeline rebuild: [phase-3-handoff.md](phase-3-handoff.md) · [runner.md](runner.md)  
- Bridge: [native/harness/README.md](../native/harness/README.md)  
