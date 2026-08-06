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
| Hit targets | Send / PONG / message **Copy** ≥ ~40px tall |
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



## Transcript copy / paste

| Topic | Behavior |
|-------|----------|
| **Primary path** | Per-message **Copy** control on the kind row (user / assistant / system / error when body non-empty) |
| Clipboard payload | **Message source** UTF-8 as stored in the Wasm ring (markdown as produced) — not re-serialized paint colors or “… N more” chrome |
| Drag-select | Best-effort **within a single** `textLayout` only (rich MD is many widgets per body). Whole-reply drag-select is not the product path |
| Cross-message selection | Not supported |
| Composer paste | Supported via dvui text entry when the composer is focused. Composer is **single-line** — pasted newlines may flatten |
| Mobile / touch | **Copy** is the supported path; multi-block drag-select on canvas is unreliable |
| Secure context | System clipboard write needs https (or localhost); silent no-op possible if the browser blocks clipboard |

## Rich transcript (Wasm)

Markdown and fenced code for **user** and **assistant** bodies are painted in the
Wasm canvas (`native/harness/src/rich/*`). System and error lines stay plain text
(EMBER for errors). There is **no** DOM/React markdown panel.

| Topic | Behavior |
|-------|----------|
| Parser | **zmd** (MIT) → walkable blocks; no HTML intermediate |
| Common MD | Headings, paragraphs, lists (**unordered** `• ` and **ordered** `1.` / `2.` … markers; sequential per list; **task lists** → Task lists row), **bold / italic / combined**, GFM `~~strike~~` (same-line), backslash escapes (`\*`, `\_`, `\`` , `\\`), inline code, fences, http(s) links |
| Blockquote | GFM-style `>` lines (optional ≤**12** lead spaces for quote-under-list indent). Nested `>>` / `> >`… depth 1–6 with indent + **TEAL border bar**; plain quote ink is **muted** (`quote_text`). **Strict lines** (no lazy continuation). zmd has no native quote — pre-partition + strip, then same sugar/inline pipeline. **Lists inside `>`** keep structure: bullets and ordered markers under quote bar + muted base ink (switching list type under `>` may need a blank `>` line so zmd opens a new list). Indented `>` under nested lists paints with extra lead margin (visual hierarchy; not CM child-of-li AST). **v1 paint:** nested fence/heading chrome inside `>` still flattens to blockquote inlines (readable, no nested fence chrome). |
| Inline marks | Flat runs with **style flags** (strong/emph/strike compose). No nested AST. Emph uses **Noto Sans Italic** / **Bold Italic** (real slant, not color-only). Emph ink matches body (slant is the cue); strong ink matches body; strike alone keeps body color. Mono has no italic face (style bit may fall back). |
| Fenced code | Mono box + muted language label; **≤80 lines** then “… N more”. **Token highlight** for allowlisted langs (see below); unknown lang stays mono |
| Fence token highlight | Allowlist (case-insensitive): `zig`, C/C++ (`c`/`h`/`cpp`/`cc`/`cxx`/`c++`/`hpp`/`hh`/`hxx`), `ts`/`js`/`tsx`/`jsx` (+ long forms), `json`, `bash`/`sh`/`shell`, `python`/`py`. Roles: keyword (WARM), string (TEAL accent), comment/number (muted), default body. **`diff`/`patch` stay line-kind paint** (not token HL). Payload is source text as stored — not reconstructed |
| Diff / patch fences | Info string `diff` or `patch` (any case): line colors — **+** WARM accent, **−** EMBER text (removed-line semantics, not error chrome), file headers / `@@` hunk headers muted (hunk-aware so body lines like `---flag` stay del), context TEAL body |
| Tables | GFM **pipe tables** (header + `---` separator + body). Fence-aware local partition (zmd has no table AST). Paint: **dvui GridWidget** with cell borders + header row (bold), palette surface/border tokens, layout-only (no edit/sort/select). Caps: **≤12 cols**, **≤40 rows** then “… N more rows”. Not: HTML tables, alignment colons, tables inside `>` quotes (v1), escaped `\|
| Thematic break | CommonMark-ish `---` / `***` / `___` (optional spaces between markers; ≤3 lead spaces). Fence-aware local detect (zmd has no HR). Paint: **dvui.separator** bar, **TEAL border** fill (`quote_bar`). Not: setext, YAML front matter, HR inside `>` quotes (v1), fence-body dashes |`, spreadsheet UX |`, proportional column measure |
| Footnotes | GFM-ish `[^label]` refs + single-line `[^label]:` defs (label `[A-Za-z0-9_-]{1,32}`). Fence-aware extract; refs protected before zmd (which has no footnotes and treats `[` as link). Paint: muted in-body `[label]` (no caret) + end-of-message section (separator + defs as `[label]: …`). Source syntax remains `[^label]` / `[^label]:`. Caps ≤32 defs / ≤32 refs. **Not:** multi-line/indented GFM bodies, click-to-jump, renumbering, pandoc `^[…]`, defs inside fences/tables |
| Definition lists | PHP Markdown Extra / pandoc-style: single-line **term** immediately above one or more line-start `: definition` lines (optional ≤3 lead spaces before `:`). Fence-aware local partition (zmd has no dl/dt/dd). Paint: term **body bold**; defs **~16px indent** + muted base ink (`body_text` → `muted_text`, strong/code/link keep StyleMap). Caps ≤32 terms / ≤64 desc lines (fail open). **Not:** nested block defs, same-line `Term: def`, `~` compact marker, multi-paragraph bodies, deflists inside tables/fences/`>` quotes (v1) |
| Task lists | GFM task markers on list items: `- [ ]` / `- [x]` / `- [X]` (also `*`/`+` list markers and ordered `1. [ ]`). IR: `list_item.checked` (`null` = ordinary, `false`/`true` = task). Marker stripped from body text. Paint: **display-only checkbox chrome** via `dvui.checkmark` (TEAL `.control` / checked `.highlight`; non-interactive spacer — no click toggle, not in tab order, no AccessKit toggle; does **not** rewrite source / SessionStore) in place of bullet/number, then item inlines. Nested + ordered tasks allowed. **Not:** click-to-toggle, interactive `dvui.checkbox`, HTML checkbox forms, dual React MD panel, strike-on-checked (v1) |
| Links | `http://` and `https://` only; other schemes show as plain label text |
| Fallback | Parse failure / OOM → raw body text (never empty bubble) |
| Cache | Fingerprint (FNV-1a) over full body; cap 48 entries; cleared on transcript clear |
| Caps | Same ring / 4 KiB line / 28 visible as above |
| Unicode | Message bodies are **UTF-8** end-to-end (host `TextEncoder` → Wasm ring → zmd parse → paint → Copy source). Integrity = scalars/bytes preserved; glyphs depend on the faces below |
| Fonts (embedded) | **Noto Sans** Regular/Bold/Italic/BoldItalic (body + rich emph) · **OpenMoji** black outline subset (emoji) · **Vera Sans Mono** Regular/Bold (fences / inline code). Licenses: `native/harness/src/fonts/README.md` |
| Paint faces | Transcript paint **splits** emoji-related code points onto OpenMoji and everything else onto Noto Sans / mono (dvui has no automatic per-glyph fallback) |
| Missing glyphs | Scripts outside these faces (notably **full CJK**) may still show a **missing-glyph placeholder**. That is **not** mojibake; **Copy** still yields UTF-8 source when the browser allows clipboard write |
| Truncation | `MAX_MSG_LEN` (4 KiB) is a **byte** cap — a multi-byte sequence at the limit may be cut mid-code-point (pre-existing ring behavior) |

### Unicode / fonts (detail)

| Layer | Behavior |
|-------|----------|
| Host → Wasm | UTF-8 via `TextEncoder`; ring stores raw bytes |
| Parse / fences | Non-ASCII kept in inline and fence text; allowlisted token HL keeps complete UTF-8 sequences whole on the default path |
| Paint | Mixed runs: Noto Sans for letters/punctuation; OpenMoji for emoji / pictographs (**monochrome outlines, inked teal_accent**). ZWJ / skin-tone / VS stay on the emoji face |
| Composer | Canvas `textEntry` uses theme body (Noto Sans); emoji while typing follows the same face rules when painted in the transcript after send |
| Coverage | Latin / Greek / Cyrillic (Noto) + common emoji (OpenMoji subset). **Not** full CJK; **not** color emoji; complex ZWJ families are best-effort without a full shaper |
| Out of scope (today) | Full CJK face pack; **color** emoji (monochrome teal is intentional); full BiDi |

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
