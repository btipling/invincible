# native/harness — Invincible agent harness (Zig + dvui)

Durable Zig crate for the in-browser **product** harness UI (Wasm-primary). Built
with Zig **0.16.0** on the self-hosted runner (maintainer sample: `invincible-do-1`).

**Architecture:** [`docs/feature-divide.md`](../../docs/feature-divide.md)  
**Wasm supply / CI:** [`docs/runner.md`](../../docs/runner.md)

## UI ownership

| Surface | Owns |
|---------|------|
| **This crate (Wasm)** | Transcript (incl. scroll, rich MD + diff/patch fences, per-message **Copy** of source via dvui clipboard, reserved composer layout), composer, Send, busy/error chrome, Asteronica theme |
| **DOM host** (`app/harness/HarnessHost.tsx`) | Load module, bridge poll, `/api/chat` + `/api/agent`, SessionStore, nav chips |

Do **not** reintroduce a React chat panel as product UX. The canvas is the
workspace — not an optional companion. Layout: header + height-bounded transcript
`scrollArea` + reserved bottom composer chrome in `src/ui.zig` (see
[`docs/harness-limits.md`](../../docs/harness-limits.md)).


## Relation to other `native/` targets

| Path | Status | Role |
|------|--------|------|
| `hello.zig` + root `build.sh` | Runner probe | Tiny `add` export → `hello.wasm`. Keep for runner smoke. |
| `dvui-spike/` | Research | Superseded by this crate for product work. |
| **`harness/` (this)** | **Product** | dvui web → **`harness.wasm`** + `web.js`. |

## Build

CI bakes a short git SHA via `-Dbuild-id=…` (see `build.sh`). The id is
written to `build-id.txt` in the artifact and shown in the canvas header as
`h:<id>`. Use it to confirm Production is not serving stale wasm.


```bash
# requires zig == $(cat ../ZIG_VERSION), outbound GitHub for dvui fetch (first time)
./build.sh
# → native/dist/harness/{harness.wasm,web.js,index.html,web.wasm}
```

Zig 0.16 release flag: `--release=small` (used by `build.sh`).

CI: `.github/workflows/build-harness.yml` → artifact **`harness-wasm`**  
(paths: `native/harness/**`, `native/ZIG_VERSION`, workflow file).

`build.sh` verifies Wasm export section includes all `inv_*` + `dvui_init` / `gpa_u8`.

### Ship to Vercel (no binaries in git)

```text
build-harness → artifact harness-wasm
  → Vercel prebuild: scripts/fetch-harness-artifact.mjs
  → public/harness/* (ephemeral) → CDN /harness/*
```

- Vercel env: `HARNESS_ARTIFACT_TOKEN` (Actions: Read)  
- Deploy race: wait-for-SHA in fetch script — [`docs/harness-deploy-race.md`](../../docs/harness-deploy-race.md)  
- Optional after upload: Actions secret `VERCEL_DEPLOY_HOOK_URL`  
- **Do not** commit `public/harness/*.wasm` / `web.js`

## Source layout

```text
src/main.zig     # dvui_init / deinit / update + Asteronica themeSet
src/ui.zig       # frame: transcript, composer, Send
src/bridge.zig   # inv_* export fns + ring buffer + pending submit
src/palette.zig  # TEAL/WARM/EMBER hex (sync with lib/palette.ts)
src/rich/        # Markdown + fence paint (zmd MIT parse → cache → registry)
                 #   parse, cache, paint, paint_text, paint_code, paint_diff,
                 #   highlight (fence token HL), diff_lang, registry, style,
                 #   kinds, link_url, root
build.zig        # export_symbol_names whitelist for inv_*; test-rich host tests
```

**Rich transcript:** user/assistant bodies use zmd → `ParsedDoc` → dvui paint (no HTML).
Each non-empty message row has **Copy** (source bytes → system clipboard via `dvui.clipboardTextSet`).
Fences with info string `diff` or `patch` use line-colored paint (WARM add, EMBER remove,
muted meta). Allowlisted langs get **token** colors via `rich/highlight.zig` (keyword/string/
comment/number); unknown lang stays mono. System/error stay plain. Tables are plain text until a future parse/paint
path. Host unit tests: `zig build test-rich`. Bodies are UTF-8; Noto Sans + OpenMoji (emoji) + Vera Mono — see `docs/harness-limits.md` (Unicode / fonts).

## Export surface (dvui host)

Host is dvui’s `web.js`. Required exports (app + backend):

