# Harness known limits

Documented browser / dvui / product constraints for `/harness` (Wasm-primary).

## Product UX

| Surface | Role |
|---------|------|
| **Wasm (dvui)** | Primary harness — transcript, composer, agent chrome |
| **DOM** | Host shell — nav, load, status chips, Clear, APIs, SessionStore |

See [feature-divide.md](feature-divide.md). No competing DOM chat panel.

## Load & performance

| Topic | Behavior |
|-------|----------|
| Route | `/harness` client-only dynamic import (`ssr: false`) |
| Assets | `harness.wasm` (~1.3 MB) + `web.js` via `prebuild` artifact |
| MIME | `application/wasm` for `/harness/*.wasm` (`next.config.js`) |
| First paint | Spinner until instantiate; full-bleed canvas after ready |
| Cache | `public, max-age=3600, stale-while-revalidate=86400` |
| Build id | Baked short git SHA (`-Dbuild-id`); file `public/harness/build-id.txt`; shown as `h:…` in host chip **and** canvas header — must match after deploy |

## Keyboard & focus

| Chord | Action |
|-------|--------|
| **Enter** (canvas composer focused) | Send prompt (single-line entry) |
| Tab | DOM nav / Clear (canvas uses pointer + dvui focus) |
| Composer focus | Requested on ready and after each send |

## Touch / mobile (~390px)

| Topic | Behavior |
|-------|----------|
| Layout | Full-bleed canvas under host nav; no horizontal overflow expected |
| Hit targets | Send / PONG ≥ ~40px tall |
| Fallback | No “use the DOM chat instead” product path |

## Layout / composer chrome

Vertical bands inside the Wasm root (not a DOM panel):

| Band | Behavior |
|------|----------|
| **Header** | Compact title / lifecycle / model cycle — height measured each frame |
| **Transcript** | One outer `scrollArea` that takes **remaining** height only |
| **Composer chrome** | Text field + Send / PONG (+ hint) in a **reserved bottom band** outside the scroller |

| Rule | Behavior |
|------|----------|
| Composer visibility | Fully on-canvas while the harness is ready; not optional |
| Height budget | Every frame: viewport → absolute `Options.rect` bands (header / transcript / composer). Rect children do not report min-size up the tree, so tall content cannot push chrome off-canvas |
| Short canvas | Transcript shrinks / scrolls first — chrome keeps touch-sized targets (~40px) |
| Content size | Tall messages grow **virtual** scroll size only; scroller outer height is fixed to the leftover band |
| Solid chrome | Composer band uses TEAL fill so transcript paint cannot show through |
| Forbidden | Nesting the composer inside the transcript `scrollArea`; dual DOM chat input |

## Transcript scroll

| Topic | Behavior |
|-------|----------|
| Scroller | One outer **Wasm** `scrollArea` for the whole transcript (not a DOM panel) |
| State | `ScrollInfo` persists across frames (`native/harness/src/ui.zig`) |
| Input | Mouse wheel / trackpad / touch drag on the canvas **transcript region only** |
| Stick-to-bottom | Follow when user was **near bottom** (~48px), when a **new user** line arrives, or on **session hydrate** / Clear |
| Reading older lines | If the user scrolled **up**, new assistant/tool/system lines do **not** yank the viewport down |
| Long messages | Multi-screen assistant text is reachable by scrolling; still capped at 4 KiB per line |
| vs composer | Scrolling never covers or moves the reserved composer band |

Not a dual-chat surface: scrolling and typing stay inside the harness canvas.

## Transcript density

| Topic | Behavior |
|-------|----------|
| Ring capacity | 48 messages in Wasm (`bridge.zig` `MAX_MSG`) |
| Visible paint | Last **28** lines (+ “N earlier” hint) |
| Line size | 4 KB UTF-8 max per message (`MAX_MSG_LEN`) |
| Host history | Host folds last **~8** user/assistant turns (`formatPromptWithHistory` maxTurns=8, maxChars=12 000); prefer Clear for a fresh workspace |


## Rich transcript (Wasm)

Markdown and fenced code for **user** and **assistant** bodies are painted in the
Wasm canvas (`native/harness/src/rich/*`). System and error lines stay plain text
(EMBER for errors). There is **no** DOM/React markdown panel.

| Topic | Behavior |
|-------|----------|
| Parser | **zmd** (MIT) → walkable blocks; no HTML intermediate |
| Common MD | Headings, paragraphs, lists, bold/italic, inline code, fences, http(s) links |
| Fenced code | Mono box + muted language label; **≤80 lines** then “… N more” |
| Diff / patch fences | Info string `diff` or `patch` (any case): line colors — **+** WARM accent, **−** EMBER text (removed-line semantics, not error chrome), **`@` / `---` / `+++`** muted, context TEAL body |
| Tables | Pipe tables paint as **plain paragraphs** today (parser has no table nodes). Richer mono/grid is follow-on work |
| Links | `http://` and `https://` only; other schemes show as plain label text |
| Fallback | Parse failure / OOM → raw body text (never empty bubble) |
| Cache | Fingerprint (FNV-1a) over full body; cap 48 entries; cleared on transcript clear |
| Caps | Same ring / 4 KiB line / 28 visible as above |

Feature divide: transcript **read** path remains canvas-only — see [feature-divide.md](feature-divide.md).

## Palette

| Family | Role |
|--------|------|
| **TEAL** | Default chrome |
| **WARM** | Busy, PONG, assistant labels |
| **EMBER** | Danger / errors only |

Sources: `lib/palette.ts` + `native/harness/src/palette.zig`.

## dvui / browser

WebAssembly, Canvas, WebGL, `fetch`. Console may show WebGL noise; happy path
should stay free of uncaught host errors.

## Session

Browser memory + `localStorage` only — see [session-model.md](session-model.md).
No secrets in session blobs.

## CI / deploy

Wasm rebuild is self-hosted Zig → artifact → Vercel prebuild. See
[runner.md](runner.md) and [harness-deploy-race.md](harness-deploy-race.md).
