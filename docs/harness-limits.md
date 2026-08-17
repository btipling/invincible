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
| Build id | Baked short git SHA (`-Dbuild-id`); file `public/harness/build-id.txt`; shown as `h:…` in status bar line 1 — must match after deploy |

## Keyboard & focus

| Chord | Action |
|-------|--------|
| **Enter** (composer focused) | Insert a newline (composer is multi-line) |
| **Ctrl+Enter** / **Cmd+Enter** (composer focused) | Send prompt |
| Tab | DOM nav / Clear (canvas uses pointer + dvui focus) |
| Composer focus | Requested on ready and after each send |

## Touch / mobile (~390px)

| Topic | Behavior |
|-------|----------|
| Layout | Full-bleed canvas under host nav; no horizontal overflow expected |
| Hit targets | Send / message **📋** (clipboard / copy) ≥ ~40px tall |
| Fallback | No “use the DOM chat instead” product path |

## Layout / composer chrome

Vertical bands inside the Wasm root (not a DOM panel):

| Band | Behavior |
|------|----------|
| **Transcript** | Horizontal pair inside the leftover band from the canvas top to the composer: a collapsible **left rail** (closed = 40 px icon strip; open = 220 px TEAL column with the session list, scroll inside the rail) plus the `scrollArea`. Row labels are pixel-ellipsized to the 220 px column (UTF-8, trailing `…`). The auto vertical bar sits on the **canvas right edge**. No pane pad, no card fill/border on the scroller. Rail height always equals the transcript band (`scroll_h`) — it shrinks when the composer grows up. |
| **Composer chrome** | Single-row text field + one trailing **icon-only** button (▶ Send / ■ Stop); dynamic height from previous-frame measurement: idle hugs one line (~44 px), grows up to cap (124 px) then scrolls internally. TextEntry glyphs inset **5 px** from the field border (`COMPOSER_TE_PAD`; dvui bakes padding into min/max — sizes are passed minus 2×pad so the 44/124 chrome caps hold). Send/Stop icon is bottom-pinned (`gravity_y = 1.0`) so it stays on the field baseline at all heights (plan #579, revises #457 fixed band) |
| **Status bar** | **Two-line** always-mounted full-width strip **below the composer**: line 1 = identity (lifecycle · `h:{build-id}` · model menu), line 2 = status-slot pack (sandbox · cwd · git · context); fixed `STATUS_BAR_H` = 64 px, never collapses (plan #570, merged from header per plan #555 → #554) |

| Rule | Behavior |
|------|----------|
| Composer visibility | Fully on-canvas while the harness is ready; not optional |
| Height budget | Every frame: absolute-rect bands — the transcript band is **`[left rail \| scrollArea]`** from the canvas top to the composer (height = viewport − dynamic composer `composer_h` − status bar `STATUS_BAR_H`; no inter-band gap). The rail is a sibling `Options.rect` of the scroller (closed 40 px, open 220 px TEAL session-list column); the scroller’s `Options.rect.x` is the rail width so both share `scroll_h`. Composer sits above the status bar with dynamic height from previous-frame measurement (idle ~44 px, max 124 px), full canvas width. Status bar absolute-rect flush to the canvas bottom, full width. Transcript scroller **and** composer use `Options.rect` so neither participates in root flex; the scrollArea's `.auto` bar cannot publish virtual content height as min-size (dvui `ScrollContainerWidget.deinit` overwrites `min_size.h` with full content). Tall content cannot push chrome off-canvas |
| Wrap / grow | Field is **`break_lines`** + grows **vertically** with wrapped lines up to `COMPOSER_INPUT_MAX_H` (120 px) then scrolls **inside** the entry. Composer chrome box uses a dynamic absolute rect from previous-frame measurement (`composer_last_h`): idle = `COMPOSER_IDLE_CHROME_H` (44 px = TOUCH_H + 2×HUG_PAD), max = `COMPOSER_MAX_CHROME_H` (124 px). Glyphs sit `COMPOSER_TE_PAD` (5 px) inside the field stroke — `min_size_content` / `max_size_content` are passed minus 2×pad because `TextEntryWidget.init` bakes padding in. The textEntry hugs one line when idle, grows up when multi-line (one-frame settle lag), and scrolls internally past 120 px. The Send/Stop icon at `gravity_y = 1.0` stays bottom-pinned on the field baseline (adversarial review #584 Round 2 Major L1+L9). Never a horizontal gutter (repo no-h-scroll policy, #344/#457/#579) |
| Icon button | Fixed **`TOUCH_H`×`TOUCH_H`** (40 px) square on the **same row** as the field, **bottom-pinned** (`gravity_y = 1.0`) so it stays glued to the status bar while the field grows up (plan #575 lock). Idle = ▶ Send (submit when non-empty); Busy = ■ Stop (protocol v9 `queueCancelFromUi` → host abort). No labelled Stop/Send pill, no hint copy. Glyphs from the embedded DejaVu Sans Symbols face (no tofu) |
| Turn clock | Whole-turn **`mm:ss`** is painted **in-canvas** by the Wasm busy row (`Waiting for model… · 0:42`), protocol **v14** (`inv_set_turn_elapsed`). The **DOM host** owns the only reliable wall-clock (no WASI clock in Wasm): its ~1 Hz Busy effect pushes the elapsed seconds to the bridge (`HarnessBridge.setTurnElapsed` → `inv_set_turn_elapsed`), reset to 0 on Ready/Stop/error so no bare `0:00` lingers. The clock is client wall-time from turn start — **not** provider `usage` duration. See [feature-divide.md](feature-divide.md) |
| Busy spinner | A **2×4 WARM rectangle grid** paints **left of** `Waiting for model…` on a **full-width `teal_bg` bar** in the transcript (spinner + waiting copy, no text-only chip). The grid is **4×4 px cells** with **2 px sibling gaps** (inner 10×22), centered by equal pad (**1.5 / 3.5**) inside a reserved **13×29 slot**; the slot and the **10 px `TRAIL`** before the waiting copy do not move. The pulse is a **clockwise loop**: left column **bottom→top**, right column **top→bottom**. The **DOM host** feeds the pulse phase at **`HARNESS_BUSY_TICK_HZ` = 10 Hz while Busy** (`HarnessBridge.setBusyTick` → additive `inv_set_busy_tick`). **NEW cap:** 10 Hz while Busy, **0 otherwise** — well below the dvui 60 fps ceiling, host-local `setInterval` (no transport), turns transient. Pulse is pure Wasm LUT paint (`native/harness/src/busy_spinner.zig`), **no I/O / alloc in the frame path**. Each `setBusyTick` triggers a full dvui `refresh()` (re-layout + repaint) at up to 10 Hz while Busy vs 1 Hz today — the 10 Hz bound is the lock, not a cached-redraw claim. **Reduced motion:** grid static at phase 0 (head **bottom-left**) — only the per-tick pulse push is skipped; the live `mm:ss` **clock feed keeps running**. Old host + new Wasm: `busy_tick` stays 0 → static grid (graceful). New host + old Wasm: `inv_set_busy_tick` is in `REQUIRED_FNS`, so a stale build fails closed at load |
| Short canvas | Transcript shrinks / scrolls first — chrome keeps touch-sized targets (~40px). `SCROLL_FLOOR_H` (32 px) prevents the transcript from collapsing to zero on absurdly short canvases |
| Content size | Tall messages grow **virtual** scroll size only; scroller outer height is fixed to the leftover band |
| Solid chrome | Composer band uses TEAL fill so transcript paint cannot show through |
| Forbidden | Nesting the composer inside the transcript `scrollArea`; dual DOM chat input |

## Workspace status bar (bottom status bar under the composer, protocol v13)

| Topic | Behavior |
|-------|----------|
| Owner | **Wasm-primary** two-line bottom status bar (plan #538/#541, relocated below the composer by plan #555 → #554, header merged by plan #570): **line 1** = identity (lifecycle · `h:{build-id}` · model menu — formerly the top header band), **line 2** = status-slot pack (sandbox · cwd · git · context). The top header band is removed entirely; the DOM host only **mirrors** (see [feature-divide.md](feature-divide.md)) — never a competing status panel. Empty slot store still mounts the fixed `STATUS_BAR_H` = 64 px band as a subtle bare strip — it never collapses |
| Slots | **sandbox** (`activeSandboxId` → `sandbox <id>` short label) · **cwd** (workspace-relative session cwd) · **git** (`branch@sha[∗]`, Phase 2 #540) · **context/usage** (`N in · M out · T tok`, Phase 3 #539) |
| Bridge carrier | Additive status-slot store (`inv_set_status_slot` / `inv_status_slot_len/copy` / `inv_status_slots_clear`), bridge protocol **v13** (old exports untouched). A host push **replaces** one slot; `len==0` clears it (slot hidden) |
| Host fold | After hydrate/restore, after **every** agent turn — success **and** fail (PR #543: a 403-clear or committed `change_dir` on a cancelled/timed-out turn repaints the pack; same fold-before-persist discipline as `attachedSlugs`), and **live mid-turn on tool results** (Phase 2 #627 / #625: a confirmed `change_dir` or successful `meta_sandbox_switch` repaints sandbox/cwd immediately, plus the host persists via `onSessionPatch`). Git slot also refreshes on-demand after a successful `exec` or `meta_sandbox_switch` mid-turn (not only the 10 s cadence). The host folds session state into the pack (`lib/harnessChat.ts` `foldStatusSlots`, call sites: hydrate + live tool events + `runHarnessTurn` success + `runHarnessTurn` fail). Clear/New session clears the pack |
| Git slot (Phase 2 #540) | Classic status slot, filled by the **DOM host** polling the read-only **`GET /api/harness/status`** server probe on a **~10 s cadence** (`lib/harnessChat.ts` `refreshGitStatusSlot`, wired in `app/harness/HarnessHost.tsx`). The **host cadence is the primary throttle**; the server rate cap is only a per-instance backstop. Fail-soft: any network/abort/429 error keeps the last git value (never flashes it away on a transient refresh); a genuinely **empty** probe result clears the slot (no stale prior linger). Oversize git values are host-ellipsized to the slot cap before the wire |
| Git probe (server) | **`GET /api/harness/status`** (`app/api/harness/status/route.ts`) resolves the caller's **envelope-authoritative** active bind (envelope `meta.activeSandboxId` wins over a Redis-safe `?sandboxId=` carry) and runs a **bounded, argv-only, read-only** git probe at the **bind workspace root** (`lib/agent/statusProbe.ts` — `rev-parse --abbrev-ref HEAD` + `--short HEAD` + `status --porcelain`; probe `cwd` is always `.`, never a caller session cwd). Non-git / empty-git-dir / probe error → `{ git: {} }` (fail-soft, still 200; git slot stays muted). stdout truncated to `STATUS_GIT_PROBE_OUT_MAX_BYTES` (512). Server-side **per-instance best-effort** rate cap `STATUS_PROBE_MIN_INTERVAL_MS` (2000) serves a cached value + `rate_limited:true` when inside the window (never 429-spam). Auth edge = middleware matcher + in-route `requireSessionUser` (dual gate, mirror `/api/agent`/`/api/sandboxes`). No bind secrets / `base_url` / token ever on the wire |
| Context slot (Phase 3 #539 + #628) | Paints **provider token usage** — absolute tokens only (`N in · M out · T tok`; **no `% of window` — v1 has no model max-context source**). Updated **live mid-stream** when the AI SDK reports **aggregate** usage on a `finish` part (SSE `usage` event — never `finish-step` per-step counts), and reconciled at the final `done.usage` / JSON result / chat result. Carrier: `mapProviderUsage` (`lib/agent/usageSummary.ts`, cap `USAGE_SUMMARY_MAX_BYTES` = 96); the host parses it (`sanitizeUsageSummary`), mirrors it on `SessionSnapshot.usage`, and `foldStatusSlots` paints the slot from `formatUsageSummary`. **Default on missing usage = hidden** — never a client estimate. A completed turn with no provider usage **clears** the slot; an **aborted/cancelled** turn (no completion) carries the prior honest value forward. Live `usage` events with no usable counts are never emitted (no flicker). Rides reserved cloud `meta.usage` (JSON string; drop-to-unset on poison); host folds from `SessionSnapshot.usage`. Read-side re-sanitized in the fold so a poisoned in-memory usage can never paint |
| Cap | Per slot **`STATUS_SLOT_MAX_BYTES` = 96** UTF-8 bytes (`lib/sessionCloudCaps.ts` == TS bridge `MAX_STATUS_SLOT_LEN` == Wasm `MAX_STATUS_SLOT_LEN`). The host **ellipsizes** fold values to the cap at a UTF-8 boundary (`harnessChat.ts` `truncateStatusValue`, trailing `…`) before pushing, so a present-but-oversize bound/cwd renders `<…>` instead of being dropped; a raw over-cap push is still **rejected** at the bridge/Wasm (authoritative, never a silent wire truncation) |
| Narrow canvas | The strip is always mounted at fixed `STATUS_BAR_H`; slots right-align within it. Unlike the old header pack (which traded against the primary controls), the slots now trade against the **full strip width** (`statusPackMaxWidth` = strip content width − `STATUS_PACK_BUDGET_SAFETY`) — a wider container, so the drop/ellipsis behavior it triggers is a monotone change. Slots drop by `STATUS_SLOT_DROP_ORDER` (git → context → cwd → sandbox; sandbox survives last) and, when even the surviving sandbox slot can't fit at full width, it is **pixel-ellipsized** to the leftover budget at paint time (`ui.zig` `truncateToWidthPx`) so the bound sandbox identity stays visible instead of the pack painting nothing |
| Colors | TEAL default, muted when empty (empty slot hides), WARM when busy; **EMBER never** for these slots |

## Transcript scroll

| Topic | Behavior |
|-------|----------|
| Scroller | One outer **Wasm** `scrollArea` for the whole transcript (not a DOM panel). Full-bleed on the canvas (`teal_bg`, no pane pad/border); the `.auto` vertical bar is flush with the canvas right edge (no inset rail) |
| State | `ScrollInfo` persists across frames (`native/harness/src/ui.zig`) |
| Input | Mouse wheel / trackpad / touch drag on the canvas **transcript region only** |
| Stick-to-bottom | Follow when user was **near bottom** (~48px), when a **new user** line arrives, on **session hydrate** / Clear, or when **in-place stream growth** makes the transcript taller (`update_last` thinking/assistant tokens) while still near bottom |
| Reading older lines | If the user scrolled **up**, new assistant/tool/system lines **and** stream growth do **not** yank the viewport down |
| Long messages | Multi-screen assistant text is reachable by scrolling; still capped at 4 KiB per line |
| vs composer | Scrolling never covers or moves the reserved composer band |

Not a dual-chat surface: scrolling and typing stay inside the harness canvas.

## Transcript density

| Topic | Behavior |
|-------|----------|
| Ring capacity | **2048** messages in Wasm (`bridge.zig` `MAX_MSG` / `HARNESS_RING_MAX`) |
| Visible paint | Every in-ring message (≤2048) is painted **except** empty/blank **assistant** rows, which are omitted at paint (see **Empty assistant rows**); scroll to read older in-ring turns. Ring still drops oldest when full. No “N earlier” black-hole hint. **Per-frame cost is O(dirty), not O(N):** the painter keys its rich-parsed doc and `tool_run` decode caches on (**physical ring slot**, per-slot **write-revision**), so an unchanged message reuses its cached parse/layout with **zero** re-parse — only the row that actually changed (new push / `update_last` stream growth) re-parses. Committed rows paint with DVUI `cache_layout` (no per-frame re-shafting); the live streaming row stays `cache_layout=false`. See **Frame budget** |
| Empty assistant rows | An **assistant** message whose text is empty or whitespace-only (e.g. a transient host slot opened during a multi-tool turn) is **omitted at paint** — no blank card. System/error lines and tool traces stay visible; while busy the compact `Waiting for model…` status keeps the turn honest. Ring data is untouched (skip is paint-time only), so Copy, `update_last`, and id allocation still work off ring indices |
| Thinking (kind 5) collapse | Committed (completed-turn) thinking rows are **default-collapsed** to a compact expandable control (`Thinking` expander + muted one-line preview + Copy) so scrolled-away reasoning stops full-body per-frame paint; the **active Busy turn** keeps thinking fully expanded. Re-expanding a row renders its full GFM monologue (via the O(dirty) slot-keyed parse + `cache_layout`). Expand state is in-memory only — thinking is ephemeral (never survives refresh). See [agent-stream.md](agent-stream.md) · Thinking collapse |
| Row height | Message rows have **no reserved min-height band**; height tracks content + normal padding (`padding .y=6`, `margin .y=4`). The only enforced touch target is the `≈40px` **📋** (copy) control on the kind row, which shows only for non-empty bodies. Omitting the empty card removes the large blank band without adding a new height contract |
| Line size | **262 144** UTF-8 bytes max per message (`MAX_MSG_LEN`) |
| Host history fold | `formatPromptWithHistory` default **maxMessages=400**, **maxChars≈3.5M** (model token limit is the real cap); prefer Clear for a fresh workspace |
| Session longer than ring | Host `SessionStore` and cloud row may hold more than the ring (cloud still subject to ~2 MiB body). Ring shows a **window** of ≤2048. **Load earlier** steps back by **`HISTORY_PAGE` = 512**; new send snaps to latest window |
| Cloud record caps | Redis multi-session record: **no message-count cap** · **262 144** UTF-8 bytes/msg · **8 MiB** body · Redis-safe opaque id (`^[A-Za-z0-9_-]{1,512}$`) · reserved `meta` (incl. JSON-string `attachedSkills`, #514) + 1 MiB size cap (`lib/sessionCloudCaps.ts`, `lib/sessions/sessionStore.ts`) — see [session-model.md](session-model.md). **Phase 0 (#515):** the transcript lives in **Vercel Blob objects** (`BLOB_READ_WRITE_TOKEN` / BYO S3-R2 seam), pointed to by `meta.transcriptPointer` on the small Redis envelope; the carrier is per-object/per-wire, not per-blob. A full-record GET/PUT remains only as legacy roll-forward while those blobs stay small (4.5 MiB response limit) |

### Frame budget

`dvui_update` → `update()` → `ui.frame()` (`native/harness/src/main.zig` / `ui.zig`) is the display loop. **App code** on that path must not GPA-allocate or do host I/O. dvui’s own widget arena, text shaping, and the web-backend `setCursor` / `textInputRect` JS calls are the framework and stay allowed.

| Topic | Behavior |
|-------|----------|
| Rule | No app-owned `gpa` alloc, `ArrayList` grow, `HashMap.put`, or host I/O (`clipboardTextSet`, `fetch`, `wasm_panic` / console) inside `ui.frame()`. Parse, decode, and texture work belong on the **bridge write** (`inv_push_message` / `inv_update_last` / `inv_*_cache_put`), not paint |
| Steady-state | Cache **hit** is the contract: unchanged `(slot, revision)` reuses the stored `ParsedDoc` / tool-run decode with zero re-parse (Visible paint · Cache) |
| Known exceptions | **Cache miss** still GPA-parses markdown (`rich/cache.zig` `parseSlot`) and decodes tool-run (`rich/toolrun_cache.zig` `parseSlot`) during the same `dvui_update` that first paints the dirty row. **📋** still `clipboardTextSet` inside the frame (tool-run Copy also arena-decodes via `toolRunClipboard`). Expander open still `HashMap.put` on the FBA maps (`toolrun_open_*` / `thinking_open_l1`). Frame-error path may `allocPrint` + `wasm_panic` |
| Not | Host `fetch` / MathJax / image decode from `ui.frame()` (those stay on the DOM host, then `inv_*_cache_put`). A line-by-line violation inventory in this file |

### Tool-run (collapsed tool traces)

The host aggregates each uninterrupted tool streak into **one** display-only
`tool_run` message (bridge kind **6**, protocol **v11**, session role
`tool_run`) instead of one System row per tool. The Wasm paints it as an
expandable control. The card is **painted live**: a tool event opens (or grows)
a single kind-6 row immediately on the canvas — `1 tool called` → `2…` — via
`update_last`, never withheld until a boundary (the commit-once lock is removed;
see Group boundaries).

| Topic | Behavior |
|-------|----------|
| Header (default) | `N tools called` / `1 tool called`, default-**collapsed**. Right-aligned count chips shown only when >0: success **✓ N** (TEAL), failed **✗ N** (EMBER — danger only), pending **… N** (WARM). Status marks paint from embedded faces (`✓`/`✗` via DejaVu Sans Symbols; `…` via Noto heading) — **no tofu**. The **📋** (copy) control lives on this header row |
| Two-level expand | Level 1: one one-liner per tool — colored status glyph **✓/✗/…** is the *single* status channel, plus a preview: `brief` (≤64 chars) when level-2 detail exists, else the tool **`name`** (no redundant `name · ok/failed` marker). Level 2: that tool's inline `detail` — a bounded, redacted **preview** (phase 3 #353) built server-side from flattened+redacted tool output: `exec` command/exit/stdout+stderr head/tail, `read_file`/`write_file`/`str_replace`/`list_dir` path/size/entries/brief preview, `http_*` URL/status/bounded body. Short single-line results carry **no** detail → a static label (no blank, duplicate-of-L1 expander). Clicking a row toggles; second click collapses; per-item isolation |
| Detail vs scroll | Level-2 detail paints **inline** inside the one outer transcript scroller — there is **no** nested `scrollArea`. Command/output previews use the embedded **Vera Sans Mono** face (`exec`/filesystem/`http_*`, and any **multi-line** detail so MCP/custom-tool output also reads as a block); prose/single-line detail stays the body face. Long detail is bounded per-tool by the server preview cap (`TOOL_RUN_PREVIEW_MAX_CHARS` = 100k) with the **real** head **40** / tail **10** lines + `… (M more lines)`, and the whole group is bounded by the encode budget + hard clamp below, so the transcript wheel is not trapped |
| Painter | `native/harness/src/ui.zig` → `paintToolRun`; payload decode in `native/harness/src/rich/toolrun.zig` (fail-open → raw body text) |
| Open state | Two module-level `std.AutoHashMap(dvui.Id, void)` open-branch maps (per message id / per item id) survive repaint / `update_last`; cleared on reload / Clear / truncate → collapsed-by-default |
| Group boundaries | Grouping keys off the **last painted ring row** via the host's `lastRingRowIsToolRun` flag (the host is the only ring writer): a tool event grows the open card **iff** the last ring row is a tool-run; a **thinking row last**, a real (non-empty trimmed) assistant segment, a user send, or an error/turn-end opens a NEW card at `1`; empty **and whitespace-only** assistant (or a blank `text_delta`) is **not** a boundary. Counts **paint live** — each tool event opens/grows the kind-6 card immediately (`1 tool called` → `2…`) via `update_last`, never withheld until a boundary (removed commit-once). A group still rolls to a new card at `TOOL_RUN_ITEMS_MAX`, and the rolled (full) card is never grown |
| Group bound | A group stores at most **200** items (`TOOL_RUN_ITEMS_MAX`); a longer streak rolls a new `tool_run` group (counts stay exact across groups). The whole group encodes into **one** message, so the host enforces a group **encode budget** (`TOOL_RUN_GROUP_DETAIL_ENC_MAX` ≈ 229 KiB of encoded `detail`) that clips/omits previews plus an encode-time hard clamp to `TOOL_RUN_MSG_HARD_MAX` (`262 144`) — a multi-item streak of large previews can **never** overflow the ring/cloud per-msg cap (it clips an explicit `…` or falls back to the L1 static label, never a silent mid-payload truncation) |
| Session | One `tool_run` message per group round-trips local + cloud and repaints collapsed on restore; **not** folded into the model prompt (display-only). Caveat: prior tool summaries no longer reach the model on a **continue after a mid-tool cancel** — the model sees only persisted assistant prose and may re-run or infer tools. That is the documented product rule (kept for the cancel/Copy-fed transcript). A **confirmed successful `change_dir`** still lands in the session `cwd` even when the turn later cancels / times out / hard-errors — the mid-tool-cancel re-run rule is unchanged, but the next turn boots where the model actually worked instead of against a silently-reset cwd. |
| Reload | Thinking is ephemeral and **never survives refresh**; `tool_run` + assistant are the durable transcript. On hydrate the host coalesces **consecutive** `tool_run` rows into scannable groups (`mergeToolRunPayloads`, rolling at `TOOL_RUN_ITEMS_MAX` + re-clamping the detail budget) so a long session doesn't read as a wall of `N×1` collapsed cards; rows separated by an assistant/user/error/turn-end line stay distinct. Counts stay exact after coalescing (recounted). **Coalescing is bridge/display-only** — `SessionStore` and the cloud row still hold the original N×1 `tool_run` messages (cloud PUT size, future non-bridge UIs, and debug dumps keep the uncoalesced wall; the merged groups exist only in the Wasm ring). |
| Headerless chrome | Tool-run rows are **headerless** — there is **no** `tools` kind band above the control. The only chrome is the `N tools called` expander header + its **Copy** control on that header row (never a `system` header). Same spirit as #325 DoD #5 (no System chrome on tool activity) |



## Transcript copy / paste

| Topic | Behavior |
|-------|----------|
| **Primary path** | Per-message **📋** (copy) control on the kind row (user / assistant / system / error when body non-empty) |
| Clipboard payload | **Message source** UTF-8 as stored in the Wasm ring (markdown as produced) — not re-serialized paint colors or “… N more” chrome |
| Drag-select | Best-effort **within a single** `textLayout` only (rich MD is many widgets per body). Whole-reply drag-select is not the product path |
| Cross-message selection | Not supported |
| Composer paste | Supported via dvui text entry when the composer is focused. Composer is **multi-line** — pasted newlines are preserved; submission is normalized (CRLF → LF) and clamped to the prompt submit cap (`SUBMIT_CAP`). Leading whitespace / blank first lines in a paste are **preserved** on submit (not stripped); only a wholly blank/whitespace prompt is rejected |
| Mobile / touch | **📋** (copy) is the supported path; multi-block drag-select on canvas is unreliable |
| Secure context | System clipboard write needs https (or localhost); silent no-op possible if the browser blocks clipboard |

## Rich transcript (Wasm)

Markdown and fenced code for **user** and **assistant** bodies are painted in the
Wasm canvas (`native/harness/src/rich/*`). **User, assistant, and thinking** get GFM. System and error lines stay plain text
(EMBER for errors). There is **no** DOM/React markdown panel.

| Topic | Behavior |
|-------|----------|
| Parser | **zmd** (MIT) → walkable blocks; no HTML intermediate |
| Common MD | Headings, paragraphs, lists (**unordered** `• ` and **ordered** `1.` / `2.` … markers; sequential per list, **including loose lists** (items split by blank lines stay `1. 2. 3.` and do not restart at `1.`); **task lists** → Task lists row), **bold / italic / combined**, GFM `~~strike~~` (same-line), backslash escapes (`\*`, `\_`, `\`` , `\\`), underscore emphasis at **word boundaries only** (word-internal `_` in `foo_bar` / `SANDBOX_TOKEN` is literal, see **Inline marks** row), inline code, fences, http(s) links, **images** (`![alt](url)` → Images row), **math** (`$` / `$$` → Math row) |
| Rich MD whitespace fidelity | Block boundaries and style-run spaces **preserve the stored source bytes** — Wasm parse/paint is faithful: a well-formed source already yields correct block separation and token spacing (`## H` + paragraph; `with 401`; `got` + `**503**`). A **glued** render (missing `\n` / spaces) therefore means the **stored source is already glued upstream** — the live residual is the **provider / AI-SDK delta assembly** (when the 📋 source `m.text` is already glued); the host assembler `lib/harnessChat.ts` `growAssistant`/`finalizeAssistant` preserves whitespace-only deltas now, leaving a **historical / residual** host seam. **Not** a Wasm paint bug. Diagnose via **📋** (copy) — it writes the raw source `m.text` — then fix the upstream seam; never paper it over in paint |
| Blockquote | GFM-style `>` lines (optional ≤**12** lead spaces for quote-under-list indent). Nested `>>` / `> >`… depth 1–6 with indent + **TEAL border bar**; plain quote ink is **muted** (`quote_text`). **Strict lines** (no lazy continuation). zmd has no native quote — pre-partition + strip, then same sugar/inline pipeline. **Lists inside `>`** keep structure: bullets and ordered markers under quote bar + muted base ink (switching list type under `>` may need a blank `>` line so zmd opens a new list). Indented `>` under nested lists paints with extra lead margin (visual hierarchy; not CM child-of-li AST). **v1 paint:** nested fence/heading chrome inside `>` still flattens to blockquote inlines (readable, no nested fence chrome). |
| Inline marks | Flat runs with **style flags** (strong/emph/strike compose; `***…***` / `___…___` compose strong+emph (triple-emphasis, no leftover markers)). No nested AST. Emph uses **Noto Sans Italic** / **Bold Italic** (real slant, not color-only). Emph ink matches body (slant is the cue); strong ink matches body; strike alone keeps body color. Mono has no italic face (style bit may fall back). **GFM no-intra-word `_` rule:** word-internal `_` in identifiers (`foo_bar`, `SANDBOX_TOKEN`, `max_tokens`) paints **literally** — `_` / `__` emphasize **only at word boundaries**, so a `_` run bounded by alphanumerics both sides is never an emph split. `*em*` / `**bold**` star emphasis is unaffected; `\_` still forces a literal `_`; inline code and fenced bodies stay literal by construction. |
| Fenced code | Mono box + muted language label; **≤80 lines** then “… N more”. **Token highlight** for allowlisted langs (see below); unknown lang stays mono |
| Fence token highlight | Allowlist (case-insensitive): `zig`, C/C++ (`c`/`h`/`cpp`/`cc`/`cxx`/`c++`/`hpp`/`hh`/`hxx`), `ts`/`js`/`tsx`/`jsx` (+ long forms), `json`, `bash`/`sh`/`shell`, `python`/`py`. Roles: keyword (WARM), string (TEAL accent), comment/number (muted), default body. **`diff`/`patch` stay line-kind paint** (not token HL). Payload is source text as stored — not reconstructed |
| Diff / patch fences | Info string `diff` or `patch` (any case): line colors — **+** WARM accent, **−** EMBER text (removed-line semantics, not error chrome), file headers / `@@` hunk headers muted (hunk-aware so body lines like `---flag` stay del), context TEAL body |
| Tables | GFM **pipe tables** (header + `---` separator + body). Fence-aware local partition (zmd has no table AST). **Column alignment** from separator colons only: `:---` left, `:---:` center, `---:` right, `---` default (left paint); ≥3 dashes per sep cell (short forms like `:-:` are not tables). IR meta `cols,overflow,aligns[,runs]` (`l`/`c`/`r`/`d` per col; optional `.`-separated per-cell inline run counts). **Cell bodies** support the same **inline** subset as paragraph/list (strong/emph/strike, inline code, markdown links, images when live) via the shared inline lowerer; multi-run cells compose; header row keeps bold chrome **and** cell inlines. Paint: **dvui GridWidget** + `paintInlineFlow` per cell, borders, per-column gravity, palette surface/border tokens, layout-only (no edit/sort/select). **Column width is content-driven and never overflows — horizontal scroll is disabled everywhere in the UI**: cells report their natural (unwrapped) width, capped per-column at a **content-derived max** (= transcript content width). Columns size to natural width; when a table's **sum** of natural column widths exceeds the viewport, dvui grid **shrinks each column proportionally** (weighted by its own content width) and the long cells wrap to fit — the table always fits the transcript, no horizontal scrollbar is ever produced, and columns are never collapsed to a single-char fragment. **Residual:** an image/math-only cell rides the shared segmented branch, which still forces a horizontal expand internally on that **single** cell (bounded by the no-horizontal-scroll policy — it can push that cell's content past its column edge but never produces a scrollbar; documented residual covered by operator smoke, not the content-driven width path). **Other residuals of the no-H-scroll policy:** under aggressive proportional shrink a cell can become **narrower than an unbreakable token** (e.g. a long inline-code identifier) — text wraps on soft breaks, but a no-space token **clips** at the cell edge (no horizontal scroll escape; acceptable trade when wraps read, not a stump regression); and wrap that grows a cell tall can hit the row **`max_height = 120`** cap earlier than under scroll, clipping the lower lines of very tall wrapped cells (no vertical cell scroll). Both bounded, non-scrollbar residuals — cover in operator smoke, not core-width-path blockers. Link/image allowlist unchanged (http(s) only). Caps: **≤12 cols**, **≤40 rows** then “… N more rows”. Not: block content in cells (lists/nested tables/fences/multi-paragraph), HTML tables, per-cell HTML align, tables inside `>` quotes (v1), escaped `\|` in cells, spreadsheet chrome |
| Thematic break | CommonMark-ish `---` / `***` / `___` (optional spaces between markers; ≤3 lead spaces). Fence-aware local detect (zmd has no HR). Paint: **dvui.separator** bar, **TEAL border** fill (`quote_bar`). Not: setext, YAML front matter, HR inside `>` quotes (v1), fence-body dashes |
| Footnotes | GFM-ish `[^label]` refs + single-line `[^label]:` defs (label `[A-Za-z0-9_-]{1,32}`). Fence-aware extract; refs protected before zmd (which has no footnotes and treats `[` as link). Paint: muted in-body `[label]` (no caret) + end-of-message section (separator + defs as `[label]: …`). Source syntax remains `[^label]` / `[^label]:`. Caps ≤32 defs / ≤32 refs. **Not:** multi-line/indented GFM bodies, click-to-jump, renumbering, pandoc `^[…]`, defs inside fences/tables |
| Definition lists | PHP Markdown Extra / pandoc-style: single-line **term** immediately above one or more line-start `: definition` lines (optional ≤3 lead spaces before `:`). Fence-aware local partition (zmd has no dl/dt/dd). Paint: term **body bold**; defs **~16px indent** + muted base ink (`body_text` → `muted_text`, strong/code/link keep StyleMap). Caps ≤32 terms / ≤64 desc lines (fail open). **Not:** nested block defs, same-line `Term: def`, `~` compact marker, multi-paragraph bodies, deflists inside tables/fences/`>` quotes (v1) |
| Task lists | GFM task markers on list items: `- [ ]` / `- [x]` / `- [X]` (also `*`/`+` list markers and ordered `1. [ ]`). IR: `list_item.checked` (`null` = ordinary, `false`/`true` = task). Marker stripped from body text. Paint: **display-only checkbox chrome** (custom; not `dvui.checkbox`) — unchecked = **2px TEAL muted stroke** ring (checkmark’s 1px inset border is invisible on dark bg); checked = TEAL accent fill + dark check; 8px gap to label; non-interactive spacer (no click/tab/AccessKit toggle; does **not** rewrite source / SessionStore) in place of bullet/number, then item inlines. Nested + ordered tasks allowed. **Not:** click-to-toggle, interactive `dvui.checkbox`, HTML checkbox forms, dual React MD panel, strike-on-checked (v1) |
| Links | **http(s) only** (allowlist). **Markdown** `[label](url)`, **bare** `http://` / `https://` in text runs (query + fragment preserved; trailing `.,;:!?` / unpaired closers stripped; mixed-case scheme OK), and **CommonMark angle-bracket autolinks** `<http://…>` / `<https://…>` — the `<>` wrappers are stripped from the href/label so the click target is the clean inner URL (trailing `.,;:!?` inside the brackets still trimmed). Same TEAL + underline paint + open path. **Not** autolinked inside inline code, fenced code, or existing link/image spans. **Not:** `www.` without scheme, `mailto:`, custom schemes. Other schemes show as plain label text. |
| Images | CommonMark `![alt](url)` only (reference-style deferred). **http(s)** only — same allowlist spirit as Links (`javascript:` / `file:` / `data:` never fetched). **Host** browser `fetch` + decode → RGBA → bridge `inv_image_cache_put` (protocol **v4**); Wasm paints via **dvui.image** (`ImageSource.pixels`). Caps: URL ≤2048 bytes; concurrent fetches ≤3; cache ≤24 entries (cleared with transcript); body ≤1.5 MiB; decode max edge 1280; display max height 280, width ≤ content, aspect preserved. CORS / network / decode failure → muted **TEAL** placeholder + alt (or `(image)`). **Not:** `data:` blobs, server image proxy, click-to-zoom lightbox, HTML `<img>` attribute soup, freestanding Wasm HTTP/stb decode, dual DOM image gallery |
| Math | Inline `$...$` and display `$$...$$` (same-line or multi-line). **Host** MathJax (`mathjax-full`) TeX→**SVG paths** → data-URL canvas raster → RGBA → bridge `inv_math_cache_put` (protocol **v5**); Wasm paints via **dvui.image**. **Ink** palette `teal.text` on **transparent** pixels (no white cards); host super-samples 2× for sharpness. (KaTeX HTML→foreignObject→blob abandoned: Chromium taints canvas so pixels never reached Wasm.) Currency-like `$5` / `$10` / `$1,234.56` stay plain text; `\$` literal dollar. Caps: TeX ≤2048 **UTF-8 bytes** (host + Wasm); cache ≤48 (cleared with transcript; host putOk is LRU of 48 and full-transcript re-schedule after turns can re-put after eviction); concurrent renders ≤3; max edge 1280; inline max height 64; display max height 320; width ≤ content. Inline interiors trimmed for cache-key parity host↔Wasm. Miss / TeX error / oversize → muted **TEAL** mono TeX source box. **Not:** dual DOM math bubbles, freestanding TeX engine in Wasm, live streaming partial `$` in composer, editable equation editor |
| Fallback | Parse failure / OOM → raw body text (never empty bubble) |
| Cache | **Slot-keyed (primary):** growable per physical ring slot, keyed on (slot, write-revision); starts empty (no static floor), grows to the max slot painted, holds only real parsed content; cleared on transcript clear. An unchanged revision is a cache hit — no re-parse, no body scan. **Flat fingerprint (fallback for non-ring paints):** FNV-1a over full body, cap 48 entries, cleared on transcript clear. Tool-run decode cache has the same slot-keyed shape (per slot + write-revision, long-lived gpa). Miss still allocates on the display tick (see **Frame budget**) |
| Caps | Same ring / 256 KiB line; paint all in-ring (≤2048) as above |
| Unicode | Message bodies are **UTF-8** end-to-end (host `TextEncoder` → Wasm ring → zmd parse → paint → Copy source). Integrity = scalars/bytes preserved; glyphs depend on the faces below |
| Fonts (embedded) | **Noto Sans** Regular/Bold/Italic/BoldItalic (body + rich emph) · **OpenMoji** black outline subset (emoji) · **DejaVu symbols** subset (arrows / math / dingbats / text-ornament Geometric Shapes missing from Noto, e.g. → `▾`) · **Vera Sans Mono** Regular/Bold (fences / inline code). Licenses: `native/harness/src/fonts/README.md` |
| Paint faces | Transcript paint **splits** emoji → OpenMoji, text symbols (arrows, CLI dingbats, text-ornament Geometric Shapes such as `▾`) → DejaVu symbols, else Noto Sans / mono (dvui has no automatic per-glyph fallback). Report separators (U+23AF, U+2500/U+2501, scan lines U+23BA–U+23BD) paint as Noto **U+2015** lookalikes **on the body face** (including inside fences / inline code — Vera has no U+2015) — Copy still yields the source scalar |
| Missing glyphs | Scripts outside these faces (notably **full CJK**) may still show a **missing-glyph placeholder**. That is **not** mojibake; **Copy** still yields UTF-8 source when the browser allows clipboard write |
| Truncation | `MAX_MSG_LEN` (256 KiB) is a **byte** cap — a multi-byte sequence at the limit may be cut mid-code-point (pre-existing ring behavior) |

### Unicode / fonts (detail)

| Layer | Behavior |
|-------|----------|
| Host → Wasm | UTF-8 via `TextEncoder`; ring stores raw bytes |
| Parse / fences | Non-ASCII kept in inline and fence text; allowlisted token HL keeps complete UTF-8 sequences whole on the default path |
| Paint | Mixed runs: Noto Sans for letters/punctuation; DejaVu symbols for arrows / math ops / text-ornament Geometric Shapes (`▾` `▸` `▴` …) missing from Noto; OpenMoji for emoji / pictographs (**monochrome outlines, inked teal_accent**) including play/reverse `▶◀` and the small/medium squares it actually ships. ZWJ / skin-tone / VS stay on the emoji face. Report separators with no embedded glyph (U+23AF Vitest `⎯`, U+2500/U+2501, U+23BA–U+23BD) paint as U+2015 on the **Noto body** face even inside fences / inline code (Vera has no U+2015); expander titles and other box-drawing may still tofu |
| Composer | Canvas `textEntry` uses theme body (Noto Sans); emoji/symbol while typing follows the same face rules when painted in the transcript after send |
| Coverage | Latin / Greek / Cyrillic (Noto) + arrows/operators/text triangles (DejaVu symbols subset) + common emoji (OpenMoji subset). Report separators with no embedded glyph paint as U+2015. **Not** full CJK; **not** color emoji; complex ZWJ families are best-effort without a full shaper |
| Out of scope (today) | Full CJK face pack; **color** emoji (monochrome teal is intentional); full BiDi |

Feature divide: transcript **read** path remains canvas-only — see [feature-divide.md](feature-divide.md).

## Palette

| Family | Role |
|--------|------|
| **TEAL** | Default chrome |
| **WARM** | Busy, assistant labels |
| **EMBER** | Danger / errors only |

Sources: `lib/palette.ts` + `native/harness/src/palette.zig`.

## dvui / browser

WebAssembly, Canvas, WebGL, `fetch`. Console may show WebGL noise; happy path
should stay free of uncaught host errors.

## Session

Local-first (memory + `localStorage`) plus **cloud multi-device** sync when the
user is signed in — see [session-model.md](session-model.md).

| Topic | Behavior |
|-------|----------|
| First paint | Always from local store (cloud pull is async; never blocks Ready) |
| Cloud API | Redis multi-session via `GET`/`POST` `/api/sessions` + `GET`/`PUT`/`DELETE` `/api/sessions/:id` (path-`:id` write key) — auth required; fail-closed with **401** when unauth. **Phase 0 (#515):** the small envelope carrier adds `PUT`/`GET` `/api/sessions/:id/envelope` (envelope upsert/read incl. `meta.transcriptPointer`) and `POST`/`GET` `/api/sessions/:id/transcript` (client→Blob mint upload + signed read URL); the full-record route stays for legacy roll-forward |
| Clear | Local empty + **DELETE** only (never PUT empty) |
| Secrets | Never in session blobs (local or cloud; the Blob transcript is object-stored under the server credential, never a static client token) |

## CI / deploy

Wasm rebuild is self-hosted Zig → artifact → Vercel prebuild. See
[runner.md](runner.md) and [harness-deploy-race.md](harness-deploy-race.md).
