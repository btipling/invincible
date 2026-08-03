# AGENTS.md — Invincible

Guidance for AI agents (and humans) working on this repository.

## Project

**Invincible** is a cloud prompt playground / agent harness.

- **Source:** https://github.com/btipling/invincible
- **Prod:** https://invincible-dun-ten.vercel.app
- **Phase 1–2:** Next.js playground, AI Gateway, DO runner `invincible-do-1` (Zig 0.16.0)
- **Phase 3:** Pipeline PoC — bridge + DOM chat + optional Wasm companion (done)
- **Phase 4 (active):** Wasm-**primary** harness MVP — [`docs/phase-4-plan.md`](docs/phase-4-plan.md) · epic #27
- **Deploy:** Vercel (Git-linked) + Actions artifact `harness-wasm`
- **GitHub account:** owner **`btipling`** (not display name “Bjorn”)

## Hard constraint: git commit author = `btipling`

| Field | Required value |
|-------|----------------|
| `user.name` | `btipling` |
| `user.email` | `btipling@users.noreply.github.com` |

```bash
git config user.name "btipling"
git config user.email "btipling@users.noreply.github.com"
```

## Hard constraint: GitHub via `gh` + local `git` only

Prefer `gh` + `git` for all GitHub read/write. One commit per unit of work; one push.

```bash
command -v gh >/dev/null || exit 1
gh auth status || exit 1
```

## Infrastructure already configured (do NOT nag the user)

These are **already set up**. Never ask the user to create, wire, or “remember to set” them unless a build log **proves** they are missing/broken.

| Item | Status | Notes |
|------|--------|--------|
| Vercel project + Git `main` | **Done** | prod URL above |
| `AI_GATEWAY_API_KEY` (Vercel) | **Done** | server-side only |
| `HARNESS_ARTIFACT_TOKEN` (Vercel) | **Done** | PAT Actions: Read — prebuild downloads `harness-wasm` |
| `VERCEL_DEPLOY_HOOK_URL` (GitHub secret) | **Done** | user has deploy hooks; `build-harness` pings after artifact upload |
| DO runner `invincible-do-1` labels `invincible`,`zig` | **Done** | Zig 0.16.0 only there |

**Agent behavior:**

- Do **not** prompt “set `VERCEL_DEPLOY_HOOK_URL`” / “wire the deploy hook” / “optional secret if not already”.
- If workflow log says hook skipped (`not set`), treat as a real regression and investigate — still prefer fixing CI/docs over lecturing the user.
- Race fix lives in `scripts/fetch-harness-artifact.mjs` (wait for commit-matched artifact). See `docs/harness-deploy-race.md`.

IDs and URLs: [`docs/project-ids.md`](docs/project-ids.md). Runner ops: [`docs/runner.md`](docs/runner.md).

## Structure

```text
invincible/
├── app/                 # Next App Router (/, /harness, /api/chat)
├── lib/                 # palette, chat, bridge, session
├── native/harness/      # Zig + dvui Wasm (built on DO only)
├── scripts/             # fetch-harness-artifact.mjs, runner scripts
├── docs/                # phase plans, limits, deploy race
├── public/harness/      # wasm/js gitignored; README only committed
├── AGENTS.md
└── package.json
```

| Kind of change | Where |
|----------------|--------|
| UI page / layout | `app/` |
| API / AI Gateway | `app/api/*` |
| Colors / tokens (DOM) | `lib/palette.ts` |
| Colors / tokens (dvui) | `native/harness/src/palette.zig` (hex sync with palette.ts) |
| JS ↔ Wasm bridge | `lib/harnessBridge.ts` + `native/harness/src/bridge.zig` |
| Plans / ops | `docs/*` |

## Palette (imported from Asteronica / webgpu-game)

**Source of truth (DOM):** `lib/palette.ts`  
**Source of truth (dvui Wasm):** `native/harness/src/palette.zig` — same TEAL/WARM/EMBER hex; keep in sync.

### Families

| Family | Role | Anchor |
|--------|------|--------|
| **TEAL** | Primary UI chrome, backgrounds, borders, readable text, interactive accents | `teal.*` CSS tokens + `TEAL_PALETTE` |
| **WARM** | Complementary amber `#D47C2C` — secondary highlights, CTAs, success/emphasis | `warm.*` + `WARM_PALETTE[6]` |
| **EMBER** | Red-orange `#D4412C` — **danger / error only** | `ember.*` + `EMBER_PALETTE[6]` |

### CSS tokens (use these — no freehand hex)

```ts
import { teal, warm, ember } from '@/lib/palette';
// teal.bg, teal.surface, teal.border, teal.muted, teal.text, teal.accent, teal.accentDark, teal.clear
// warm.* / ember.* same shape (no clear on warm/ember)
```

### Hard rules (same as Asteronica)

1. **All UI colors come from palette modules.** No one-off hex, no Tailwind default palette, no pure blue/cyan.
2. **TEAL** = default chrome (page bg, panels, borders, body text, primary buttons via `teal.accent`).
3. **WARM** = complementary accent only when intentional (secondary button, stream highlight, non-danger emphasis). Anchor `#d47c2c` / `warm.accent`.
4. **EMBER** = **danger only** (API errors, destructive confirm, invalid state). Never for normal chrome, success, or links.
5. Do **not** invent coral / orange / red outside `warm` / `ember`.
6. Palette ramps and CSS token objects are **golden** — do not renumber or recolor casually. `lib/palette.test.ts` locks values.
7. Prefer `teal.*` / `warm.*` / `ember.*` for DOM styles; Zig uses matching hex in `palette.zig`.

### Forbidden examples

- `#e87a5c`, `#f0a090`, Tailwind orange/red/blue defaults
- Pure blue/cyan backgrounds or accents
- Using `ember` for non-error UI
- Hardcoding `#2dd4bf` instead of `teal.accent` (literals drift)

## Feature divide (Phase 4)

**Wasm is the harness; DOM is host shell only.** See [`docs/feature-divide.md`](docs/feature-divide.md).

| DOM | Wasm |
|-----|------|
| Nav, load module, bridge, `/api/chat`, SessionStore | Transcript, composer, agent chrome |
| No competing chat panel | Primary multi-turn UX |

Do **not** rebuild a React agent chat panel as product UI.

## Working rules

- Zig compile **only** on `invincible-do-1` (`build-harness.yml`). After harness source changes: CI → artifact → Vercel (wait-for-SHA prebuild + deploy hook).
- Inference stays server-side (`POST /api/chat`). No Gateway secrets in client or Wasm.
- Prefer extending `native/harness` + `HarnessHost` over new infra.
- Run `npm test` / `npm run typecheck` / `npm run build` before claiming ready (local build needs token or existing `public/harness`).
- No secrets in repo; Vercel / GitHub secrets only.

## Do not

- Commit real API keys or `public/harness/*.wasm|web.js`
- Bypass palette for “temporary” colors
- Use pure blue/cyan or coral one-offs
- Grow a second unrelated color module
- Ask the user to configure deploy hooks / tokens that are already listed as **Done** above
