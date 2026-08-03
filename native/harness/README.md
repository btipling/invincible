# native/harness — Invincible agent harness (Zig + dvui)

Durable Zig crate for the in-browser harness. Built on **`invincible-do-1`** (Zig **0.16.0**).

## Relation to other `native/` targets

| Path | Status | Role |
|------|--------|------|
| `hello.zig` + root `build.sh` | Phase 2 probe | Tiny `add` export → `hello.wasm`. **Keep for runner smoke**; not the product UI. |
| `dvui-spike/` | Phase 3.1 research | One-off spike notes + minimal UI. Superseded by this crate for product work. |
| **`harness/` (this)** | **Phase 3 product** | dvui web → **`harness.wasm`** + `web.js` + host HTML. |

Deprecation plan: once `/harness` ships in production (3.5+), freeze `hello` as CI probe only; archive or delete `dvui-spike` after a milestone if unused.

## Build

```bash
# requires zig == $(cat ../ZIG_VERSION), outbound GitHub for dvui fetch (first time)
./build.sh
# → native/dist/harness/{harness.wasm,web.js,index.html,web.wasm}
```

Zig 0.16 release flag: `--release=small` (used by `build.sh`).

CI: `.github/workflows/build-harness.yml` → artifact **`harness-wasm`**.

`build.sh` verifies Wasm export section includes all `inv_*` + `dvui_init` / `gpa_u8` (fails CI if missing).

## Export surface (dvui host)

Host is dvui’s `web.js`. Required exports (provided by app + backend):

| Export | Role |
|--------|------|
| `dvui_init(platform_ptr, platform_len) → i32` | Create backend + window (`0` = ok) |
| `dvui_deinit()` | Tear down |
| `dvui_update() → i32` | One frame; return wait ms (`-1` quit) |
| `add_event` / `arena_u8` / `gpa_u8` / `gpa_free` / `new_font` | Backend memory + input (from dvui web backend) |

App code: `src/main.zig` (dvui lifecycle) · `src/ui.zig` (frames) · `src/bridge.zig` (`inv_*` + state).

Inference stays on the host: `POST /api/chat` holds `AI_GATEWAY_API_KEY` — **never** in Wasm.

### Zig 0.16 Wasm export rules (read this before adding symbols)

From Zig std (`Build.Module`):

> **`export_symbol_names`** — *Symbols to be exported when compiling to WebAssembly.*

Each name becomes a linker **`--export=`** root. Combined with language `export fn` / `@export`:

| Mechanism | Effect |
|-----------|--------|
| `export fn foo()` in Zig source (any file in the module graph) | Marks `foo` as an export candidate |
| `module.export_symbol_names = &.{ "foo" }` | Emits `--export=foo` → keeps `foo` as a GC root + export section entry |
| `exe.rdynamic = true` | Emits `-rdynamic` → keep **all** export-marked symbols (broader) |
| `exe.entry = .disabled` | No `_start`; freestanding library-style Wasm (required for dvui host) |

With `entry = .disabled`, the linker has **no entry root**. Exports that nothing *inside* the module calls get **stripped** unless they are roots via `--export=` / `-rdynamic`.

**File location does not matter** — `export fn` in `bridge.zig` works the same as in `main.zig`. What matters is the whitelist (or `rdynamic`).

dvui’s web backend lists `dvui_*` / `gpa_*` / `add_event` / … on its module. Invincible lists `inv_*` on the harness root module in `build.zig`.

Language ref: [export](https://ziglang.org/documentation/0.16.0/#export) · build field: `std.Build.Module.export_symbol_names`.

---

## JS ↔ Wasm bridge protocol (Phase 3.6)

| | |
|--|--|
| **Protocol version** | `1` — `inv_protocol_version()` / `HARNESS_PROTOCOL_VERSION` in `lib/harnessBridge.ts` |
| **TS glue** | `lib/harnessBridge.ts` (`HarnessBridge`) |
| **Zig ABI + state** | `src/bridge.zig` (`export fn inv_*`) |
| **Whitelist** | `build.zig` → `export_symbol_names` |
| **Host** | `app/harness/HarnessHost.tsx` |

### Responsibilities

| Side | Owns |
|------|------|
| **JS/TS** | `fetch` to `/api/*`, DOM shell, auth headers later, clipboard, bridge glue |
| **Wasm** | UI frame loop, editor chrome (dvui), local transcript / lifecycle state |
| **Both** | Message protocol: user prompt, assistant text, errors, status |

### Message table

| Direction | Name | Mechanism | Payload |
|-----------|------|-----------|---------|
| both | protocol version | `inv_protocol_version() → u32` | must equal host `HARNESS_PROTOCOL_VERSION` |
| JS → Wasm | ping | `inv_ping(i32) → i32` | returns `x ^ 0xA5A5` (scalar round-trip) |
| JS → Wasm | lifecycle | `inv_set_lifecycle(u8)` | `0` boot · `1` ready · `2` busy · `3` error |
| JS → Wasm | push message | `inv_push_message(kind, ptr, len)` | UTF-8; kind: `1` user · `2` assistant · `3` system · `4` error |
| JS → Wasm | clear | `inv_clear_messages()` | — |
| JS → Wasm | echo set | `inv_echo(ptr, len) → u32` | store UTF-8; returns stored len (capped) |
| JS → Wasm | echo read | `inv_echo_len` / `inv_echo_copy` | JS → Wasm → JS string round-trip |
| Wasm → JS | pending submit | `inv_has_pending_submit` · `inv_pending_submit_*` · `inv_ack_pending_submit` | host **polls** (no custom imports) |
| alloc | linear memory | `gpa_u8` / `gpa_free` / `memory` | UTF-8 buffers for all string traffic |

### Lifecycle enum (`Lifecycle` in TS / Zig)

| Value | Name | Meaning |
|------:|------|---------|
| 0 | boot | Wasm booting / host not ready |
| 1 | ready | Idle, accepting UI / host messages |
| 2 | busy | Inference in flight (3.7+) |
| 3 | error | Hard error surface |

### Round-trip stub (no network)

1. Host loads Wasm via dvui `web.js`.
2. `HarnessBridge.fromInstance(instance)` checks `inv_*` exports.
3. `assertRoundTrip("hello-bridge")` → protocol + ping + echo.
4. Host pushes demo transcript messages; canvas shows them.
5. Canvas button **Queue host submit (stub)** sets pending submit `"bridge-stub"`.
6. Host poll loop calls `takePendingSubmit()` and mirrors a system line into Wasm.

### Extern imports (Wasm → JS via dvui module)

Invincible does **not** add custom `extern "dvui"` imports yet. Wasm→JS uses the **poll queue** above so we keep stock `web.js` from the CI artifact.

Existing dvui imports (used by backend only): `wasm_refresh`, `wasm_console_*`, GL helpers, clipboard, etc. Bridge writes call `wasm_refresh` so the next frame paints new state.

### Source layout

```text
src/main.zig     # dvui_init / deinit / update only
src/ui.zig       # frame: lifecycle + transcript + stub button
src/bridge.zig   # inv_* export fns + ring buffer state
build.zig        # export_symbol_names whitelist for inv_*
```

## Browser requirements

WebAssembly, Canvas, WebGL1/2, `fetch`. Serve over HTTP(S). See [`docs/phase-3-dvui-spike.md`](../../docs/phase-3-dvui-spike.md).

## Known limits

See [`docs/harness-limits.md`](../../docs/harness-limits.md) (load, a11y, dvui/browser).
