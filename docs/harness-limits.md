# Harness known limits (Phase 4)

Documented browser / dvui / product constraints for `/harness` (Wasm-primary).

## Product UX

| Surface | Role |
|---------|------|
| **Wasm (dvui)** | Primary harness — transcript, composer, agent chrome |
| **DOM** | Host shell — nav, load, status chips, Clear, `/api/chat`, SessionStore |

See [feature-divide.md](feature-divide.md). No competing DOM chat panel.

## Load & performance

| Topic | Behavior |
|-------|----------|
| Route | `/harness` client-only dynamic import (`ssr: false`) |
| Assets | `harness.wasm` (~1.3 MB) + `web.js` via `prebuild` artifact |
| MIME | `application/wasm` for `/harness/*.wasm` (`next.config.js`) |
| First paint | Spinner until instantiate; full-bleed canvas after ready |
| Cache | `public, max-age=3600, stale-while-revalidate=86400` |

## Keyboard & focus

| Chord | Action |
|-------|--------|
| **Enter** (canvas composer focused) | Send prompt (single-line entry) |
| Tab | DOM nav / Clear (canvas uses pointer + dvui focus) |
| Composer focus | Requested on ready and after each send |

## Touch / mobile (~390px)

| Topic | Behavior |
|-------|----------|
| Layout | Full-bleed canvas under nav; min canvas height ~200px |
| Hit targets | Send / PONG ≥ ~40px tall |
| Safe area | Host `padding-bottom: env(safe-area-inset-bottom)` |
| IME | dvui canvas textEntry — soft keyboards vary by browser; prefer short prompts on mobile |
| Multi-touch | Canvas `touch-action: none` |

## Transcript density

| Topic | Behavior |
|-------|----------|
| Ring capacity | 48 messages in Wasm (`bridge.zig`) |
| Visible paint | Last **28** lines (+ “N earlier” hint) to limit jank |
| Stick-to-bottom | Scroll viewport follows new messages / busy line |
| Line size | 4 KB UTF-8 max per message |

## Palette

| Family | Use |
|--------|-----|
| **TEAL** | Chrome, user labels, primary Send |
| **WARM** | Busy, PONG, assistant labels |
| **EMBER** | Errors only |

DOM: `lib/palette.ts` · Wasm: `native/harness/src/palette.zig` (keep hex in sync).

## dvui / browser

| Limit | Notes |
|-------|--------|
| WebGL | **Required** — fails on locked-down GPUs / some remote desktops |
| Safari / iOS | Recent versions OK; test IME before relying on long mobile sessions |
| Streaming | Not supported — full `generateText` per turn |
| History fold | Host folds last ~8 user/assistant turns into Gateway prompt |
| Secrets | Never in Wasm or SessionStore — only Vercel `AI_GATEWAY_API_KEY` |

## Session

See [session-model.md](session-model.md). Host `localStorage` / memory; hydrate into Wasm on load (protocol v2 batch).

## CI / deploy

- Zig only on `invincible-do-1` (`build-harness.yml`)
- Option B artifact + wait-for-SHA: [harness-deploy-race.md](harness-deploy-race.md)
- Protocol: host `HARNESS_PROTOCOL_VERSION` must match Wasm `PROTOCOL_VERSION` (currently **2**)
