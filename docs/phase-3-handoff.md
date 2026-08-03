# Phase 3 operator handoff

**Audience:** pipeline rebuild/deploy for the Phase 3 ship path.

> **Product direction:** Phase 3 was a **pipeline PoC**. **Phase 4 is complete** — Wasm-primary harness. Start at [`phase-4-handoff.md`](phase-4-handoff.md). This doc is **pipeline rebuild only** (DO → artifact → Vercel).

| | |
|--|--|
| **Repo** | https://github.com/btipling/invincible (private) |
| **Prod** | https://invincible-dun-ten.vercel.app |
| **Harness** | https://invincible-dun-ten.vercel.app/harness |
| **Epic** | [#15](https://github.com/btipling/invincible/issues/15) (Phase 3) |
| **Plan** | [phase-3-plan.md](phase-3-plan.md) |
| **Agents** | [AGENTS.md](../AGENTS.md) — infra already configured; do not nag about secrets |

---

## What Phase 3 shipped

| Surface | Behavior |
|---------|----------|
| `/` | Phase 1 prompt playground |
| `/harness` (Phase 3 era) | DOM chat + optional Wasm — **superseded** by Phase 4 Wasm-primary |
| Chat | `POST /api/chat` → Vercel AI Gateway (key **only** on server) |
| Session | `SessionStore` — memory + `localStorage` ([session-model.md](session-model.md)) |
| Palette | TEAL / WARM / EMBER on DOM **and** dvui (`lib/palette.ts` + `native/harness/src/palette.zig`) |
| Build | Zig **0.16.0** on `invincible-do-1` only → Actions artifact `harness-wasm` |
| Ship | Option B: Vercel `prebuild` downloads artifact (no MB Wasm in git) |

---

## Secrets policy (restate)

| Secret | Where | Never |
|--------|--------|--------|
| `AI_GATEWAY_API_KEY` | **Vercel only** (Production + Preview) | git, client JS, Wasm, session blobs, DO droplet |
| `HARNESS_ARTIFACT_TOKEN` | **Vercel only** — fine-grained PAT, **Actions: Read** on this repo | git, client |
| `VERCEL_DEPLOY_HOOK_URL` | **GitHub Actions secret** — already configured | git, chat as a setup task |
| DO / runner credentials | operator machine / DO | git |

**Inference never runs in Wasm.** Host calls `/api/chat`; Gateway key stays server-side.

Configured env is listed in [project-ids.md](project-ids.md) and [AGENTS.md](../AGENTS.md). Do not prompt the user to re-create them unless a build log proves a regression.

---

## Rebuild harness Wasm (source change in `native/harness/**`)

```text
1. Edit native/harness/ (or palette.zig / bridge / ui)
2. git push main  →  build-harness.yml on invincible-do-1
3. Artifact name: harness-wasm  (harness.wasm + web.js + index.html)
4. Vercel prebuild: scripts/fetch-harness-artifact.mjs
      - waits for build-harness on VERCEL_GIT_COMMIT_SHA when racing Git deploy
      - see harness-deploy-race.md
5. build-harness also pings VERCEL_DEPLOY_HOOK_URL after upload
6. Prod serves /harness/harness.wasm (Content-Type: application/wasm)
```

### Force CI only

```bash
gh workflow run build-harness.yml --repo btipling/invincible
gh run list --workflow=build-harness.yml --limit 3
```

### Local Next (after artifact exists)

```bash
export HARNESS_ARTIFACT_TOKEN=…   # or gh auth + GH_TOKEN
npm run fetch-harness
npm run dev
# open /harness
```

### Local Zig (only on a machine with Zig 0.16.0 — normally the DO runner)

```bash
# on invincible-do-1 or any host with pin:
cd native/harness && ./build.sh
# → native/dist/harness/{harness.wasm,web.js,…}
# optional: npm run path via scripts/sync-harness-public.sh if present
```

**Do not** commit `public/harness/*.wasm` or `web.js` — gitignored. Only `public/harness/README.md` is tracked.

---

## Verify production

```bash
# MIME
curl -sI https://invincible-dun-ten.vercel.app/harness/harness.wasm | grep -i content-type
# expect: application/wasm

# Smoke in browser
# 1. Open /harness — ready chip, empty state or restored localStorage session
# 2. Smoke: PONG or type prompt + ⌘/Ctrl+Enter
# 3. Show Wasm — Asteronica dark teal canvas (not light Adwaita)
# 4. Console: clean happy path (dvui WebGL noise OK)
```

Limits / a11y / palette: [harness-limits.md](harness-limits.md).

---

## Key paths

| Concern | Path |
|---------|------|
| Host UI | `app/harness/HarnessHost.tsx` |
| Bridge TS | `lib/harnessBridge.ts` |
| Chat loop | `lib/harnessChat.ts` |
| Session | `lib/sessionStore.ts` |
| Zig entry | `native/harness/src/main.zig` |
| Bridge Zig | `native/harness/src/bridge.zig` |
| Theme | `native/harness/src/palette.zig` |
| Fetch artifact | `scripts/fetch-harness-artifact.mjs` |
| CI | `.github/workflows/build-harness.yml` |
| Runner ops | [runner.md](runner.md) |
| IDs | [project-ids.md](project-ids.md) |

---

## Suggested first message (post–Phase 3)

> Continue Invincible from `docs/phase-3-handoff.md` / `AGENTS.md`. Phase 3 complete. Repo: btipling/invincible. Prod: https://invincible-dun-ten.vercel.app. Do not re-scaffold Phase 1–3.
