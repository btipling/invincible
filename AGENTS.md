# AGENTS.md — Invincible

Guidance for AI agents (and humans) working on this repository.

## Project

**Invincible** is a cloud prompt playground / agent harness.

- **Source:** https://github.com/btipling/invincible
- **Phase 1:** Next.js 15 App Router + React 19 + Vercel AI Gateway (prompt → response)
- **Later:** DO self-hosted runner builds, Zig + dvui Wasm harness
- **Deploy:** Vercel (Git-linked when project exists)
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

## Structure (mirror webgpu-game / Asteronica)

```text
invincible/
├── app/                 # Next App Router shell (layout, pages, api routes)
│   ├── layout.tsx
│   ├── page.tsx
│   └── api/…            # Phase 1.4+
├── lib/                 # product logic (palette, gateway helpers later)
├── docs/                # phase plans
├── AGENTS.md
├── package.json
└── README.md
```

| Kind of change | Where |
|----------------|--------|
| UI page / layout | `app/` |
| API / AI Gateway | `app/api/*` |
| Colors / tokens | `lib/palette.ts` only |
| Pure helpers | `lib/*` |
| Plans | `docs/*` |

## Palette (imported from Asteronica / webgpu-game)

**Source of truth:** `lib/palette.ts` (kept in sync with `btipling/webgpu-game` values).

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

1. **All UI colors come from `lib/palette.ts`.** No one-off hex, no Tailwind default palette, no pure blue/cyan.
2. **TEAL** = default chrome (page bg, panels, borders, body text, primary buttons via `teal.accent`).
3. **WARM** = complementary accent only when intentional (secondary button, stream highlight, non-danger emphasis). Anchor `#d47c2c` / `warm.accent`.
4. **EMBER** = **danger only** (API errors, destructive confirm, invalid state). Never for normal chrome, success, or links.
5. Do **not** invent coral / orange / red outside `warm` / `ember`.
6. Palette ramps (`TEAL_PALETTE`, `WARM_PALETTE`, `EMBER_PALETTE`) and CSS token objects are **golden** — do not renumber or recolor casually. `lib/palette.test.ts` locks values.
7. Prefer `teal.*` / `warm.*` / `ember.*` for DOM styles; use linear RGB arrays only when packing to canvas/Wasm later.

### Forbidden examples

- `#e87a5c`, `#f0a090`, Tailwind orange/red/blue defaults
- Pure blue/cyan backgrounds or accents
- Using `ember` for non-error UI
- Hardcoding `#2dd4bf` instead of `teal.accent` (literals drift)

## Working rules

- Phase 1 only: pure prompt → response. No Zig, no Droplet, no agent tools.
- Keep `app/page.tsx` thin; put logic in `lib/` as it grows.
- Run `npm test` and `npm run build` before claiming ready.
- No secrets in repo; use `.env.local` / Vercel env (`AI_GATEWAY_API_KEY`).

## Do not

- Commit real API keys
- Bypass palette for “temporary” colors
- Use pure blue/cyan or coral one-offs
- Grow a second color module
