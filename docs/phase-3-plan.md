# Phase 3 plan — Zig/dvui Wasm harness

**Handoff doc for new sessions.** Execute issues in order unless noted parallelizable.

| | |
|--|--|
| **Epic** | [#15](https://github.com/btipling/invincible/issues/15) |
| **Milestone** | [Phase 3 — Zig/dvui Wasm harness](https://github.com/btipling/invincible/milestone/3) |
| **Board** | https://github.com/users/btipling/projects/1/views/1 |
| **Prod app** | https://invincible-dun-ten.vercel.app |
| **GitHub** | https://github.com/btipling/invincible |

## Product intent

In-browser **agent harness** (Wasm), not a CLI clone and not a Chrome extension:

- **UI / loop:** Zig + [dvui](https://github.com/david-vanderson/dvui) compiled to Wasm  
- **Host:** Next.js on Vercel (Asteronica palette)  
- **Inference:** Vercel AI Gateway via existing `POST /api/chat` (server-side key)  
- **Build:** DigitalOcean self-hosted runner `invincible-do-1` (Zig **0.16.0**)  
- **Storage:** no local FS as source of truth — cloud/session later; memory OK for first demo  

## Already done (do not rebuild)

### Phase 1
- Next.js playground + `/api/chat` + AI Gateway  
- Palette: `lib/palette.ts`  
- Live: https://invincible-dun-ten.vercel.app  

### Phase 2
- Droplet `589481218` · `204.48.30.46` · nyc1  
- Runner **`invincible-do-1`** · labels `self-hosted`, `invincible`, `zig`  
- Zig **0.16.0** @ `/opt/zig/0.16.0`  
- Workflows: `runner-smoke`, `build-wasm` (placeholder `hello.wasm`)  
- Ops: [`docs/runner.md`](runner.md) · harden applied  
- IDs: [`docs/project-ids.md`](project-ids.md)  

## Issue map (execution order)

| Order | Issue | Notes |
|------:|--------|--------|
| 1 | [#16 3.1](https://github.com/btipling/invincible/issues/16) dvui spike | **Done** — see [phase-3-dvui-spike.md](phase-3-dvui-spike.md); dvui OK on 0.16.0 |
| 2 | [#17 3.2](https://github.com/btipling/invincible/issues/17) crate skeleton | **Done** — `native/harness/` |
| 3 | [#18 3.3](https://github.com/btipling/invincible/issues/18) CI harness artifact | **Done** — `build-harness.yml` → `harness-wasm` |
| 4 | [#19 3.4](https://github.com/btipling/invincible/issues/19) ship to Vercel static | **Done** — `public/harness/` committed assets |
| 5 | [#20 3.5](https://github.com/btipling/invincible/issues/20) `/harness` page | **Done** — App Router host + palette states |
| 6 | [#21 3.6](https://github.com/btipling/invincible/issues/21) JS↔Wasm bridge | After 3.5 |
| 7 | [#22 3.7](https://github.com/btipling/invincible/issues/22) wire Gateway | After 3.6 |
| 8 | [#23 3.8](https://github.com/btipling/invincible/issues/23) session model | Parallel after 3.6 |
| 9 | [#24 3.9](https://github.com/btipling/invincible/issues/24) MVP UX loop | After 3.7 |
| 10 | [#25 3.10](https://github.com/btipling/invincible/issues/25) polish | After 3.9 |
| 11 | [#26 3.11](https://github.com/btipling/invincible/issues/26) docs | Ongoing / end |

## Definition of done

- [ ] `/harness` loads Wasm in prod/preview, clean console  
- [ ] Prompt → AI Gateway → text visible in harness  
- [ ] Wasm built on `invincible-do-1`, not laptop-only  
- [ ] No Gateway secrets in client/Wasm  
- [ ] `docs/phase-3-plan.md` + runner/README updated  

## Constraints for implementers

1. **Self-hosted only** for Zig compile: `runs-on: [self-hosted, invincible, zig]`  
2. **Palette rules** from Phase 1 / webgpu-game (TEAL / WARM / EMBER)  
3. **Private repo curl:** `scripts/README.md` `gh_raw` + Contents:Read PAT  
4. **DO create** may 403 from Grok connector — host already exists  
5. Prefer extending `build-wasm` / `native/` over new infra  

## Suggested first message for a new session

> Continue Invincible Phase 3 from `docs/phase-3-plan.md`. Start with issue #16 (dvui Wasm spike on invincible-do-1). Do not re-do Phase 1–2. Repo: btipling/invincible. Prod: https://invincible-dun-ten.vercel.app.

## References

- dvui: https://github.com/david-vanderson/dvui  
- Runner ops: [runner.md](runner.md)  
- Phase 2 plan (done): [phase-2-plan.md](phase-2-plan.md)  


## Rebuild path (DO → Vercel)

**Chosen option for 3.4: B** — Vercel **build** downloads the latest Actions artifact; **no Wasm binaries in git**.

```text
invincible-do-1  →  Actions artifact harness-wasm
                         ↓
              npm run prebuild (fetch-harness-artifact.mjs)
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
| Auth | Vercel env **`HARNESS_ARTIFACT_TOKEN`** — fine-grained PAT, **Actions: Read** on this repo (Production + Preview). **Redeploy** after adding the var. |
| Serve | `/harness/harness.wasm` (`application/wasm`), `/harness/web.js` |

```bash
# after harness source change:
gh workflow run build-harness.yml
# then redeploy Vercel (push any commit, dashboard Redeploy, or Deploy Hook)
# local:
export HARNESS_ARTIFACT_TOKEN=…   # or gh auth
npm run fetch-harness && npm run dev
```

**Do not** commit `public/harness/*.wasm` — gitignored.