| Export | Role |
|--------|------|
| `dvui_init` / `dvui_deinit` / `dvui_update` | Lifecycle |
| `add_event` / `arena_u8` / `gpa_u8` / `gpa_free` / `new_font` | Backend |

### Invincible bridge (`inv_*`)

| Export | Role |
|--------|------|
| `inv_protocol_version` | Must match `HARNESS_PROTOCOL_VERSION` in `lib/harnessBridge.ts` |
| `inv_ping` | Scalar round-trip |
| `inv_set_lifecycle` / `inv_get_lifecycle` | boot / ready / busy / error |
| `inv_message_count` | ring length |
| `inv_message_kind_at` / `inv_message_text_len_at` / `inv_message_text_copy_at` | **v11** additive ring-readback (tests/assertions on real Wasm; read-only, never counts toward `inv_message_count`) |
| `inv_begin_batch` / `inv_end_batch` | session hydrate without per-msg refresh |
| `inv_push_message` / `inv_update_last_message` / `inv_clear_messages` / … | Transcript ring buffer (v8 update-last; Thinking kind=5) |
| `inv_echo*` | UTF-8 round-trip stub |
| `inv_has_pending_submit` / `inv_pending_submit_*` / `inv_ack_pending_submit` | Host polls user submits |
| `inv_set_can_load_earlier` / `inv_has_pending_load_earlier` / `inv_ack_pending_load_earlier` | Host enables Load earlier; polls window step-back (protocol v6) |
| `inv_has_pending_cancel` / `inv_ack_pending_cancel` | User **Stop** while busy (protocol v9); host aborts inflight turn |
| `inv_clear_model_catalog` / `inv_push_model_catalog_entry` / `inv_model_catalog_count` | Protocol v3 model catalog |
| `inv_selected_model_len` / `inv_selected_model_copy` / `inv_cycle_selected_model` | Protocol v3 selection |
| `inv_set_turn_elapsed` | **v14** whole-turn busy clock — the host pushes elapsed wall-clock seconds while a turn runs; the Wasm busy row formats/appends `Waiting for model… · mm:ss` in-canvas |

Whitelist: `build.zig` → `export_symbol_names` (Zig 0.16 freestanding + `entry = .disabled` strips unrooted exports).

Inference stays on the host: `POST /api/chat` and `POST /api/agent` hold
`AI_GATEWAY_API_KEY` — **never** in Wasm.

## JS ↔ Wasm protocol

| | |
|--|--|
| **Protocol version** | `14` (v13 added the additive status-slot store; **v14** adds the scalar turn-clock feed `inv_set_turn_elapsed`) |
| **TS** | `lib/harnessBridge.ts` |
| **Zig** | `src/bridge.zig` |
| **Host** | `app/harness/HarnessHost.tsx` (shell: load + bridge + APIs) |
| **Chat turn** | `lib/harnessChat.ts` → `/api/agent` or `/api/chat` |
| **Model catalog** | Host fetches `GET /api/models` after load and **pushes** ids into Wasm; selection (cycle / label) stays in the canvas UI |

### Message kinds

| Kind | Value | Use |
|------|------:|-----|
| user | 1 | Canvas prompt |
| assistant | 2 | Model reply into Wasm |
| system | 3 | Status / turn-end lines |
| error | 4 | Errors (EMBER) |
| thinking | 5 | Model reasoning (v8, display-only) |
| tool_run | 6 | Host-aggregated, **live-painted** tool-run group (v11, display-only; `rich/toolrun.zig` decode) |

Host **polls** pending submit (~150 ms); no custom Wasm imports beyond stock dvui `web.js`.

### Lifecycle

| Value | Name |
|------:|------|
| 0 | boot |
| 1 | ready |
| 2 | busy |
| 3 | error |

## Palette

Asteronica on **both** DOM and dvui:

| Family | Role |
|--------|------|
| TEAL | Chrome, primary Send, user labels |
| WARM | Busy, assistant labels |
| EMBER | Errors only |

Hex source: `src/palette.zig` ↔ `lib/palette.ts`. Theme applied in `dvui_init` via `Window.init(.{ .theme = palette.theme() })`.

## Zig 0.16 Wasm export rules

With `entry = .disabled`, exports need `--export=` roots via `module.export_symbol_names` or they are GC’d.  
`export fn` location (main vs bridge) does not matter; the whitelist does.

Language: [export](https://ziglang.org/documentation/0.16.0/#export) · `std.Build.Module.export_symbol_names`.

## Browser requirements

WebAssembly, Canvas, WebGL, `fetch`. Limits: [`docs/harness-limits.md`](../../docs/harness-limits.md).
