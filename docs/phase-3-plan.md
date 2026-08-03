# Phase 3 plan — Zig/dvui Wasm harness

**Status: complete** (issues 3.1–3.11). Operator handoff: **[phase-3-handoff.md](phase-3-handoff.md)**.

| | |
|--|--|
| **Epic** | [#15](https://github.com/btipling/invincible/issues/15) |
| **Milestone** | [Phase 3 — Zig/dvui Wasm harness](https://github.com/btipling/invincible/milestone/3) |
| **Board** | https://github.com/users/btipling/projects/1/views/1 |
| **Prod app** | https://invincible-dun-ten.vercel.app |
| **Harness** | https://invincible-dun-ten.vercel.app/harness |
| **GitHub** | https://github.com/btipling/invincible |

## Product intent

In-browser **agent harness** (Wasm), not a CLI clone and not a Chrome extension:

- **UI / loop:** Zig + [dvui](https://github.com/david-vanderson/dvui) compiled to Wasm  
- **Host:** Next.js on Vercel (Asteronica palette)  
- **Inference:** Vercel AI Gateway via existing `POST /api/chat` (server-side key)  
- **Build:** DigitalOcean self-hosted runner `invincible-do-1` (Zig **0.16.0**)  
- **Storage:** no local FS as source of truth — `SessionStore` (memory + localStorage); cloud later  

## Already done (do not rebuild Phase 1–3)

### Phase 1
- Next.js playground + `/api/chat` + AI Gateway  
- Palette: `lib/palette.ts`  
- Live: https://invincible-dun-ten.vercel.app  

### Phase 2
- Self-hosted runner **`invincible-do-1`** (host inventory private)  
- Runner **`invincible-do-1`** · labels `self-hosted`, `invincible`, `zig`  
- Zig **0.16.0** @ `/opt/zig/0.16.0`  
- Workflows: `runner-smoke`, `build-wasm` (placeholder `hello.wasm`)  
- Ops: [`docs/runner.md`](runner.md) · harden applied  
- IDs: [`docs/project-ids.md`](project-ids.md)  

### Phase 3
- Full issue map below — all closed  
- DOM agent panel + multi-turn + Wasm companion + Asteronica on both surfaces  
- Option B ship path + deploy-race wait-for-SHA  

## Issue map (execution order)

| Order | Issue | Notes |
|------:|--------|--------|
| 1 | [#16 3.1](https://github.com/btipling/invincible/issues/16) dvui spike | **Done** — [phase-3-dvui-spike.md](phase-3-dvui-spike.md) |
| 2 | [#17 3.2](https://github.com/btipling/invincible/issues/17) crate skeleton | **Done** — `native/harness/` |
| 3 | [#18 3.3](https://github.com/btipling/invincible/issues/18) CI harness artifact | **Done** — `build-harness.yml` → `harness-wasm` |
| 4 | [#19 3.4](https://github.com/btipling/invincible/issues/19) ship to Vercel static | **Done** — option B prebuild fetch |
| 5 | [#20 3.5](https://github.com/btipling/invincible/issues/20) `/harness` page | **Done** — App Router host |
| 6 | [#21 3.6](https://github.com/btipling/invincible/issues/21) JS↔Wasm bridge | **Done** — `harnessBridge` + `bridge.zig` |
| 7 | [#22 3.7](https://github.com/btipling/invincible/issues/22) wire Gateway | **Done** — `harnessChat` → `/api/chat` |
| 8 | [#23 3.8](https://github.com/btipling/invincible/issues/23) session model | **Done** — MVP store + [session-model.md](session-model.md); real cloud deferred |
| 9 | [#24 3.9](https://github.com/btipling/invincible/issues/24) MVP UX loop | **Done** — DOM agent panel |
| 10 | [#25 3.10](https://github.com/btipling/invincible/issues/25) polish | **Done** — a11y, MIME, limits; later Asteronica on dvui |
| 11 | [#26 3.11](https://github.com/btipling/invincible/issues/26) docs | **Done** — this plan + [phase-3-handoff.md](phase-3-handoff.md) |

## Definition of done

- [x] `/harness` loads Wasm in prod/preview, clean console  
- [x] Prompt → AI Gateway → text visible in harness  
- [x] Wasm built on `invincible-do-1`, not laptop-only  
- [x] No Gateway secrets in client/Wasm  
- [x] Docs: phase plan, handoff, runner, limits, session-model, harness README  

## Constraints for implementers

1. **Self-hosted only** for Zig compile: `runs-on: [self-hosted, invincible, zig]`  
2. **Palette** TEAL / WARM / EMBER — DOM `lib/palette.ts`, dvui `native/harness/src/palette.zig`  
3. **Private repo curl:** `scripts/README.md` `gh_raw` + Contents:Read PAT  
4. **DO host already exists** — see runner inventory  
5. Prefer extending `native/harness` + `HarnessHost` over new infra  
6. **Do not nag** about configured secrets / deploy hook — [AGENTS.md](../AGENTS.md)  

## Rebuild path (DO → Vercel)

**Option B:** Vercel **build** downloads Actions artifact; **no Wasm binaries in git**.

```text
invincible-do-1  →  Actions artifact harness-wasm
                         ↓
              npm run prebuild (fetch-harness-artifact.mjs)
              · wait for build-harness on VERCEL_GIT_COMMIT_SHA when racing
                         ↓
                 public/harness/* (ephemeral on builder)
                         ↓
                    Vercel CDN / harness/*
```

| Step | How |
|------|-----|
| Compile | `build-harness.yml` on `[self-hosted, invincible, zig]` |
| Artifact | name **`harness-wasm`** (`harness.wasm` + `web.js`) |
| Vercel | `prebuild` → `node scripts/fetch-harness-artifact.mjs` |
| Auth | Vercel env **`HARNESS_ARTIFACT_TOKEN`** (already configured) |
| Race | [harness-deploy-race.md](harness-deploy-race.md) |
| Serve | `/harness/harness.wasm` (`application/wasm`), `/harness/web.js` |

```bash
gh workflow run build-harness.yml
export HARNESS_ARTIFACT_TOKEN=…   # local only
npm run fetch-harness && npm run dev
```

**Do not** commit `public/harness/*.wasm`.

## Suggested first message for a new session

> Continue Invincible from `docs/phase-3-handoff.md` and `AGENTS.md`. Phase 3 complete. Repo: btipling/invincible. Prod: https://invincible-dun-ten.vercel.app. Do not re-do Phase 1–3.

## References

- Operator handoff: [phase-3-handoff.md](phase-3-handoff.md)  
- Limits: [harness-limits.md](harness-limits.md)  
- Session: [session-model.md](session-model.md)  
- Runner: [runner.md](runner.md)  
- Bridge protocol: [native/harness/README.md](../native/harness/README.md)  
- dvui: https://github.com/david-vanderson/dvui  
