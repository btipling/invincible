# Harness known limits (Phase 3.10+)

Documented browser / dvui / product constraints for `/harness`.

## Load & performance

| Topic | Behavior |
|-------|----------|
| Route | `/harness` is a **client-only** dynamic import (`ssr: false`) so Wasm never hits the server bundle |
| Assets | `harness.wasm` (~1.3 MB) + `web.js` from Actions artifact via `prebuild` |
| MIME | `Content-Type: application/wasm` set in `next.config.js` for `/harness/*.wasm` |
| First paint | Loading spinner until dynamic chunk + HEAD probe + `WebAssembly.instantiate` |
| Cache | Wasm/JS: `public, max-age=3600, stale-while-revalidate=86400` |

Acceptable first load on broadband is a few seconds; spinner is intentional.

## Console (happy path)

Expected silence after ready. You may still see:

- dvui / WebGL info logs from the backend (vendor `web.js`)
- Browser warnings about WebGL if the GPU is blocked

Unexpected: `Failed to compile module`, MIME `text/html` for `.wasm`, missing `inv_*` exports.

## Keyboard

| Chord | Action |
|-------|--------|
| ⌘/Ctrl + Enter | Send composer prompt |
| Tab | Move through nav, Clear, Show Wasm, composer, Send |
| Enter (in canvas textEntry) | Queue Wasm submit when the Wasm panel is focused |

## Product UX (Phase 4)

| Surface | Role |
|---------|------|
| **Wasm (dvui)** | Primary harness — transcript, composer, agent chrome |
| **DOM** | Host shell — nav, load, bridge, `/api/chat`, SessionStore |

See [feature-divide.md](feature-divide.md). Phase 3 DOM chat panel is **removed** as product UI.

## Palette (DOM **and** dvui)

Both surfaces use Asteronica tokens aligned with `lib/palette.ts`:

| Family | Use |
|--------|-----|
| **TEAL** | Chrome, panels, primary Send, user labels |
| **WARM** | Model/busy chip, Smoke/PONG, assistant labels |
| **EMBER** | Errors only |

| Surface | Source |
|---------|--------|
| DOM | `lib/palette.ts` CSS tokens |
| dvui Wasm | `native/harness/src/palette.zig` → `palette.theme()` applied at `Window.init` |

Hex values must stay in sync across those two files. dvui theme reuses Adwaita embedded fonts (color-only override).

## dvui / browser

| Limit | Notes |
|-------|--------|
| WebGL | Required for dvui web backend; fails on locked-down GPUs |
| Text input | **Wasm textEntry is primary** (Phase 4); IME/mobile limits tracked in #34 |
| Mobile | Agent panel usable at ~390px; canvas companion is optional (“Show Wasm”) |
| Multi-touch | Canvas `touch-action: none`; composer uses native text fields |
| Safari | Wasm + WebGL generally OK on recent iOS; test before relying on canvas entry |
| Streaming | Not supported — full `generateText` response per turn |
| Message size | Bridge truncates lines at 4 KB UTF-8 (`MAX_MSG_LEN` in `bridge.zig`) |
| History | Last ~8 user/assistant turns folded into one Gateway prompt |
| Secrets | Never in Wasm or `SessionStore` blobs — only server `AI_GATEWAY_API_KEY` |

## Session persistence

See [`session-model.md`](session-model.md). MVP: `localStorage` / memory. No local filesystem.

## CI / deploy

- Zig build only on `invincible-do-1` (`build-harness.yml`)
- Vercel needs `HARNESS_ARTIFACT_TOKEN` + `AI_GATEWAY_API_KEY`
- After `palette.zig` / UI theme changes: rebuild harness artifact then redeploy
