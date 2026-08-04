# native/harness — Invincible agent harness (Zig + dvui)

Durable Zig crate for the in-browser **product** harness UI (Wasm-primary). Built
with Zig **0.16.0** on the self-hosted runner (maintainer sample: `invincible-do-1`).

**Architecture:** [`docs/feature-divide.md`](../../docs/feature-divide.md)  
**Wasm supply / CI:** [`docs/runner.md`](../../docs/runner.md)

## UI ownership

| Surface | Owns |
|---------|------|
| **This crate (Wasm)** | Transcript, composer, Send/PONG, busy/error chrome, Asteronica theme |
| **DOM host** (`app/harness/HarnessHost.tsx`) | Load module, bridge poll, `/api/chat` + `/api/agent`, SessionStore, nav chips |

Do **not** reintroduce a React chat panel as product UX. The canvas is the
workspace — not an optional companion.

## Relation to other `native/` targets

| Path | Status | Role |
|------|--------|------|
| `hello.zig` + root `build.sh` | Runner probe | Tiny `add` export → `hello.wasm`. Keep for runner smoke. |
| `dvui-spike/` | Research | Superseded by this crate for product work. |
| **`harness/` (this)** | **Product** | dvui web → **`harness.wasm`** + `web.js`. |

## Build

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
src/ui.zig       # frame: transcript, composer, Send / PONG
src/bridge.zig   # inv_* export fns + ring buffer + pending submit
src/palette.zig  # TEAL/WARM/EMBER hex (sync with lib/palette.ts)
build.zig        # export_symbol_names whitelist for inv_*
```

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
| `inv_begin_batch` / `inv_end_batch` | session hydrate without per-msg refresh |
| `inv_push_message` / `inv_clear_messages` / … | Transcript ring buffer |
| `inv_echo*` | UTF-8 round-trip stub |
| `inv_has_pending_submit` / `inv_pending_submit_*` / `inv_ack_pending_submit` | Host polls user submits |

Whitelist: `build.zig` → `export_symbol_names` (Zig 0.16 freestanding + `entry = .disabled` strips unrooted exports).

Inference stays on the host: `POST /api/chat` and `POST /api/agent` hold
`AI_GATEWAY_API_KEY` — **never** in Wasm.

## JS ↔ Wasm protocol

| | |
|--|--|
| **Protocol version** | `2` |
| **TS** | `lib/harnessBridge.ts` |
| **Zig** | `src/bridge.zig` |
| **Host** | `app/harness/HarnessHost.tsx` (shell: load + bridge + APIs) |
| **Chat turn** | `lib/harnessChat.ts` → `/api/agent` or `/api/chat` |

### Message kinds

| Kind | Value | Use |
|------|------:|-----|
| user | 1 | Canvas prompt |
| assistant | 2 | Model reply into Wasm |
| system | 3 | Status / toolTrace lines |
| error | 4 | Errors (EMBER) |

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
| WARM | Smoke/PONG, busy, assistant labels |
| EMBER | Errors only |

Hex source: `src/palette.zig` ↔ `lib/palette.ts`. Theme applied in `dvui_init` via `Window.init(.{ .theme = palette.theme() })`.

## Zig 0.16 Wasm export rules

With `entry = .disabled`, exports need `--export=` roots via `module.export_symbol_names` or they are GC’d.  
`export fn` location (main vs bridge) does not matter; the whitelist does.

Language: [export](https://ziglang.org/documentation/0.16.0/#export) · `std.Build.Module.export_symbol_names`.

## Browser requirements

WebAssembly, Canvas, WebGL, `fetch`. Limits: [`docs/harness-limits.md`](../../docs/harness-limits.md).
